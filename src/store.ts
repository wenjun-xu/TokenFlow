import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { Period, parseTime, localDate, compareTime, formatTime, zoneFormatter, type TimeKey, type Args } from "./dates";

export class StoreError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}
export const SESSION_FIELDS = ["id", "cwd", "repository", "host_type", "branch", "summary", "created_at", "updated_at"];
export const USAGE_FIELDS = ["id", "session_id", "model", "input_tokens", "output_tokens", "cache_read_tokens",
  "created_at", "duration_ms", "time_to_first_token_ms", "turn_index", "agent_id", "initiator", "finish_reason"];
const TURN_FIELDS = ["id", "session_id", "turn_index", "timestamp", "user_message", "assistant_response"];
const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens"] as const;
const PERFORMANCE_FIELDS = new Set(["duration_ms", "time_to_first_token_ms"]);
type Row = Record<string, any>;
export type CallRequest = {
  id: string; session_id: string; model: string; created_at: string | null; agent_id: string | null;
  input_tokens: string | null; output_tokens: string | null; cache_read_tokens: string | null;
  duration_ms: number | string | null; initiator: string | null; finish_reason: string | null;
};
export type CallAnchor = { request: CallRequest; candidate_count: string };
type RoundGroup = { turn_index: bigint | null; request_id: bigint; metrics: Metrics; models: Set<string>;
  first_key: TimeKey | null; last_key: TimeKey | null; first_request: string | null; last_request: string | null };
type TrendPoint = { id: bigint; created_at: string | null; model: string; input_tokens: bigint | null;
  output_tokens: bigint | null; cache_read_tokens: bigint | null; key: TimeKey | null };

function roundIndex(value: string): bigint | null {
  if (typeof value !== "string") throw new StoreError("Invalid Round index", 400);
  if (value === "missing") return null;
  if (!/^-?[0-9]{1,20}$/.test(value)) throw new StoreError("Invalid Round index", 400);
  const index = BigInt(value);
  if (index < -(2n ** 63n) || index >= 2n ** 63n) throw new StoreError("Round index is outside the integer range", 400);
  return index;
}
function roundOrder(a: RoundGroup, b: RoundGroup, descending = false): number {
  if (a.turn_index === null || b.turn_index === null) return a.turn_index === b.turn_index ? 0 : a.turn_index === null ? 1 : -1;
  const order = a.turn_index < b.turn_index ? -1 : a.turn_index > b.turn_index ? 1 : 0;
  return descending ? -order : order;
}

