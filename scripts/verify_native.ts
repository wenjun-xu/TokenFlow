import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Fixture } from "../tests-ts/support";

const project = resolve(import.meta.dir, "..");
const workspace = basename(dirname(project)) === ".publish" ? resolve(project, "../..") : project;
const home = join(workspace, ".h");
if (Buffer.byteLength(join(home, "Library/Application Support/TokenFlow/c")) >= 104) {
  throw new Error("Synthetic HOME exceeds the macOS socket path limit");
}
const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/verify_native.ts /path/to/extracted/tokenflow");
mkdirSync(home, { mode: 0o700 });
const fixture = new Fixture();
const env = { PATH: "/usr/bin:/bin", HOME: home };
async function cli(args: string[]) {
  const process = Bun.spawn([binary, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { out, err, code };
}
try {
  fixture.session();
  fixture.usage({ duration_ms: 1.5, time_to_first_token_ms: 12.375 });
  fixture.connection.exec("PRAGMA journal_mode=WAL");
  fixture.usage();
  const before = ["", "-wal", "-shm"].map(suffix => readFileSync(fixture.db + suffix));
  assert.equal((await cli(["--version"])).out.trim(), "0.2.1");
  const missing = await cli(["start", "--db", join(home, "missing.db"), "--no-browser"]);
  assert.equal(missing.code, 1);
  const started = await cli(["start", "--db", fixture.db, "--no-browser"]);
  assert.equal(started.code, 0, started.err);
  const info = JSON.parse(readFileSync(join(home, "Library/Application Support/TokenFlow/state.json"), "utf8")) as { port: number; token: string };
  const origin = `http://127.0.0.1:${info.port}`;
  const headers = { "X-TokenFlow-Key": info.token };
  const response = await fetch(origin + "/api/dashboard", { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as { metrics: { total_tokens: string; calls: string } };
  assert.equal(data.metrics.total_tokens, "240");
  assert.equal(data.metrics.calls, "2");
  const detail = await (await fetch(origin + "/api/sessions/s", { headers })).json() as {
    requests: Array<{ duration_ms: number | string | null; time_to_first_token_ms: number | string | null }>;
  };
  assert.equal(detail.requests[0]?.duration_ms, 1.5);
  assert.equal(detail.requests[0]?.time_to_first_token_ms, 12.375);
  assert.equal(await (await fetch(origin + "/app.js")).text(), readFileSync(join(import.meta.dir, "../web/app.js"), "utf8"));
  assert.equal((await fetch(origin + "/api/dashboard")).status, 403);
  for (const [index, suffix] of ["", "-wal", "-shm"].entries()) {
    assert.deepEqual(readFileSync(fixture.db + suffix), before[index]);
  }
  assert.match((await cli(["start", "--db", fixture.db, "--no-browser"])).out, /复用/);
  assert.equal((await cli(["stop"])).code, 0);
  await assert.rejects(fetch(origin));
  assert.match((await cli(["stop"])).out, /未运行/);
  console.log("Public native CLI passed: no runtime on PATH, active WAL unchanged, total=240, embedded UI, authentication, reuse and verified stop.");
} finally {
  const stopped = await cli(["stop"]);
  if (stopped.code !== 0) throw new Error("Synthetic native service could not be stopped; preserving test HOME");
  fixture.close();
  rmSync(home, { recursive: true });
}
