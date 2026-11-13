import { Database } from "bun:sqlite";
import { constants, statSync, lstatSync, realpathSync, openSync, closeSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { resolve, join, relative, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { Store, StoreError } from "./store";
import { systemZone, zoneFormatter, type Args } from "./dates";
import { stateDirectory, openPrivate } from "./private";
import { toolActivity } from "./tools";
import { singleCall, roundActivities } from "./calls";

export const SANDBOX = "/usr/bin/sandbox-exec";
export const PROFILE = "(version 1)(allow default)(deny file-write*)";
export function command(...args: string[]): string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath, ...args]
    : [process.execPath, "--no-env-file", "--config=/dev/null", resolve(import.meta.dir, "cli.ts"), ...args];
}
export function fileIdentity(path: string): [number, number] {
  const st = statSync(path, { bigint: true });
  const values = [Number(st.dev), Number(st.ino)];
  if (values.some(v => !Number.isSafeInteger(v))) throw new StoreError("Source database file identity exceeds platform limits");
  return values as [number, number];
}
export function validateSource(input: string, state: string): string {
  const original = resolve(input.startsWith("~/") ? join(process.env.HOME ?? "", input.slice(2)) : input);
  let path: string;
  try {
    const originalStat = lstatSync(original);
    if (originalStat.isSymbolicLink() && originalStat.uid !== process.getuid!()) throw new StoreError("The database symlink must be owned by the current user");
    path = realpathSync(original);
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.uid !== process.getuid!() || !(metadata.mode & 0o444)) throw new StoreError("The database must be a readable regular file owned by the current user");
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("The source database is missing or inaccessible; use --db to specify an existing database");
  }
  const rel = relative(state, path);
  if (rel === "" || (!rel.startsWith(".." + "/") && rel !== ".." && !rel.startsWith("/"))) throw new StoreError("The source database cannot be inside the TokenFlow state directory");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { if (lstatSync(path + suffix).isSymbolicLink()) throw new StoreError("Database sidecar files cannot be symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return path;
}
type Child = ReturnType<typeof Bun.spawn>;
async function terminate(child: Child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([child.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  } finally { clearTimeout(timer); }
}
async function bounded<T>(child: Child, work: Promise<T>, seconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreError("The complete read operation timed out (including aggregation and sorting); narrow the range and try again")), seconds * 1000);
    })]);
  } catch (error) { await terminate(child); throw error; }
  finally { clearTimeout(timer); }
}
export function assertIsolated(state: string) {
  const probe = join(state, "worker-probe-" + randomBytes(12).toString("hex"));
  let fd: number;
  try { fd = openSync(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw new StoreError("File-write isolation could not be verified; opening the source database was refused");
  }
  closeSync(fd); unlinkSync(probe);
  throw new StoreError("The internal reader is not protected by file-write isolation; opening the source database was refused");
}
export async function verifyIsolation(state: string, sandbox = SANDBOX) {
  if (process.platform !== "darwin") throw new StoreError("macOS sandbox-exec file isolation is required; reading the source database was refused");
  const probe = join(state, "isolation-probe.db"), forbidden = join(state, "isolation-forbidden");
  for (const file of [probe, probe + "-wal", probe + "-shm", forbidden, forbidden + "-create"]) {
    try { lstatSync(file); throw new StoreError("Stale isolation probe state remains; check the state directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  let db: Database | undefined;
  try {
    const fd = openPrivate(forbidden);
    try { writeSync(fd, "sentinel"); } finally { closeSync(fd); }
    db = new Database(probe, { create: true, safeIntegers: true });
    chmodSync(probe, 0o600);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE probe(n INTEGER); INSERT INTO probe VALUES(7)");
    let child;
    try { child = Bun.spawn([sandbox, "-p", PROFILE, ...command("_probe", probe, forbidden)], {
      stdout: "pipe", stderr: "ignore", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    }); }
    catch { throw new StoreError("macOS file isolation could not be verified; reading the source database was refused"); }
    const { output, exit } = await bounded(child, (async () => ({
      output: await new Response(child.stdout).text(), exit: await child.exited,
    }))(), 8);
    if (exit !== 0 || output.trim() !== "isolated") throw new StoreError("macOS file isolation or the read-only WAL probe failed; reading the source database was refused");
  } finally {
    db?.close();
    for (const file of [probe, probe + "-wal", probe + "-shm", forbidden, forbidden + "-create"]) {
      try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
export function probeMain(db: string, forbidden: string): number {
  const state = stateDirectory(dirname(db), false);
  if (dirname(forbidden) !== state || basename(db) !== "isolation-probe.db"
    || basename(forbidden) !== "isolation-forbidden") throw new StoreError("Invalid isolation probe arguments; opening the source database was refused");
  assertIsolated(state);
  for (const file of [forbidden + "-create", forbidden]) {
    let fd;
    try { fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW | (file.endsWith("-create") ? constants.O_CREAT | constants.O_EXCL : 0), 0o600); }
    catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; return 2; }
    closeSync(fd); return 2;
  }
  const connection = new Database(db, { readonly: true, create: false, safeIntegers: true });
  try { if (connection.query<{ n: bigint }, []>("SELECT n FROM probe").get()?.n !== 7n) return 2; }
  finally { connection.close(); }
  console.log("isolated");
  return 0;
}
export class QueryRunner {
  private child: Child | null = null;
  private closed = false;
  private waiting = false;
  workerCommand = () => command("_query");
  file_identity: [number, number];
  private constructor(readonly db: string, readonly state: string, readonly zone: string, readonly timeout: number) {
    this.file_identity = fileIdentity(db);
  }
  static async create(db: string, state: string, zone = systemZone(), timeout = 15) {
    state = stateDirectory(state, false);
    const runner = new QueryRunner(validateSource(db, state), state, zone, timeout);
    zoneFormatter(zone);
    await verifyIsolation(state);
    return runner;
  }
  get busy() { return this.child !== null; }
  private validateIdentity() {
    const db = validateSource(this.db, this.state);
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(this.file_identity)) throw new StoreError("The source database was replaced; stop and restart the service");
  }
  async run(operation: "dashboard" | "session" | "rounds" | "activities" | "request" | "tools" | "call", args: Args, sid: string | null = null, requestId: string | null = null): Promise<any> {
    if (this.child) {
      if (this.waiting) throw new StoreError("The reader is busy; try again later");
      this.waiting = true;
      try {
        const until = performance.now() + 250;
        while (this.child && performance.now() < until && !this.closed) await Bun.sleep(10);
        if (this.child) throw new StoreError("The reader is busy; try again later");
      } finally { this.waiting = false; }
    }
    if (this.closed) throw new StoreError("The service is stopping; run tokenflow start");
    this.validateIdentity();
    const request = JSON.stringify({ db: this.db, state: this.state, zone: this.zone, operation, args, sid, request_id: requestId,
      file_identity: this.file_identity, timeout: Math.max(0.01, this.timeout - 1) });
    if (Buffer.byteLength(request) > 16384) throw new StoreError("Query parameters are too long", 400);
    let child;
    try { child = Bun.spawn([SANDBOX, "-p", PROFILE, ...this.workerCommand()], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: {
        ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        // Rosetta JSC JIT traps under Seatbelt write denial; keep the worker interpreted.
        ...(process.arch === "x64" ? { BUN_JSC_useJIT: "0" } : {}),
      },
    }); }
    catch { throw new StoreError("Could not start the isolated reader; check the installation"); }
    this.child = child;
    try {
      child.stdin.write(request); child.stdin.end();
      const output = await bounded(child, (async () => {
        const text = await new Response(child.stdout).text();
        if (await child.exited !== 0) throw new StoreError("The isolated reader failed or was cancelled; check macOS isolation support");
        return text;
      })(), this.timeout);
      let response;
      try { response = JSON.parse(output); } catch { throw new StoreError("The isolated reader returned an invalid result"); }
      if (response.error) throw new StoreError(response.error, response.status);
      if (!response.data) throw new StoreError("The isolated reader returned an invalid result");
      this.validateIdentity();
      return response.data;
    } finally { await terminate(child); this.child = null; }
  }
  async close() { this.closed = true; if (this.child) await terminate(this.child); }
}
export async function workerMain(): Promise<number> {
  let result;
  try {
    const reader = Bun.stdin.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) { await reader.cancel(); throw new StoreError("Query parameters are too long", 400); }
      chunks.push(value);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const state = stateDirectory(request.state, false);
    assertIsolated(state);
    const db = validateSource(request.db, state);
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(request.file_identity)) throw new StoreError("The source database was replaced; restart the service");
    if (typeof request.zone !== "string" || typeof request.timeout !== "number" || request.timeout <= 0
      || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new StoreError("Invalid query parameters or time zone configuration", 400);
    zoneFormatter(request.zone);
    if (request.operation === "call" && Object.keys(request.args).length) throw new StoreError("Unknown query parameter", 400);
    const store = new Store(db, request.zone, request.timeout);
    const data = request.operation === "dashboard" ? store.dashboard(request.args)
      : request.operation === "session" && typeof request.sid === "string" ? store.session(request.sid, request.args)
      : request.operation === "rounds" && typeof request.sid === "string" ? store.rounds(request.sid, request.args)
      : request.operation === "activities" && typeof request.sid === "string" ? await roundActivities(db, request.sid, store.roundAnchors(request.sid, request.args), request.zone)
      : request.operation === "request" && typeof request.sid === "string" && typeof request.request_id === "string"
        ? store.request(request.sid, request.request_id, request.args)
      : request.operation === "tools" && typeof request.sid === "string" && typeof request.request_id === "string"
        ? await toolActivity(db, request.sid, store.toolAnchor(request.sid, request.request_id), request.args, request.zone)
      : request.operation === "call" && typeof request.sid === "string" && typeof request.request_id === "string"
        ? await singleCall(db, request.sid, store.callAnchor(request.sid, request.request_id), request.zone)
      : (() => { throw new StoreError("Unknown read operation", 400); })();
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(request.file_identity)) throw new StoreError("The source database was replaced while reading; restart the service");
    result = { data };
  } catch (error) {
    result = error instanceof StoreError ? { error: error.message, status: error.status }
      : { error: "The source database, query parameters, or state directory are inaccessible; check permissions and configuration", status: 503 };
  }
  console.log(JSON.stringify(result));
  return 0;
}
