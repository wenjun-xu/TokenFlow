import { constants, openSync, closeSync, lstatSync, statSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { dlopen, FFIType } from "bun:ffi";

export const defaultState = () => join(homedir(), "Library/Application Support/TokenFlow");
export const defaultDB = () => join(homedir(), ".copilot/session-store.db");
export function stateDirectory(input = defaultState(), create = true): string {
  const path = resolve(input);
  for (let current = path; ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw Error("状态目录及父目录不能是符号链接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = statSync(path);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid!() || (metadata.mode & 0o777) !== 0o700) {
    throw Error("TokenFlow 状态目录必须由当前用户拥有且权限为 0700");
  }
  if (Buffer.byteLength(join(path, "c")) >= 104) throw Error("TokenFlow 状态目录过长，无法创建私有控制 socket");
  return path;
}
export function checkFile(path: string, socket = false) {
  let metadata;
  try { metadata = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!(socket ? metadata.isSocket() : metadata.isFile()) || metadata.uid !== process.getuid!()
    || (metadata.mode & 0o777) !== 0o600) throw Error("TokenFlow 状态文件权限或类型不安全");
}
export function openPrivate(path: string): number {
  checkFile(path);
  return openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
}
let native: ReturnType<typeof dlopen<{ flock: { args: [FFIType.i32, FFIType.i32]; returns: FFIType.i32 } }>> | undefined;
export function lock(path: string): { fd: number; acquired: boolean } {
  if (process.platform !== "darwin") throw Error("需要 macOS flock 与 sandbox-exec 隔离");
  native ??= dlopen("/usr/lib/libSystem.B.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const fd = openPrivate(join(path, "lock"));
  return { fd, acquired: native.symbols.flock(fd, 2 | 4) === 0 };
}
export function tryLock(fd: number): boolean { return native!.symbols.flock(fd, 2 | 4) === 0; }
export function cleanup(path: string) {
  for (const name of ["state.json", "state.new", "c"]) {
    const file = join(path, name);
    checkFile(file, name === "c");
    try { unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
export type Info = { identity: string; token: string; db: string; file_identity: [number, number]; port: number; pid: number };
export function readState(path: string): Info {
  const file = join(path, "state.json");
  checkFile(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  try {
    if (statSync(file).size > 8192) throw Error("TokenFlow 状态不可用");
    raw = readFileSync(fd);
  } finally { closeSync(fd); }
  const info = JSON.parse(raw.toString("utf8"));
  if (!info || typeof info.identity !== "string" || !info.identity || typeof info.token !== "string"
    || typeof info.db !== "string" || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535
    || !Array.isArray(info.file_identity) || info.file_identity.length !== 2
    || info.file_identity.some((v: unknown) => !Number.isSafeInteger(v))) throw Error("TokenFlow 状态不可用；未操作任何旧 PID");
  return info;
}
