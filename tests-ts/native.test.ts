import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, copyFileSync, chmodSync, existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./support";
import { stop, readState } from "../src/lifecycle";

test("native compile and standalone entry/resources with no external runtime", async () => {
  const f = new Fixture();
  try {
    const binary = join(f.root, "tokenflow");
    const p = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-darwin-arm64",
      `--compile-executable-path=${process.execPath}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
      join(import.meta.dir, "../src/cli.ts"), "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(p.stdout).text(), stderr = await new Response(p.stderr).text();
    expect(await p.exited, stdout + stderr).toBe(0);
    const outside = join(f.root, "outside"); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, ".env"), "TOKENFLOW_AMBIENT_CONFIG_SENTINEL=poison\n");
    writeFileSync(join(outside, "bunfig.toml"), 'preload = ["./ambient-preload.ts"]\n');
    writeFileSync(join(outside, "ambient-preload.ts"), 'throw new Error("ambient project configuration loaded");\n');
    const copied = join(outside, "tokenflow"); copyFileSync(binary, copied); chmodSync(copied, 0o755);
    const env = { PATH: "/usr/bin:/bin", HOME: f.root };
    for (const arg of ["--version", "--help"]) {
      const cli = Bun.spawn([copied, arg], { cwd: outside, env, stdout: "pipe", stderr: "pipe" });
      expect(await cli.exited).toBe(0);
      expect(await new Response(cli.stdout).text()).toContain(arg === "--version" ? "0.2.2" : "start");
    }
    expect(existsSync(join(f.root, "Library"))).toBe(false);
    const worker = Bun.spawn([copied, "_query"], { cwd: outside, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    worker.stdin.write(JSON.stringify({ state: f.state, db: join(f.root, "missing.db") })); worker.stdin.end();
    expect(await worker.exited).toBe(0);
    expect(JSON.parse(await new Response(worker.stdout).text()).error).toContain("拒绝打开源库");
    expect(existsSync(join(f.root, "missing.db"))).toBe(false);
    console.log("native production compile passed: bun build --compile --target=bun-darwin-arm64 src/cli.ts; outside source PATH=/usr/bin:/bin");
  } finally { f.close(); }
}, 120000);
test("compiled native start query stop, embedding, WAL, reuse, restart and deletion503", async () => {
  const f = new Fixture(); f.session(); f.usage({ duration_ms: 1.5, time_to_first_token_ms: 12.375, turn_index: 0 }); f.turn(0);
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const native = join(f.root, "tokenflow-test");
  const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-darwin-arm64",
    `--compile-executable-path=${process.execPath}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    join(import.meta.dir, "native-harness.ts"), "--outfile", native], { stdout: "pipe", stderr: "pipe" });
  const errors = await new Response(build.stderr).text();
  expect(await build.exited, errors).toBe(0);
  const outside = join(f.root, "outside"); mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, ".env"), "TOKENFLOW_AMBIENT_CONFIG_SENTINEL=poison\n");
  writeFileSync(join(outside, "bunfig.toml"), 'preload = ["./ambient-preload.ts"]\n');
  writeFileSync(join(outside, "ambient-preload.ts"), 'throw new Error("ambient project configuration loaded");\n');
  const executable = join(outside, "tokenflow"); copyFileSync(native, executable); chmodSync(executable, 0o755);
  const env = { PATH: "/usr/bin:/bin", HOME: f.root };
  async function cli(args: string[]) {
    const p = Bun.spawn([executable, ...args], { cwd: outside, env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(), err = await new Response(p.stderr).text();
    return { exit: await p.exited, out, err };
  }
  try {
    const ambient = await cli(["_test-env"]);
    expect(ambient.exit, ambient.err).toBe(0);
    expect(ambient.out.trim()).toBe("unloaded");
    const missing = join(f.root, "missing.db");
    expect((await cli(["_test-start", missing, f.state])).exit).toBe(1);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(f.state, "state.json"))).toBe(false);
    const before = readFileSync(f.db);
    const wal = readFileSync(f.db + "-wal"), shm = readFileSync(f.db + "-shm");
    const started = await cli(["_test-start", f.db, f.state]);
    expect(started.exit, started.err).toBe(0);
    const info = readState(f.state);
    const origin = `http://127.0.0.1:${info.port}`, headers = { "X-TokenFlow-Key": info.token };
    const detailPage = await fetch(origin + "/?sid=s&list=year%3D2024%26page%3D3&requestPage=2&turnPage=2&expandedTurn=1");
    expect(detailPage.status).toBe(200);
    expect(detailPage.headers.get("Content-Type")).toContain("text/html");
    expect((await (await fetch(origin + "/api/dashboard", { headers })).json()).metrics.calls).toBe("2");
    const detail = await (await fetch(origin + "/api/sessions/s", { headers })).json();
    expect(detail.requests.map((row: { id: string }) => row.id)).toEqual(["2", "1"]);
    expect(detail.requests[1].created_at_display).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(detail.requests[1])
      .toMatchObject({ duration_ms: 1.5, time_to_first_token_ms: 12.375 });
    const conversation = await fetch(origin + "/api/sessions/s/requests/1", { headers });
    expect(conversation.status).toBe(200);
    expect((await conversation.json()).association).toBe("matched");
    expect(await (await fetch(origin + "/app.js")).text()).toBe(readFileSync(join(import.meta.dir, "../web/app.js"), "utf8"));
    expect(await (await fetch(origin + "/style.css")).text()).toBe(readFileSync(join(import.meta.dir, "../web/style.css"), "utf8"));
    expect(readFileSync(f.db)).toEqual(before); expect(readFileSync(f.db + "-wal")).toEqual(wal); expect(readFileSync(f.db + "-shm")).toEqual(shm);
    expect((await cli(["_test-start", f.db, f.state])).out).toContain("复用");
    expect((await cli(["_test-stop", f.state])).exit).toBe(0);
    await expect(fetch(origin)).rejects.toThrow();
    expect((await cli(["_test-start", f.db, f.state])).exit).toBe(0);
    const second = readState(f.state);
    expect(second.identity).not.toBe(info.identity);
    unlinkSync(f.db);
    const r = await fetch(`http://127.0.0.1:${second.port}/api/dashboard`, { headers: { "X-TokenFlow-Key": second.token } });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("源数据库");
    expect((await cli(["_test-stop", f.state])).exit).toBe(0);
    expect((await cli(["_test-stop", f.state])).out).toContain("未运行");
    expect(readdirSync(outside).sort()).toEqual([".env", "ambient-preload.ts", "bunfig.toml", "tokenflow"]);
    console.log("native isolated harness passed: real compiled CLI/runtime, separate cwd, PATH=/usr/bin:/bin, active WAL unchanged, restart, source deletion503, verified stop");
  } finally { await stop(f.state); f.close(); }
}, 120000);
