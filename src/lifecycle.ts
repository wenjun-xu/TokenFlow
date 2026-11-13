import { createConnection, createServer, type Server as NetServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, chmodSync, ftruncateSync, writeSync, fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { QueryRunner, command, validateSource, fileIdentity } from "./query";
import { StoreError } from "./store";
import { makeServer, sameSecret } from "./server";
import { stateDirectory, defaultState, defaultDB, openPrivate, checkFile, lock, tryLock, readState, cleanup, type Info } from "./private";

export { stateDirectory, readState };
export async function control(state: string, info: Info, action: "status" | "stop"): Promise<{ ok: true; identity: string; busy: boolean; stopping?: boolean }> {
  checkFile(join(state, "c"), true);
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ path: join(state, "c"), allowHalfOpen: true });
    let data = "";
    const fail = () => { socket.destroy(); reject(Error("The instance lock is held, but the private control channel could not be verified; no stale PID was acted on")); };
    socket.setTimeout(2000, fail);
    socket.on("error", fail);
    socket.on("connect", () => socket.end(JSON.stringify({ identity: info.identity, command: action }) + "\n"));
    socket.on("data", chunk => { data += chunk.toString("utf8"); if (Buffer.byteLength(data) > 8192) fail(); });
    socket.on("end", () => {
      socket.destroy();
      try {
        const reply = JSON.parse(data);
        if (reply.ok !== true || reply.identity !== info.identity) { fail(); return; }
        resolve(reply);
      } catch { fail(); }
    });
  });
}
async function httpReady(info: Info): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/`, { signal: AbortSignal.timeout(2000) });
    await r.arrayBuffer();
    return r.status === 200;
  } catch { return false; }
}
async function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
async function terminateOwned(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => { timeout = setTimeout(resolve, 1000); })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolve => child.once("exit", resolve));
    }
  } finally { clearTimeout(timeout); }
}
export async function start(db = defaultDB(), inputState = defaultState(), timeout = 25): Promise<[Info, boolean]> {
  const state = stateDirectory(inputState);
  db = validateSource(db, state);
  const identity = fileIdentity(db);
  const initial = lock(state);
  const occupied = !initial.acquired;
  closeSync(initial.fd);
  let child: ChildProcess | undefined;
  let childOutput = "", startupError: string | undefined;
  const launch = () => {
    childOutput = ""; startupError = undefined;
    const [program, ...args] = command("_serve");
    child = spawn(program, args, { detached: true, stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    child.on("error", () => { startupError = "Could not start the background service; check the installation"; });
    child.stdout!.on("data", chunk => {
      childOutput += chunk.toString("utf8");
      if (Buffer.byteLength(childOutput) > 8192) { startupError = "Invalid background service readiness result"; return; }
      if (childOutput.includes("\n")) {
        try { const result = JSON.parse(childOutput.trim()); if (result.error) startupError = result.error; }
        catch { startupError = "Invalid background service readiness result"; }
      }
    });
    child.stdin!.on("error", () => { startupError ??= "The background service startup pipe failed"; });
    child.stdin!.end(JSON.stringify({ db, state }));
    child.unref();
  };
  if (!occupied) launch();
  const deadline = performance.now() + timeout * 1000;
  try {
    while (performance.now() < deadline) {
      let info: Info | undefined;
      try {
        info = readState(state);
        if ((await control(state, info, "status")).stopping) info = undefined;
      } catch { info = undefined; }
      if (info) {
        if (info.db !== db || JSON.stringify(info.file_identity) !== JSON.stringify(identity)) {
          throw Error("The running instance uses another database or its source file was replaced; run tokenflow stop first");
        }
        if (await httpReady(info)) {
          child?.stdout?.destroy();
          child?.stdin?.destroy();
          return [info, info.pid !== child?.pid];
        }
      }
      if (startupError) throw Error(startupError);
      if (child && child.exitCode !== null && child.exitCode !== 0 && child.exitCode !== 2) {
        throw Error("The background service failed to start; check macOS isolation support and the data source");
      }
      if (!info && (!child || child.exitCode === 0 || child.exitCode === 2)) {
        const next = lock(state);
        closeSync(next.fd);
        if (next.acquired) launch();
      }
      await Bun.sleep(50);
    }
    throw Error("Background service startup timed out; the instance is not ready or the control channel failed; no process was terminated using a stale PID");
  } catch (error) {
    if (child) await terminateOwned(child);
    throw error;
  } finally { child?.stdout?.destroy(); child?.stdin?.destroy(); }
}
export async function stop(inputState = defaultState()): Promise<boolean> {
  const state = stateDirectory(inputState);
  const owned = lock(state);
  try {
    if (owned.acquired) { cleanup(state); return false; }
    const info = readState(state);
    await control(state, info, "stop");
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      if (tryLock(owned.fd)) {
        cleanup(state);
        if (await portOpen(info.port)) throw Error("The instance lock was released, but the service port is still reachable; shutdown is not confirmed");
        return true;
      }
      await Bun.sleep(25);
    }
    throw Error("TokenFlow shutdown timed out; no signal was sent using a stale PID; try again later");
  } finally { closeSync(owned.fd); }
}
export async function serviceMain(): Promise<number> {
  let state: string | undefined, fd: number | undefined, log: number | undefined;
  let runner: QueryRunner | undefined, http: ReturnType<typeof makeServer> | undefined, controller: NetServer | undefined;
  let cleaned = false, ready = false;
  let stopRequested: (() => void) | undefined;
  const onSignal = () => stopRequested?.();
  try {
    const raw = await Bun.stdin.text();
    if (Buffer.byteLength(raw) > 16384) throw new StoreError("Startup parameters are too long");
    const request = JSON.parse(raw);
    if (typeof request.db !== "string" || typeof request.state !== "string") throw new StoreError("Invalid startup parameters");
    state = stateDirectory(request.state);
    const owned = lock(state);
    fd = owned.fd;
    if (!owned.acquired) { console.log('{"lost":true}'); return 2; }
    cleanup(state); cleaned = true;
    log = openPrivate(join(state, "service.log"));
    ftruncateSync(log, 0);
    runner = await QueryRunner.create(request.db, state);
    await runner.run("dashboard", {});
    const identity = randomBytes(32).toString("base64url"), token = randomBytes(32).toString("base64url");
    http = makeServer(runner, token);
    const stopping = new Promise<void>(resolve => { stopRequested = resolve; });
    const statePath = state;
    const activeRunner = runner;
    let isStopping = false;
    controller = createServer({ allowHalfOpen: true }, socket => {
      let raw = "";
      socket.setTimeout(1000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("data", chunk => { raw += chunk.toString("utf8"); if (Buffer.byteLength(raw) > 4096) socket.destroy(); });
      socket.on("end", () => {
        let request;
        try { request = JSON.parse(raw); } catch { socket.destroy(); return; }
        if (!request || !sameSecret(typeof request.identity === "string" ? request.identity : null, identity)
          || !["status", "stop"].includes(request.command)) { socket.destroy(); return; }
        if (request.command === "stop") isStopping = true;
        socket.end(JSON.stringify({ ok: true, identity, busy: activeRunner.busy, stopping: isStopping }), () => {
          if (request.command === "stop") stopRequested?.();
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      controller!.once("error", reject);
      controller!.listen(join(statePath, "c"), () => { controller!.off("error", reject); resolve(); });
    });
    controller.on("error", () => { if (log !== undefined) writeSync(log, "CONTROL_FAILED\n"); stopRequested?.(); });
    chmodSync(join(state, "c"), 0o600);
    const info: Info = { identity, token, db: runner.db, file_identity: runner.file_identity, port: http.port!, pid: process.pid };
    const staging = join(state, "state.new"), stagingFD = openPrivate(staging);
    try { ftruncateSync(stagingFD, 0); writeSync(stagingFD, JSON.stringify(info)); fsyncSync(stagingFD); }
    finally { closeSync(stagingFD); }
    checkFile(join(state, "state.json"));
    renameSync(staging, join(state, "state.json"));
    process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
    ready = true;
    console.log('{"ok":true}');
    await stopping;
    return 0;
  } catch (error) {
    if (log !== undefined) writeSync(log, "STARTUP_FAILED\n");
    if (!ready) console.log(JSON.stringify({ error: error instanceof StoreError ? error.message : "The background service failed to start; check the installation, state directory, and isolation support" }));
    return 1;
  } finally {
    process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
    await runner?.close();
    await http?.stop(true);
    if (controller?.listening) await new Promise<void>(resolve => controller!.close(() => resolve()));
    if (cleaned && state) cleanup(state);
    if (log !== undefined) closeSync(log);
    if (fd !== undefined) closeSync(fd);
  }
}
