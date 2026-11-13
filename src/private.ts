import { constants, openSync, closeSync, lstatSync, statSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { dlopen, FFIType } from "bun:ffi";

export const defaultState = () => join(homedir(), "Library/Application Support/TokenFlow");
export const defaultDB = () => join(homedir(), ".copilot/session-store.db");
export function stateDirectory(input = defaultState(), create = true): string {
  const path = resolve(input);
  for (let current = path; ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) throw Error("The state directory and its parent directories cannot be symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(current) === current) break;
  }
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = statSync(path);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid!() || (metadata.mode & 0o777) !== 0o700) {
    throw Error("The TokenFlow state directory must be owned by the current user with permissions 0700");
  }
  if (Buffer.byteLength(join(path, "c")) >= 104) throw Error("The TokenFlow state directory path is too long for a private control socket");
  return path;
}
export function checkFile(path: string, socket = false) {
  let metadata;
  try { metadata = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!(socket ? metadata.isSocket() : metadata.isFile()) || metadata.uid !== process.getuid!()
    || (metadata.mode & 0o777) !== 0o600) throw Error("Unsafe TokenFlow state file permissions or type");
}
export function openPrivate(path: string): number {
  checkFile(path);
  return openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
}
let native: ReturnType<typeof dlopen<{ flock: { args: [FFIType.i32, FFIType.i32]; returns: FFIType.i32 } }>> | undefined;
export function lock(path: string): { fd: number; acquired: boolean } {
  if (process.platform !== "darwin") throw Error("macOS flock and sandbox-exec isolation are required");
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
    if (statSync(file).size > 8192) throw Error("TokenFlow state is unavailable");
    raw = readFileSync(fd);
  } finally { closeSync(fd); }
  const info = JSON.parse(raw.toString("utf8"));
  if (!info || typeof info.identity !== "string" || !info.identity || typeof info.token !== "string"
    || typeof info.db !== "string" || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535
    || !Array.isArray(info.file_identity) || info.file_identity.length !== 2
    || info.file_identity.some((v: unknown) => !Number.isSafeInteger(v))) throw Error("TokenFlow state is unavailable; no stale PID was acted on");
  return info;
}
