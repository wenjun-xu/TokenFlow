import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./support";
import { QueryRunner, verifyIsolation, workerMain, command } from "../src/query";
import { StoreError } from "../src/store";
import { makeServer } from "../src/server";
import { start, stop, control, stateDirectory, readState } from "../src/lifecycle";
import { main, openBrowser } from "../src/cli";
import { systemZone } from "../src/dates";
import { createConnection } from "node:net";

let f: Fixture;
beforeEach(() => { f = new Fixture(); f.session(); f.usage(); });
afterEach(async () => { if (existsSync(f.state)) await stop(f.state); f.close(); });
function bytes() { return Object.fromEntries(readdirSync(f.root).filter(p => statSync(join(f.root, p)).isFile()).map(p => [p, readFileSync(join(f.root, p)).toString("hex")])); }
test("fail closed unsupported sandbox", async () => {
  await expect(verifyIsolation(f.state, "/nonexistent/sandbox-exec")).rejects.toThrow();
});
test("isolated active WAL read; missing sidecars never created", async () => {
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const before = bytes();
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  try {
    expect((await runner.run("dashboard", {})).metrics.calls).toBe("2");
    expect(bytes()).toEqual(before);
    f.connection.close();
    const files = readdirSync(f.root);
    try { expect((await runner.run("dashboard", {})).metrics.calls).toBe("2"); }
    catch (error) { expect(error).toBeInstanceOf(StoreError); }
    expect(readdirSync(f.root)).toEqual(files);
  } finally { await runner.close(); }
});
test("upstream removes shm: correct read or explicit failure, no writes", async () => {
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  try {
    unlinkSync(f.db + "-shm");
    const before = bytes();
    try { expect((await runner.run("dashboard", {})).metrics.calls).toBe("2"); }
    catch (e) { expect(e).toBeInstanceOf(StoreError); }
    expect(bytes()).toEqual(before);
  } finally { await runner.close(); }
});
test("HTTP security whitelist strict params and embedded native UI", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "secret-key");
  const origin = `http://127.0.0.1:${server.port}`;
  const request = (path: string, headers: Record<string, string> = {}, method = "GET") => fetch(origin + path, { headers, method });
  try {
    const shell = await request("/");
    expect(shell.status).toBe(200);
    expect(await shell.text()).not.toContain("secret-key");
    expect(shell.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    for (const headers of [{}, { "X-TokenFlow-Key": "wrong" },
      { "X-TokenFlow-Key": "secret-key", Origin: "https://evil.example" },
      { "X-TokenFlow-Key": "secret-key", "Sec-Fetch-Site": "cross-site" },
      { "X-TokenFlow-Key": "secret-key", Host: "evil.example" }] as Record<string, string>[]) {
      expect((await request("/api/dashboard", headers)).status).toBe(403);
    }
    const good = await request("/api/dashboard", { "X-TokenFlow-Key": "secret-key" });
    expect((await good.json()).metrics.total_tokens).toBe("120");
    expect(good.headers.get("Cache-Control")).toBe("no-store");
    for (const [path, code] of [["/api/stop", 404], ["/api/dashboard?year=2024&month=2&day=30", 400],
      ["/api/dashboard?year=2024&year=2025", 400], ["/api/sessions/missing", 404], ["/source.db", 404],
      ["/app.js?key=x", 400]] as [string, number][]) expect((await request(path, { "X-TokenFlow-Key": "secret-key" })).status).toBe(code);
    expect((await request("/api/stop", {}, "POST")).status).toBe(405);
    expect(await (await request("/app.js")).text()).toContain("sessionStorage");
  } finally { await runner.close(); await server.stop(true); }
});
test("HTML navigation accepts detail, filter, paging and return-list state without bypassing API authentication", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "synthetic-navigation-key");
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const html = await (await fetch(origin + "/")).text();
    const queries = [
      "sid=s&list=",
      "year=2024&month=2&day=29&page=3",
      "sid=s&list=year%3D2024%26month%3D2%26day%3D29%26page%3D3&year=2024&month=2&day=29",
      "sid=s&list=&requestPage=2&turnPage=2&expandedTurn=8",
      "sid=%3Cscript%3E&list=",
    ];
    for (const query of queries) {
      const response = await fetch(origin + "/?" + query);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(await response.text()).toBe(html);
    }
    for (const path of ["/?key=not-a-fragment", "/?unknown=1", "/?sid=s&sid=other",
      "/app.js?sid=s", "/style.css?page=2"]) {
      expect((await fetch(origin + path)).status).toBe(400);
    }
    expect((await fetch(origin + "/api/sessions/s")).status).toBe(403);
    const detail = await fetch(origin + "/api/sessions/s", { headers: { "X-TokenFlow-Key": "synthetic-navigation-key" } });
    expect(detail.status).toBe(200);
    expect((await detail.json()).session.id).toBe("s");
  } finally { await runner.close(); await server.stop(true); }
});
test("authenticated request conversation endpoint stays isolated and session-scoped", async () => {
  f.connection.exec("PRAGMA journal_mode=WAL; UPDATE assistant_usage_events SET turn_index=0");
  f.turn(0, "<script>synthetic dialogue</script>");
  const before = bytes();
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "request-dialog-key");
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const path = "/api/sessions/s/requests/1";
    expect((await fetch(origin + path)).status).toBe(403);
    const headers = { "X-TokenFlow-Key": "request-dialog-key" };
    const response = await fetch(origin + path, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).turns[0].user_message).toContain("synthetic dialogue");
    for (const [suffix, status] of [["?view=invalid", 400], ["?view=all&view=all", 400],
      ["?expandedTurn=999", 404]] as [string, number][]) {
      expect((await fetch(origin + path + suffix, { headers })).status).toBe(status);
    }
    expect((await fetch(origin + "/api/sessions/other/requests/1", { headers })).status).toBe(404);
    expect(bytes()).toEqual(before);
  } finally { await runner.close(); await server.stop(true); }
});
test("background reuse alias different db forged control stop stale pid", async () => {
  f.connection.exec("PRAGMA journal_mode=WAL; UPDATE assistant_usage_events SET duration_ms=1.5,time_to_first_token_ms=12.375");
  const before = bytes();
  const [info, reused] = await start(f.db, f.state);
  expect(reused).toBe(false);
  const response = await fetch(`http://127.0.0.1:${info.port}/api/sessions/s`, {
    headers: { "X-TokenFlow-Key": info.token },
  });
  expect(response.status).toBe(200);
  expect((await response.json()).requests[0]).toMatchObject({ duration_ms: 1.5, time_to_first_token_ms: 12.375 });
  expect(bytes()).toEqual(before);
  const [same, again] = await start(f.db, f.state);
  expect(again).toBe(true); expect(same.identity).toBe(info.identity);
  const alias = join(f.root, "alias"); symlinkSync(f.db, alias);
  expect((await start(alias, f.state))[1]).toBe(true);
  await expect(control(f.state, { ...info, identity: "forged" }, "stop")).rejects.toThrow();
  const other = join(f.root, "other.db"); writeFileSync(other, readFileSync(f.db));
  await expect(start(other, f.state)).rejects.toThrow();
  expect(await stop(f.state)).toBe(true);
  expect(await stop(f.state)).toBe(false);
  await expect(fetch(`http://127.0.0.1:${info.port}`)).rejects.toThrow();
  writeFileSync(join(f.state, "state.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  writeFileSync(join(f.state, "state.new"), "synthetic-abandoned-staging", { mode: 0o600 });
  expect(await stop(f.state)).toBe(false);
  expect(existsSync(join(f.state, "state.new"))).toBe(false);
  process.kill(process.pid, 0);
});
test("CLI help/version no source or state access", async () => {
  for (const arg of ["--help", "--version"]) {
    const p = Bun.spawn(command(arg), { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: f.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    expect(await p.exited).toBe(0);
    const text = await new Response(p.stdout).text();
    expect(text).toContain(arg === "--version" ? "0.2.2" : "start");
    expect(existsSync(join(f.root, "Library"))).toBe(false);
  }
});
test("source deletion after readiness HTTP503", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "synthetic-key");
  try {
    unlinkSync(f.db);
    await expect(runner.run("dashboard", {})).rejects.toThrow("源数据库");
    const r = await fetch(`http://127.0.0.1:${server.port}/api/dashboard`, { headers: { "X-TokenFlow-Key": "synthetic-key" } });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("源数据库");
  } finally { await runner.close(); await server.stop(true); }
});
test("browser failure keeps healthy service and manual URL", async () => {
  const output: string[] = [], errors: string[] = [];
  expect(await main(["start", "--db", f.db], { state: f.state, out: s => output.push(s), err: s => errors.push(s), open: async () => false })).toBe(0);
  expect(output.join("\n")).toContain("#key=");
  expect(errors.join("\n")).toContain("服务仍在运行");
  expect((await control(f.state, readState(f.state), "status")).ok).toBe(true);
});
test("browser launcher uses private stdin, never credentials in command arguments", async () => {
  const calls: any[] = [], writes: string[] = [];
  const mock = spyOn(Bun, "spawn").mockImplementation(((args: any, options: any) => {
    calls.push({ args, options });
    return { stdin: { write: (s: string) => writes.push(s), end() {} }, exited: Promise.resolve(0), exitCode: 0 };
  }) as any);
  try {
    const url = "http://127.0.0.1:12345/#key=synthetic-credential";
    expect(await openBrowser(url)).toBe(true);
    expect(calls[0].args).toEqual(["/usr/bin/osascript", "-"]);
    expect(JSON.stringify(calls[0])).not.toContain("synthetic-credential");
    expect(writes[0]).toBe('open location "' + url + '"\n');
    expect(await openBrowser('http://127.0.0.1:12345/#key="injection')).toBe(false);
    expect(calls.length).toBe(1);
  } finally { mock.mockRestore(); }
});
test("state security missing source source inside state parent symlink", async () => {
  const missing = join(f.root, "missing.db");
  await expect(start(missing, f.state)).rejects.toThrow();
  expect(existsSync(missing)).toBe(false);
  const inside = join(f.state, "source.db"); writeFileSync(inside, readFileSync(f.db));
  await expect(start(inside, f.state)).rejects.toThrow();
  const alias = join(f.root, "state-link"); symlinkSync(f.state, alias);
  expect(() => stateDirectory(alias)).toThrow();
  chmodSync(f.state, 0o755);
  expect(() => stateDirectory(f.state)).toThrow();
  chmodSync(f.state, 0o700);
});
test("simultaneous start server-owned shared flock single instance private files", async () => {
  const results = await Promise.all([start(f.db, f.state), start(f.db, f.state)]);
  expect(results[0][0].identity).toBe(results[1][0].identity);
  expect(results.map(r => r[1]).sort()).toEqual([false, true]);
  for (const name of ["lock", "state.json", "service.log", "c"]) expect(statSync(join(f.state, name)).mode & 0o777).toBe(0o600);
});
test("start during verified stop waits for lock release and starts a new instance", async () => {
  const [old] = await start(f.db, f.state);
  const stopping = control(f.state, old, "stop");
  const starting = start(f.db, f.state, 2);
  await stopping;
  const [fresh] = await starting;
  expect(fresh.identity).not.toBe(old.identity);
  expect((await control(f.state, fresh, "status")).ok).toBe(true);
});
test("raw duplicate security headers and nonempty read bodies are rejected", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "synthetic-key");
  async function raw(extra: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port: server.port! });
      let output = "";
      socket.on("error", reject);
      socket.setTimeout(2000, () => { socket.destroy(); reject(Error("raw HTTP timeout")); });
      socket.on("connect", () => socket.write(`GET /api/dashboard HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-TokenFlow-Key: synthetic-key\r\nConnection: close\r\n${extra}\r\n`));
      socket.on("data", chunk => { output += chunk.toString(); });
      socket.on("end", () => { socket.destroy(); resolve(Number(output.split(" ")[1])); });
    });
  }
  try {
    for (const extra of [`Host: 127.0.0.1:${server.port}\r\n`, "X-TokenFlow-Key: synthetic-key\r\n",
      `Origin: http://127.0.0.1:${server.port}\r\nOrigin: http://127.0.0.1:${server.port}\r\n`,
      "Sec-Fetch-Site: same-origin\r\nSec-Fetch-Site: cross-site\r\n", "Content-Length: 1\r\n\r\nx"]) {
      expect(await raw(extra)).toBeGreaterThanOrEqual(400);
    }
  } finally { await runner.close(); await server.stop(true); }
});
test("service survives starting Bun process exit", async () => {
  const script = `import { main } from ${JSON.stringify(join(import.meta.dir, "../src/cli.ts"))};
    process.exitCode = await main(["start","--db",${JSON.stringify(f.db)},"--no-browser"],{state:${JSON.stringify(f.state)}});`;
  const p = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(await p.exited).toBe(0);
  const text = await new Response(p.stdout).text();
  const url = new URL(text.split("\n").find(s => s.startsWith("http:"))!);
  const token = new URLSearchParams(url.hash.slice(1)).get("key")!;
  const state = f.state;
  try {
    const r = await fetch(url.origin + "/api/dashboard", { headers: { "X-TokenFlow-Key": token } });
    expect((await r.json()).metrics.total_tokens).toBe("120");
    expect(await stop(state)).toBe(true);
  } finally { await stop(state); }
});
test("failed readiness cleans only owned resources", async () => {
  f.connection.close(); writeFileSync(f.db, "corrupt");
  await expect(start(f.db, f.state)).rejects.toThrow();
  expect(existsSync(join(f.state, "state.json"))).toBe(false);
  expect(existsSync(join(f.state, "c"))).toBe(false);
  expect(await stop(f.state)).toBe(false);
});
test("private stop/status responsive during query", async () => {
  const tx = f.connection.transaction(() => { for (let i = 0; i < 10000; i++) f.usage(); }); tx();
  const before = readFileSync(f.db);
  const [info] = await start(f.db, f.state);
  const querying = fetch(`http://127.0.0.1:${info.port}/api/dashboard`, { headers: { "X-TokenFlow-Key": info.token } }).catch(() => null);
  let busy = false;
  for (let i = 0; i < 100; i++) {
    if ((await control(f.state, info, "status")).busy) { busy = true; break; }
    await Bun.sleep(5);
  }
  expect(busy).toBe(true);
  const started = performance.now();
  expect(await stop(f.state)).toBe(true);
  expect(performance.now() - started).toBeLessThan(3000);
  await querying;
  expect(readFileSync(f.db)).toEqual(before);
});
test("whole-task timeout, bounded queue, cancellation of only owned children", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC", 0.05);
  try {
    runner.workerCommand = () => [process.execPath, "-e", "await Bun.sleep(30000)"];
    const started = performance.now();
    await expect(runner.run("dashboard", {})).rejects.toThrow("完整读取任务超时");
    expect(performance.now() - started).toBeLessThan(3000);
    expect(runner.busy).toBe(false);
  } finally { await runner.close(); }
  const second = await QueryRunner.create(f.db, f.state, "UTC", 20);
  second.workerCommand = () => [process.execPath, "-e", "await Bun.sleep(30000)"];
  const errors: unknown[] = [];
  const task = second.run("dashboard", {}).catch(e => errors.push(e));
  await Bun.sleep(100);
  await expect(second.run("dashboard", {})).rejects.toThrow("繁忙");
  await second.close(); await task;
  expect(errors.length).toBe(1); expect(second.busy).toBe(false);
  f.connection.exec("BEGIN EXCLUSIVE; ROLLBACK");
});
test("source replacement and sidecar symlink fail", async () => {
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  try {
    const replacement = join(f.root, "replacement"); writeFileSync(replacement, readFileSync(f.db)); renameSync(replacement, f.db);
    await expect(runner.run("dashboard", {})).rejects.toThrow("替换");
  } finally { await runner.close(); }
  symlinkSync(join(f.root, "not-wal"), f.db + "-wal");
  await expect(QueryRunner.create(f.db, f.state, "UTC")).rejects.toThrow("sidecar");
});
test("internal query directly refuses isolation before source reads", async () => {
  const before = readFileSync(f.db);
  const p = Bun.spawn(command("_query"), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(JSON.stringify({ state: f.state, db: f.db })); p.stdin.end();
  expect(await p.exited).toBe(0);
  expect(JSON.parse(await new Response(p.stdout).text()).error).toContain("拒绝打开源库");
  expect(readFileSync(f.db)).toEqual(before);
  expect(readdirSync(f.state)).toEqual([]);
});
test("frozen explicit zone passed privately despite mismatching TZ environment", async () => {
  f.connection.exec("DELETE FROM assistant_usage_events");
  f.usage({ created_at: "2024-12-31T16:00:00Z" });
  const old = process.env.TZ;
  process.env.TZ = "Pacific/Honolulu";
  try {
    const runner = await QueryRunner.create(f.db, f.state, "Asia/Shanghai");
    try {
      expect((await runner.run("dashboard", { year: "2025", month: "1", day: "1" })).metrics.calls).toBe("1");
      expect((await runner.run("dashboard", {})).timezone).toBe("Asia/Shanghai");
    } finally { await runner.close(); }
    const [first] = await start(f.db, f.state);
    const result = await fetch(`http://127.0.0.1:${first.port}/api/dashboard`, { headers: { "X-TokenFlow-Key": first.token } });
    expect((await result.json()).timezone).toBe(systemZone());
    await stop(f.state);
    const [second] = await start(f.db, f.state);
    expect(second.identity).not.toBe(first.identity);
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
