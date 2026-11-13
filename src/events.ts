import { constants, openSync, closeSync, lstatSync, fstatSync, createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StoreError } from "./store";

export type EventData = Record<string, unknown>;
export type SessionEvent = { type: string; timestamp: string | null; agentId: string | null; data: EventData };
export class MissingEventsError extends StoreError {
  constructor() { super("This Session has no local events.jsonl; detailed records are unavailable", 404); }
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
  catch { throw new StoreError("The local Session log contains a corrupt complete record; reading was stopped"); }
  if (!isRecord(value) || typeof value.type !== "string" || !isRecord(value.data)
    || (value.agentId !== undefined && value.agentId !== null && typeof value.agentId !== "string")) {
    throw new StoreError("Incompatible local Session log structure");
  }
  return { type: value.type, timestamp: stringValue(value.timestamp), agentId: stringValue(value.agentId), data: value.data };
}

export async function* sessionEvents(db: string, sid: string, diagnostics: { partial_tail: boolean }): AsyncGenerator<SessionEvent> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) throw new StoreError("The Session ID is not valid for a local log path", 400);
  const root = join(dirname(db), "session-state"), directory = join(root, sid), path = join(directory, "events.jsonl");
  let fd: number;
  try {
    for (const entry of [root, directory, path]) {
      const info = lstatSync(entry);
      if (info.isSymbolicLink() || info.uid !== process.getuid!() || (entry === path ? !info.isFile() : !info.isDirectory())) {
        throw new StoreError("The local Session log path or file identity is unsafe; reading was refused");
      }
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingEventsError();
    if (error instanceof StoreError) throw error;
    throw new StoreError("Could not access the local Session log read-only; check permissions");
  }
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile() || initial.uid !== process.getuid!()) throw new StoreError("Unsafe local Session log file identity");
    // ponytail: scan at most 128 MiB per request; add an index only if measured latency requires it.
    if (initial.size > 128 * 1024 * 1024) throw new StoreError("The local Session log exceeds the 128 MiB read limit");
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
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new StoreError("A local Session log record exceeds the read limit");
          const item = parseEvent(line);
          if (item.type === "session.start" && !item.agentId) sourceSession = stringValue(item.data.sessionId);
          yield item;
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new StoreError("A local Session log record exceeds the read limit");
      }
      pending += decoder.end();
    }
    // An active writer may leave a partial tail; only newline-terminated JSONL is committed.
    diagnostics.partial_tail = pending.length > 0;
    const final = fstatSync(fd), current = lstatSync(path);
    if (final.size < initial.size || current.isSymbolicLink() || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw new StoreError("The local Session log was replaced or truncated while reading; try again");
    }
    if (sourceSession !== sid) throw new StoreError("The local log does not belong to this Session; linking was refused");
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("Failed to read the local Session log; check the file and permissions");
  } finally { closeSync(fd); }
}
