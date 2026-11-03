import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Fixture } from "./support";
import { fileIdentity, PROFILE } from "../src/query";
import { readState, stop } from "../src/lifecycle";

const project = resolve(import.meta.dir, "..");
const tools = basename(dirname(project)) === ".publish" ? dirname(project) : join(project, ".publish");
const binary = join(tools, "native-x64/tokenflow");
const x64Runtime = join(tools, "tools/bun-x64/node_modules/@oven/bun-darwin-x64/bin/bun");
test.skipIf(!existsSync(binary))("Rosetta x64 native isolated query reads synthetic active WAL", async () => {
  const f = new Fixture(); f.session(); f.usage();
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const before = ["", "-wal", "-shm"].map(s => readFileSync(f.db + s));
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", PROFILE, binary, "_query"], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...process.env, BUN_JSC_useJIT: "0" },
  });
  try {
    child.stdin.write(JSON.stringify({ db: f.db, state: f.state, zone: "Asia/Shanghai",
      args: {}, operation: "dashboard", timeout: 14, file_identity: fileIdentity(f.db) }));
    child.stdin.end();
    const exit = await Promise.race([child.exited, Bun.sleep(5000).then(() => -1)]);
    expect(exit).toBe(0);
    const output = await Promise.race([new Response(child.stdout).text(), Bun.sleep(1000).then(() => "")]);
    expect(JSON.parse(output).data.metrics.total_tokens).toBe("240");
    expect(["", "-wal", "-shm"].map(s => readFileSync(f.db + s))).toEqual(before);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([child.exited, Bun.sleep(500)]);
      child.unref();
    }
    f.close();
  }
}, 10000);

test.skipIf(!existsSync(x64Runtime))("Rosetta compiled service self-query disables JIT without weakening Seatbelt", async () => {
  const f = new Fixture(); f.session(); f.usage();
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const before = ["", "-wal", "-shm"].map(s => readFileSync(f.db + s));
  const executable = resolve(f.root, "tokenflow-x64");
  const build = Bun.spawn([process.execPath, "build", "--compile", "--target=bun-darwin-x64",
    `--compile-executable-path=${x64Runtime}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
    resolve(import.meta.dir, "native-harness.ts"), "--outfile", executable], { stdout: "ignore", stderr: "ignore" });
  expect(await build.exited).toBe(0);
  const outside = resolve(f.root, "outside"); mkdirSync(outside);
  async function cli(args: string[]) {
    const child = Bun.spawn([executable, ...args], { cwd: outside,
      env: { PATH: "/usr/bin:/bin", HOME: f.root }, stdout: "pipe", stderr: "ignore" });
    const exit = await Promise.race([child.exited, Bun.sleep(10000).then(() => -1)]);
    if (exit === -1) { child.kill("SIGKILL"); child.unref(); }
    const out = exit === 0 ? await new Response(child.stdout).text() : "";
    return { exit, out };
  }
  try {
    const started = await cli(["_test-start", f.db, f.state]);
    expect(started.exit).toBe(0);
    const info = readState(f.state);
    const response = await fetch(`http://127.0.0.1:${info.port}/api/dashboard`,
      { headers: { "X-TokenFlow-Key": info.token }, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect((await response.json()).metrics.total_tokens).toBe("240");
    expect(["", "-wal", "-shm"].map(s => readFileSync(f.db + s))).toEqual(before);
    expect((await cli(["_test-stop", f.state])).exit).toBe(0);
  } finally { await stop(f.state); f.close(); }
}, 20000);
