import { constants, openSync, closeSync, lstatSync, fstatSync, createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StoreError } from "./store";

export type EventData = Record<string, unknown>;
export type SessionEvent = { type: string; timestamp: string | null; agentId: string | null; data: EventData };
export class MissingEventsError extends StoreError {
  constructor() { super("该会话没有本地 events.jsonl，详细记录不可用", 404); }
}
export function isRecord(value: unknown): value is EventData {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function contentText(value: unknown): string | null {
  return value === undefined || value === null ? null : typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function parseEvent(line: string): SessionEvent {
  let value: unknown;
  try { value = JSON.parse(line); }
  catch { throw new StoreError("本地会话日志含损坏的完整记录，已停止读取"); }
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data)
    || (value.agentId !== undefined && value.agentId !== null && typeof value.agentId !== "string")) {
    throw new StoreError("本地会话日志结构不兼容");
  }
  return { type: value.type, timestamp: stringValue(value.timestamp), agentId: stringValue(value.agentId), data: value.data };
}

export async function* sessionEvents(db: string, sid: string, diagnostics: { partial_tail: boolean }): AsyncGenerator<SessionEvent> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) throw new StoreError("会话 ID 不适用于本地日志路径", 400);
  const root = join(dirname(db), "session-state"), directory = join(root, sid), path = join(directory, "events.jsonl");
  let fd: number;
  try {
    for (const entry of [root, directory, path]) {
      const info = lstatSync(entry);
      if (info.isSymbolicLink() || info.uid !== process.getuid!() || (entry === path ? !info.isFile() : !info.isDirectory())) {
        throw new StoreError("本地会话日志路径或文件身份不安全，已拒绝读取");
      }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingEventsError();
    if (error instanceof StoreError) throw error;
    throw new StoreError("无法只读访问本地会话日志，请检查权限");
  }
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile() || initial.uid !== process.getuid!()) throw new StoreError("本地会话日志文件身份不安全");
    // ponytail: scan at most 128 MiB per request; add an index only if measured latency requires it.
    if (initial.size > 128 * 1024 * 1024) throw new StoreError("本地会话日志超过 128 MiB 读取上限");
    const decoder = new StringDecoder("utf8");
    let pending = "", sourceSession: string | null = null;
    if (initial.size) {
      const stream = createReadStream(path, { fd, autoClose: false, start: 0, end: initial.size - 1, highWaterMark: 65536 });
      for await (const chunk of stream) {
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new StoreError("本地会话日志单条记录超过读取上限");
          const item = parseEvent(line);
          if (item.type === "session.start" && !item.agentId) sourceSession = stringValue(item.data.sessionId);
          yield item;
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new StoreError("本地会话日志单条记录超过读取上限");
      }
      pending += decoder.end();
    }
    // An active writer may leave a partial tail; only newline-terminated JSONL is committed.
    diagnostics.partial_tail = pending.length > 0;
    const final = fstatSync(fd), current = lstatSync(path);
    if (final.size < initial.size || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw new StoreError("读取期间本地会话日志被替换或截断，请重试");
    }
    if (sourceSession !== sid) throw new StoreError("本地会话日志不属于该会话，已拒绝关联");
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("本地会话日志读取失败，请检查文件及权限");
  } finally { closeSync(fd); }
}