export function integerStrings(value: any): any {
  if (typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value))) return String(value);
  if (Array.isArray(value)) return value.map(integerStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, integerStrings(v)]));
  return value;
}
export class Metrics {
  values: Record<typeof TOKEN_FIELDS[number], bigint | null> = { input_tokens: 0n, output_tokens: 0n, cache_read_tokens: 0n };
  calls = 0n;
  add(row: Row) {
    this.calls++;
    for (const field of TOKEN_FIELDS) {
      const value = row[field];
      if (value !== null && typeof value !== "bigint") throw new StoreError("A token field is not an integer; incompatible database schema or record");
      if (value === null) this.values[field] = null;
      else if (this.values[field] !== null) this.values[field] += value;
    }
  }
  result() {
    const { input_tokens: incoming, output_tokens: outgoing } = this.values;
    return { ...this.values, calls: this.calls, total_tokens: incoming === null || outgoing === null ? null : incoming + outgoing };
  }
}
export function pageNumber(args: Args, key: string): number {
  const raw = args[key] ?? "1";
  if (typeof raw !== "string" || !/^[0-9]{1,8}$/.test(raw) || Number(raw) < 1) throw new StoreError("Page number must be a positive integer", 400);
  return Number(raw);
}
export function paged(total: bigint, page: number, size: number) {
  const pages = total === 0n ? 1n : (total + BigInt(size) - 1n) / BigInt(size);
  if (BigInt(page) > pages) throw new StoreError(`Page number is out of range; return to page 1 (${pages} pages total)`, 400);
  return { page, pages, total, size };
}
function textFields(row: Row, fields: string[]) {
  if (fields.some(f => row[f] !== null && typeof row[f] !== "string")) throw new StoreError("Incompatible database text field type");
}
function numericFields(row: Row, fields: string[]) {
  for (const field of fields) {
    const value = row[field];
    if (value === null || typeof value === "bigint") continue;
    if (PERFORMANCE_FIELDS.has(field)) {
      if (typeof value === "number" && Number.isFinite(value)) continue;
      throw new StoreError(`Request duration field ${field} must be a finite number or NULL`);
    }
    throw new StoreError(`Raw Round field ${field} must be an integer or NULL`);
  }
}
function usageFields(row: Row) {
  if (typeof row.model !== "string" || !row.model.trim()) throw new StoreError("The request's actual model is missing or incompatible; check the database schema");
  if (typeof row.id !== "bigint") throw new StoreError("Incompatible request ID type");
  textFields(row, ["session_id", "model", "created_at", "agent_id", "initiator", "finish_reason"]);
  numericFields(row, ["duration_ms", "time_to_first_token_ms", "turn_index"]);
}
function sessionTotalOrder(a: Row, b: Row, ascending = false): number {
  const left: bigint | null = a.acc.result().total_tokens, right: bigint | null = b.acc.result().total_tokens;
  if (left !== right) {
    if (left === null || right === null) return left === null ? 1 : -1;
    return (left > right ? -1 : 1) * (ascending ? -1 : 1);
  }
  if (!a.latest_key || !b.latest_key) return a.latest_key ? -1 : b.latest_key ? 1 : lexical(a.id, b.id);
  return -compareTime(a.latest_key, b.latest_key) || lexical(a.id, b.id);
}
function requestInteger(sid: string, requestId: string): bigint {
  if (typeof sid !== "string" || !sid || sid.length > 1024 || typeof requestId !== "string"
    || !/^-?[0-9]{1,20}$/.test(requestId)) throw new StoreError("Invalid Session or request ID", 400);
  const id = BigInt(requestId);
  if (id < -(2n ** 63n) || id >= 2n ** 63n) throw new StoreError("Request ID is outside the integer range", 400);
  return id;
}
function sqliteError(error: unknown): StoreError {
  const code = (error as { code?: string }).code ?? "";
  if (/BUSY|LOCKED/.test(code)) return new StoreError("The database is locked and the read timed out; try again later");
  if (/CORRUPT|NOTADB/.test(code)) return new StoreError("The database is corrupt or is not a SQLite file; check the data source");
  if (/CANTOPEN|READONLY|PERM|AUTH/.test(code)) return new StoreError("Could not access the database or WAL/SHM read-only; this tool will not create or repair them");
  return new StoreError("Database read failed or the schema is incompatible; check the data source and WAL/SHM");
}
export class Store {
  constructor(readonly db: string, readonly zone: string, readonly timeout = 12) {}
  dashboard(args: Args): any { return this.read(null, args); }
  session(sid: string, args: Args): any { return this.read(sid, args); }
  rounds(sid: string, args: Args): any { return this.read(sid, args, true); }
  private requestRecord(db: Database, sid: string, id: bigint): Row {
    if (!db.query<Row, [string]>("SELECT id FROM sessions WHERE id=?").get(sid)) throw new StoreError("The Session does not exist or was deleted", 404);
    const row = db.query<Row, [string, bigint]>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events WHERE session_id=? AND id=?`).get(sid, id);
    if (!row) throw new StoreError("The request does not exist or does not belong to this Session; refresh the page", 404);
    usageFields(row);
    const metrics = new Metrics(); metrics.add(row);
    return { ...row, total_tokens: metrics.result().total_tokens, invalid_time: parseTime(row.created_at) === null };
  }
  callAnchor(sid: string, requestId: string): CallAnchor {
    const id = requestInteger(sid, requestId);
    return this.snapshot(db => {
      const request = this.requestRecord(db, sid, id);
      const seconds = parseTime(request.created_at)?.[0];
      const fields = ["session_id", "model", "agent_id", "input_tokens", "output_tokens", "cache_read_tokens", "duration_ms", "initiator", "finish_reason"];
      const count = seconds === undefined ? 0n : db.query<{ n: bigint }, Array<string | bigint | number | null>>(
        `SELECT count(*) AS n FROM assistant_usage_events WHERE ${fields.map(field => field + " IS ?").join(" AND ")} AND tf_seconds(created_at)=?`,
      ).get(...fields.map(field => request[field]), seconds)!.n;
      return { request, candidate_count: count };
    });
  }
  roundAnchors(sid: string, args: Args): CallAnchor[] {
    if (Object.keys(args).some(key => !["round", "year", "month", "day", "start", "end"].includes(key)) || args.round === undefined) {
      throw new StoreError("Invalid Round summary query parameters", 400);
    }
    const selected = roundIndex(args.round);
    let period: Period;
    try { period = new Period(args, this.zone); } catch { throw new StoreError("Invalid date filter", 400); }
    const result = this.snapshot((db, check) => {
      if (!db.query<Row, [string]>("SELECT id FROM sessions WHERE id=?").get(sid)) throw new StoreError("The Session does not exist or was deleted", 404);
      const counts = new Map<string, bigint>(), rows: Row[] = [];
      const fingerprint = (row: Row) => {
        const time = parseTime(row.created_at);
        return time ? JSON.stringify(integerStrings([row.session_id, row.model, row.agent_id, row.input_tokens, row.output_tokens,
          row.cache_read_tokens, row.duration_ms, row.initiator, row.finish_reason, time[0]])) : null;
      };
      for (const row of db.query<Row, [string]>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events WHERE session_id=?`).iterate(sid)) {
        check(); usageFields(row); new Metrics().add(row);
        const key = fingerprint(row);
        if (key) counts.set(key, (counts.get(key) ?? 0n) + 1n);
        if (row.turn_index === selected && period.contains(parseTime(row.created_at))) rows.push(row);
      }
      rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { anchors: rows.map(row => ({ request: row, candidate_count: counts.get(fingerprint(row) ?? "") ?? 0n })) };
    });
    return result.anchors;
  }
  toolAnchor(sid: string, turnId: string): string | null {
    if (!sid || sid.length > 1024 || !/^[0-9]{1,20}$/.test(turnId) || BigInt(turnId) >= 2n ** 63n) throw new StoreError("Invalid Session or Round ID", 400);
    const result = this.snapshot(db => {
      const row = db.query<Row, [string, bigint]>("SELECT user_message FROM turns WHERE session_id=? AND id=?").get(sid, BigInt(turnId));
      if (!row) throw new StoreError("The Round does not exist or does not belong to this Session", 404);
      textFields(row, ["user_message"]);
      return row;
    });
    return result.user_message;
  }
  request(sid: string, requestId: string, args: Args): any {
    const id = requestInteger(sid, requestId);
    if (Object.keys(args).some(key => !["view", "turnPage", "expandedTurn", "full"].includes(key))) throw new StoreError("Unknown query parameter", 400);
    if (args.full !== undefined && args.full !== "1") throw new StoreError("Invalid content read parameter", 400);
    const view = args.view ?? "matched";
    if (view !== "matched" && view !== "all") throw new StoreError("Invalid conversation view", 400);
    return this.snapshot((db, check) => {
      const row = this.requestRecord(db, sid, id);
      const result: Row = {
        request: row,
        view, read_at: new Date().toISOString(),
      };
      const count = this.turnRecords(db, sid, args, result, check, view === "matched" ? row.turn_index : undefined);
      result.association = view === "all" ? "all" : row.turn_index === null ? "no_index"
        : count === 0n ? "missing" : count === 1n ? "matched" : "ambiguous";
      return result;
    });
  }
  schema(db: Database): bigint[] {
    const tables = new Map(db.query<Row, []>("SELECT name,type FROM sqlite_master WHERE name IN ('sessions','assistant_usage_events','turns','schema_version')")
      .all().map(r => [r.name, r.type]));
    const numeric = new Set(["version", "id", "turn_index", "duration_ms", "time_to_first_token_ms", ...TOKEN_FIELDS]);
    for (const [table, fields] of [["sessions", SESSION_FIELDS], ["assistant_usage_events", USAGE_FIELDS],
      ["turns", TURN_FIELDS], ["schema_version", ["version"]]] as [string, string[]][]) {
      if (tables.get(table) !== "table") throw new StoreError(`Incompatible database schema: missing regular table ${table}`);
      const columns = new Map(db.query<Row, []>(`PRAGMA table_info(${table})`).all().map(r => [r.name, r.type.toUpperCase()]));
      for (const field of fields) {
        const declared = columns.get(field);
        const isNumber = numeric.has(field) && !(table === "sessions" && field === "id");
        const validType = declared && (isNumber
          ? PERFORMANCE_FIELDS.has(field) ? /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(declared) : declared.includes("INT")
          : /TEXT|CHAR|CLOB/.test(declared));
        if (!validType) {
          throw new StoreError(`Incompatible database schema: required field ${table}.${field} is missing or has the wrong type`);
        }
      }
    }
    const versions = db.query<{ version: bigint }, []>("SELECT version FROM schema_version").all().map(r => r.version);
    if (versions.some(v => typeof v !== "bigint")) throw new StoreError("Incompatible database version field");
    return versions;
  }
  private snapshot(work: (db: Database, check: () => void, versions: bigint[]) => Row): any {
    const deadline = performance.now() + this.timeout * 1000;
    const check = () => { if (performance.now() >= deadline) throw new StoreError("Database read timed out; narrow the range and try again"); };
    let db: Database | undefined;
    try {
      db = new Database(this.db, { readonly: true, create: false, strict: true, safeIntegers: true });
      db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN");
      check();
      const versions = this.schema(db);
      db.function("tf_seconds", { deterministic: true }, (value: unknown) => { check(); return parseTime(value)?.[0] ?? null; });
      db.function("tf_fraction", { deterministic: true }, (value: unknown) => parseTime(value)?.[1] ?? "");
      const result = work(db, check, versions);
      const formatter = zoneFormatter(this.zone);
      for (const row of [result, result.session, result.request, ...(result.sessions ?? []), ...(result.requests ?? []), ...(result.turns ?? []), ...(result.rounds ?? []), ...(result.round_trend ?? []), ...(result.token_trend ?? [])]) {
        if (!row) continue;
        for (const field of ["created_at", "updated_at", "latest_request", "timestamp", "read_at", "first_request", "last_request"]) {
          if (Object.hasOwn(row, field)) row[field + "_display"] = formatTime(row[field], formatter);
        }
      }
      check(); db.exec("ROLLBACK");
      return integerStrings(result);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw sqliteError(error);
    } finally { db?.close(); }
  }
  private read(sid: string | null, args: Args, grouped = false): any {
    const allowed = grouped ? ["year", "month", "day", "start", "end", "round", args.round === undefined ? "roundPage" : "requestPage"]
      : sid === null ? ["date", "year", "month", "day", "start", "end", "page", "pageSize", "sort", "repository", "model"]
        : ["year", "month", "day", "start", "end", "requestPage", "turnPage", "expandedTurn", "full"];
    if (Object.keys(args).some(k => !allowed.includes(k))) throw new StoreError("Unknown query parameter", 400);
    if (args.sort !== undefined && !["latest", "latest_asc", "total_tokens", "total_tokens_asc"].includes(args.sort)) throw new StoreError("Invalid Session sort option", 400);
    for (const [field, label] of [["repository", "Repository"], ["model", "Model"]]) {
      const value = args[field];
      if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 1024)) {
        throw new StoreError(`Invalid ${label} filter`, 400);
      }
      if (args.pageSize !== undefined && !["10", "20", "50", "100"].includes(args.pageSize)) throw new StoreError("Invalid page size", 400);
    }
    if (args.full !== undefined && args.full !== "1") throw new StoreError("Invalid content read parameter", 400);
    const selectedRound = grouped && args.round !== undefined ? roundIndex(args.round) : undefined;
    const readAt = new Date();
    const today = formatTime(readAt.toISOString(), zoneFormatter(this.zone))?.slice(0, 10);
    if (!today) throw new StoreError("Could not read the OS-local date");
    if (args.date !== undefined && (!["today", "last7", "last30"].includes(args.date)
      || ["year", "month", "day", "start", "end"].some(field => args[field] !== undefined))) {
      throw new StoreError("Invalid date filter", 400);
    }
    const [year, month, day] = today.split("-");
    const first = new Date(today + "T00:00:00Z");
    first.setUTCDate(first.getUTCDate() - (args.date === "last7" ? 6 : args.date === "last30" ? 29 : 0));
    const periodArgs = args.date === "today" ? {year, month, day}
      : args.date ? {start: first.toISOString().slice(0, 10), end: today} : args;
    let period: Period;
    try { period = new Period(periodArgs, this.zone); } catch { throw new StoreError("Invalid date filter: select a valid year, month, and day", 400); }
    if (sid === null && ((period.year !== null && period.label > today) || (period.end && period.end > today))) throw new StoreError("The selected date cannot be later than Today", 400);
    return this.snapshot((db, check, versions) => {
      const sessions = new Map<string, Row>();
      for (const row of db.query<Row, []>(`SELECT ${SESSION_FIELDS} FROM sessions`).iterate()) {
        check(); textFields(row, SESSION_FIELDS);
        if (typeof row.id !== "string" || !row.id) throw new StoreError("Incompatible Session ID");
        sessions.set(row.id, { ...row, acc: new Metrics(), models: new Set<string>(), latest_key: null, latest_request: null });
      }
      if (sid !== null && !sessions.has(sid)) throw new StoreError("The Session does not exist or was deleted; return to the Session list", 404);
      const total = new Metrics(), models = new Map<string, Metrics>(), years = new Set<number>();
      const modelTypes = new Set<string>();
      const periodRepositories = new Set<string>();
      const groups = new Map<bigint | null, RoundGroup>();
      const trend: TrendPoint[] = [];
      const usageTrend = new Map<string, Metrics>();
      if (sid === null && period.day !== null) {
        for (let hour = 0; hour < 24; hour++) usageTrend.set(`${period.label} ${String(hour).padStart(2, "0")}:00`, new Metrics());
      } else if (sid === null && period.start && period.end) {
        const date = new Date(period.start + "T00:00:00Z");
        while (date.toISOString().slice(0, 10) <= period.end) {
          check();
          usageTrend.set(date.toISOString().slice(0, 10), new Metrics());
          date.setUTCDate(date.getUTCDate() + 1);
        }
      }
      let invalid = 0n, orphan = 0n;
      for (const row of db.query<Row, []>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events`).iterate()) {
        check();
        let key = parseTime(row.created_at);
        const local = localDate(key, period.formatter);
        if (!local) { invalid++; key = null; } else years.add(local[0]);
        const session = sessions.get(row.session_id);
        if (!session) { orphan++; continue; }
        usageFields(row);
        modelTypes.add(row.model);
        if (!period.contains(key)) continue;
        if (typeof session.repository === "string" && session.repository.trim()) periodRepositories.add(session.repository);
        if (sid === null && ((args.repository !== undefined && session.repository !== args.repository)
          || (args.model !== undefined && row.model !== args.model))) continue;
        session.acc.add(row); session.models.add(row.model);
        if (sid === null && key) {
          const time = formatTime(row.created_at, period.formatter)!;
          const bucket = period.day !== null ? time.slice(0, 13) + ":00" : time.slice(0, 10);
          if (!usageTrend.has(bucket)) usageTrend.set(bucket, new Metrics());
          usageTrend.get(bucket)!.add(row);
        }
        if (key && (!session.latest_key || compareTime(key, session.latest_key) > 0)) {
          session.latest_key = key; session.latest_request = row.created_at;
        }
        const selected = selectedRound === undefined || row.turn_index === selectedRound;
        if ((sid === null || row.session_id === sid) && selected) total.add(row);
        if (sid !== null && row.session_id === sid && selected) {
          if (!models.has(row.model)) models.set(row.model, new Metrics());
          models.get(row.model)!.add(row);
          if (grouped && selectedRound !== undefined) trend.push({
            id: row.id, created_at: row.created_at, model: row.model, input_tokens: row.input_tokens,
            output_tokens: row.output_tokens, cache_read_tokens: row.cache_read_tokens, key,
          });
          if (grouped && selectedRound === undefined) {
            let group = groups.get(row.turn_index);
            if (!group) {
              group = { turn_index: row.turn_index, request_id: row.id, metrics: new Metrics(), models: new Set(),
                first_key: null, last_key: null, first_request: null, last_request: null };
              groups.set(row.turn_index, group);
            }
            group.metrics.add(row); group.models.add(row.model);
            if (row.id < group.request_id) group.request_id = row.id;
            if (key && (!group.first_key || compareTime(key, group.first_key) < 0)) {
              group.first_key = key; group.first_request = row.created_at;
            }
            if (key && (!group.last_key || compareTime(key, group.last_key) > 0)) {
              group.last_key = key; group.last_request = row.created_at;
            }
          }
        }
      }
      const result: Row = {
        metrics: total.result(), period: period.label, timezone: this.zone, years: [...years].sort((a, b) => b - a),
        schema_versions: versions, diagnostics: { invalid_times: invalid, orphan_requests: orphan },
        diagnostics_scope: "Entire database (the two categories may overlap; orphan requests are excluded from Session totals)", source: this.db, read_at: readAt.toISOString(),
      };
      if (sid === null) {
        result.today = today;
        result.range_start = period.start;
        result.range_end = period.end;
        result.usage_trend = [...usageTrend].sort(([a], [b]) => lexical(a, b)).map(([time, metrics]) => ({time, ...metrics.result()}));
        result.repositories = (period.year === null && !period.start
          ? [...new Set([...sessions.values()].map(s => s.repository)
            .filter(repository => typeof repository === "string" && repository.trim()))]
          : [...periodRepositories]).sort(lexical);
        result.model_types = [...modelTypes].sort(lexical);
        const rows = [...sessions.values()].filter(s => (args.repository === undefined || s.repository === args.repository)
          && ((period.year === null && !period.start && args.model === undefined) || s.acc.calls));
        const ranked = [...rows].sort((a, b) => sessionTotalOrder(a, b));
        result.top_sessions = ranked.filter(s => {
          const total: bigint | null = s.acc.result().total_tokens;
          return total !== null && total > 0n;
        }).slice(0, 5).map(sessionRow);
        result.top_total_tokens = result.top_sessions.reduce((sum: bigint, s: Row) => sum + s.metrics.total_tokens, 0n);
        result.unknown_total_sessions = rows.filter(s => s.acc.result().total_tokens === null).length;
        rows.sort((a, b) => {
          if (args.sort === "total_tokens" || args.sort === "total_tokens_asc") {
            return sessionTotalOrder(a, b, args.sort === "total_tokens_asc");
          }
          if (!a.latest_key || !b.latest_key) return a.latest_key ? -1 : b.latest_key ? 1 : lexical(a.id, b.id);
          return (args.sort === "latest_asc" ? 1 : -1) * compareTime(a.latest_key, b.latest_key) || lexical(a.id, b.id);
        });
        result.session_usage = rows.map(session => {
          const row = sessionRow(session);
          return {id: row.id, title: row.title, project: row.project, metrics: row.metrics};
        });
        check();
        const page = pageNumber(args, "page");
        const pageSize = Number(args.pageSize ?? "20");
        result.pagination = paged(BigInt(rows.length), page, pageSize);
        result.session_count = rows.length;
        result.sessions = rows.slice((page - 1) * pageSize, page * pageSize).map(sessionRow);
      } else {
        result.session = sessionRow(sessions.get(sid)!);
        result.models = [...models.entries()].sort(([a], [b]) => lexical(a, b)).map(([model, acc]) => ({ model, ...acc.result() }));
        if (grouped && selectedRound === undefined) {
          const previews = new Map<bigint, {count: bigint; summary: string | null}>();
          for (const turn of db.query<Row, [string]>("SELECT turn_index,substr(user_message,1,240) AS summary FROM turns WHERE session_id=?").iterate(sid)) {
            check(); textFields(turn, ["summary"]);
            if (turn.turn_index === null) continue;
            if (typeof turn.turn_index !== "bigint") throw new StoreError("Incompatible conversation Round index type");
            const previous = previews.get(turn.turn_index);
            previews.set(turn.turn_index, {count: (previous?.count ?? 0n) + 1n, summary: turn.summary});
          }
          const roundRow = (group: RoundGroup) => {
            check();
            const preview = group.turn_index === null ? undefined : previews.get(group.turn_index);
            const state = group.turn_index === null ? "no_index" : !preview ? "missing"
              : preview.count !== 1n ? "ambiguous" : preview.summary ? "recorded" : "missing";
            return {
              turn_index: group.turn_index, request_id: group.request_id, metrics: group.metrics.result(), models: [...group.models].sort(lexical),
              first_request: group.first_request, last_request: group.last_request, invalid_time: group.first_key === null,
              summary_status: state, summary: state === "recorded" ? preview!.summary
                : state === "ambiguous" ? "This Round's conversation cannot be uniquely identified." : state === "no_index" ? "No Round index was recorded; the conversation cannot be linked." : "This Round's conversation has not been recorded yet.",
            };
          };
          const rows = [...groups.values()].sort((a, b) => roundOrder(a, b));
          const page = pageNumber(args, "roundPage");
          result.round_pagination = paged(BigInt(rows.length), page, 10);
          result.rounds = [...rows].sort((a, b) => roundOrder(a, b, true)).slice((page - 1) * 10, page * 10).map(roundRow);
          result.round_trend = rows.map(roundRow);
        } else {
          if (grouped) {
            result.round = selectedRound;
            trend.sort((a, b) => {
              const time = !a.key || !b.key ? (a.key ? -1 : b.key ? 1 : 0) : compareTime(a.key, b.key);
              return time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            });
            result.token_trend = trend.map(({ key, ...point }) => ({ ...point, invalid_time: key === null }));
          }
          this.detail(db, sid, args, period, result, check, selectedRound);
        }
      }
      return result;
    });
  }
  private detail(db: Database, sid: string, args: Args, period: Period, result: Row, check: () => void, selectedRound?: bigint | null) {
    db.function("tf_period", { deterministic: true }, (value: unknown) => Number(period.contains(parseTime(value))));
    const page = pageNumber(args, "requestPage");
    const pageSize = selectedRound === undefined ? 50 : 10;
    result.request_pagination = paged(result.metrics.calls, page, pageSize);
    result.requests = [];
    const scope = selectedRound === undefined ? "" : " AND turn_index IS ?";
    const values: Array<string | bigint | number | null> = selectedRound === undefined ? [sid] : [sid, selectedRound];
    for (const row of db.query<Row, Array<string | bigint | number | null>>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events
      WHERE session_id=? AND tf_period(created_at)${scope} ORDER BY tf_seconds(created_at) IS NULL,
      tf_seconds(created_at) DESC,tf_fraction(created_at) COLLATE BINARY DESC,id DESC LIMIT ? OFFSET ?`).iterate(...values, pageSize, (page - 1) * pageSize)) {
      check(); const acc = new Metrics(); acc.add(row);
      result.requests.push({ ...row, total_tokens: acc.result().total_tokens, invalid_time: parseTime(row.created_at) === null });
    }
    if (selectedRound === undefined) this.turnRecords(db, sid, args, result, check);
  }
  private turnRecords(db: Database, sid: string, args: Args, result: Row, check: () => void, turnIndex?: bigint | null): bigint {
    check();
    const turnPage = pageNumber(args, "turnPage");
    const where = "session_id=?" + (turnIndex === undefined ? "" : " AND turn_index=?");
    const values: Array<string | bigint | null> = turnIndex === undefined ? [sid] : [sid, turnIndex];
    const count = db.query<{ n: bigint }, Array<string | bigint | null>>(`SELECT count(*) AS n FROM turns WHERE ${where}`).get(...values)!.n;
    if (turnIndex !== undefined && count !== 1n) {
      result.turn_pagination = paged(0n, turnPage, 20);
      result.turns = [];
      if (args.expandedTurn !== undefined) throw new StoreError("No conversation is uniquely linked; its content cannot be expanded", 404);
      return count;
    }
    result.turn_pagination = paged(count, turnPage, 20);
    const expanded = args.expandedTurn;
    if (expanded !== undefined && !/^[0-9]{1,20}$/.test(expanded)) throw new StoreError("Invalid expanded Round ID", 400);
    const rows = db.query<Row, Array<string | bigint | number | null>>(`SELECT id,turn_index,timestamp,
      CASE WHEN ? OR CAST(id AS TEXT)=? THEN user_message ELSE substr(user_message,1,400) END AS user_message,
      CASE WHEN ? OR CAST(id AS TEXT)=? THEN assistant_response ELSE substr(assistant_response,1,400) END AS assistant_response,
      length(user_message)>400 OR length(assistant_response)>400 AS truncated FROM turns WHERE ${where}
      ORDER BY tf_seconds(timestamp) IS NULL,tf_seconds(timestamp) DESC,tf_fraction(timestamp) COLLATE BINARY DESC,
      turn_index DESC,id DESC LIMIT 20 OFFSET ?`).all(Number(args.full === "1"), expanded ?? null, Number(args.full === "1"), expanded ?? null, ...values, (turnPage - 1) * 20);
    if (expanded !== undefined && !rows.some(r => String(r.id) === expanded)) throw new StoreError("The Round is not on this page or was deleted; refresh the page", 404);
    result.turns = rows.map(row => {
      check();
      if (typeof row.id !== "bigint" || typeof row.turn_index !== "bigint") throw new StoreError("Incompatible conversation Round ID or index type");
      textFields(row, ["timestamp", "user_message", "assistant_response"]);
      return { ...row, truncated: args.full !== "1" && !!row.truncated && String(row.id) !== expanded };
    });
    return count;
  }
}
function lexical(a: string, b: string): number {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
function sessionRow(item: Row): Row {
  const id = Array.from(item.id as string);
  return {
    ...Object.fromEntries(SESSION_FIELDS.map(f => [f, item[f]])), metrics: item.acc.result(),
    models: [...item.models].sort(lexical), latest_request: item.latest_request,
    title: item.summary || (id.slice(0, 12).join("") + (id.length > 12 ? "…" : "")),
    project: item.repository || (item.cwd ? basename(item.cwd) || item.cwd : "Unspecified"),
  };
}
