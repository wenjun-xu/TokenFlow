import { expect, test } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./support";
import { start, stop, control, readState } from "../src/lifecycle";

async function simulator(f: Fixture, mode: string) {
  const p = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null",
    join(import.meta.dir, "legacy-simulator.ts"), f.state, f.db, mode], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  const reader = p.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("ready");
  reader.releaseLock();
  return p;
}
test("occupied legacy flock cannot coexist, overwrite state, or signal stale PID", async () => {
  const f = new Fixture(); f.session(); f.usage();
  const legacy = await simulator(f, "hold");
  try {
    await expect(start(f.db, f.state, 0.3)).rejects.toThrow("using a stale PID");
    expect(existsSync(join(f.state, "c"))).toBe(false);
    expect(existsSync(join(f.state, "state.json"))).toBe(false);
    expect(existsSync(join(f.state, "service.log"))).toBe(false);
    writeFileSync(join(f.state, "state.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    await expect(stop(f.state)).rejects.toThrow();
    process.kill(process.pid, 0);
    expect(legacy.exitCode).toBeNull();
  } finally { legacy.kill("SIGTERM"); await legacy.exited; await stop(f.state); f.close(); }
});
test("TS start safely reuses and TS stop verifies legacy-compatible private protocol", async () => {
  const f = new Fixture(); f.session(); f.usage();
  const legacy = await simulator(f, "serve");
  try {
    const before = readFileSync(join(f.state, "state.json"));
    const [info, reused] = await start(f.db, f.state);
    expect(reused).toBe(true);
    expect(info.pid).toBe(legacy.pid);
    expect(readFileSync(join(f.state, "state.json"))).toEqual(before);
    expect((await control(f.state, readState(f.state), "status")).ok).toBe(true);
    expect(await stop(f.state)).toBe(true);
    expect(await legacy.exited).toBe(0);
    await expect(fetch(`http://127.0.0.1:${info.port}`)).rejects.toThrow();
  } finally {
    if (legacy.exitCode === null) { legacy.kill("SIGTERM"); await legacy.exited; }
    await stop(f.state); f.close();
  }
});
