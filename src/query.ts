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
  if (values.some(v => !Number.isSafeInteger(v))) throw new StoreError("源数据库文件身份超出平台支持范围");
  return values as [number, number];
}
export function validateSource(input: string, state: string): string {
  const original = resolve(input.startsWith("~/") ? join(process.env.HOME ?? "", input.slice(2)) : input);
  let path: string;
  try {
    const originalStat = lstatSync(original);
    if (originalStat.isSymbolicLink() && originalStat.uid !== process.getuid!()) throw new StoreError("数据库符号链接必须由当前用户拥有");
    path = realpathSync(original);
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.uid !== process.getuid!() || !(metadata.mode & 0o444)) throw new StoreError("数据库必须是当前用户拥有的可读普通文件");
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("源数据库不存在或无法访问；请使用 --db 指定已有数据库");
  }
  const rel = relative(state, path);
  if (rel === "" || (!rel.startsWith(".." + "/") && rel !== ".." && !rel.startsWith("/"))) throw new StoreError("源数据库不能放在 TokenFlow 状态目录中");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try { if (lstatSync(path + suffix).isSymbolicLink()) throw new StoreError("数据库 sidecar 不能是符号链接"); }
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
      timer = setTimeout(() => reject(new StoreError("完整读取任务超时（含聚合及排序），请缩小范围后重试")), seconds * 1000);
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
    throw new StoreError("无法证明文件写入隔离，已拒绝打开源库");
  }
  closeSync(fd); unlinkSync(probe);
  throw new StoreError("内部读取未受文件写入隔离保护，已拒绝打开源库");
}
export async function verifyIsolation(state: string, sandbox = SANDBOX) {
  if (process.platform !== "darwin") throw new StoreError("需要 macOS sandbox-exec 文件隔离，已拒绝读取源库");
  const probe = join(state, "isolation-probe.db"), forbidden = join(state, "isolation-forbidden");
  for (const file of [probe, probe + "-wal", probe + "-shm", forbidden, forbidden + "-create"]) {
    try { lstatSync(file); throw new StoreError("隔离探针状态残留，请检查自身状态目录"); }
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
    catch { throw new StoreError("无法验证 macOS 文件隔离，已拒绝读取源库"); }
    const { output, exit } = await bounded(child, (async () => ({
      output: await new Response(child.stdout).text(), exit: await child.exited,
    }))(), 8);
    if (exit !== 0 || output.trim() !== "isolated") throw new StoreError("macOS 文件隔离或只读 WAL 探针失败，已拒绝读取源库");
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
    || basename(forbidden) !== "isolation-forbidden") throw new StoreError("隔离探针参数无效，已拒绝打开源库");
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
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(this.file_identity)) throw new StoreError("源数据库已替换，请停止后重新启动服务");
  }
  async run(operation: "dashboard" | "session" | "rounds" | "activities" | "request" | "tools" | "call", args: Args, sid: string | null = null, requestId: string | null = null): Promise<any> {
    if (this.child) {
      if (this.waiting) throw new StoreError("读取繁忙，请稍后重试");
      this.waiting = true;
      try {
        const until = performance.now() + 250;
        while (this.child && performance.now() < until && !this.closed) await Bun.sleep(10);
        if (this.child) throw new StoreError("读取繁忙，请稍后重试");
      } finally { this.waiting = false; }
    }
    if (this.closed) throw new StoreError("服务正在停止，请执行 tokenflow start");
    this.validateIdentity();
    const request = JSON.stringify({ db: this.db, state: this.state, zone: this.zone, operation, args, sid, request_id: requestId,
      file_identity: this.file_identity, timeout: Math.max(0.01, this.timeout - 1) });
    if (Buffer.byteLength(request) > 16384) throw new StoreError("查询参数过长", 400);
    let child;
    try { child = Bun.spawn([SANDBOX, "-p", PROFILE, ...this.workerCommand()], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: {
        ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        // Rosetta JSC JIT traps under Seatbelt write denial; keep the worker interpreted.
        ...(process.arch === "x64" ? { BUN_JSC_useJIT: "0" } : {}),
      },
    }); }
    catch { throw new StoreError("无法启动隔离读取进程，请检查安装"); }
    this.child = child;
    try {
      child.stdin.write(request); child.stdin.end();
      const output = await bounded(child, (async () => {
        const text = await new Response(child.stdout).text();
        if (await child.exited !== 0) throw new StoreError("隔离读取进程失败或已取消，请检查 macOS 隔离支持");
        return text;
      })(), this.timeout);
      let response;
      try { response = JSON.parse(output); } catch { throw new StoreError("隔离读取进程返回无效结果"); }
      if (response.error) throw new StoreError(response.error, response.status);
      if (!response.data) throw new StoreError("隔离读取进程返回无效结果");
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
      if (size > 16384) { await reader.cancel(); throw new StoreError("查询参数过长", 400); }
      chunks.push(value);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const state = stateDirectory(request.state, false);
    assertIsolated(state);
    const db = validateSource(request.db, state);
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(request.file_identity)) throw new StoreError("源数据库已替换，请重新启动");
    if (typeof request.zone !== "string" || typeof request.timeout !== "number" || request.timeout <= 0
      || !request.args || typeof request.args !== "object" || Array.isArray(request.args)) throw new StoreError("查询参数或时区配置无效", 400);
    zoneFormatter(request.zone);
    if (request.operation === "call" && Object.keys(request.args).length) throw new StoreError("未知查询参数", 400);
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
      : (() => { throw new StoreError("未知读取操作", 400); })();
    if (JSON.stringify(fileIdentity(db)) !== JSON.stringify(request.file_identity)) throw new StoreError("读取期间源数据库已替换，请重新启动");
    result = { data };
  } catch (error) {
    result = error instanceof StoreError ? { error: error.message, status: error.status }
      : { error: "源数据库、查询参数或状态目录不可访问，请检查权限和配置", status: 503 };
  }
  console.log(JSON.stringify(result));
  return 0;
}
