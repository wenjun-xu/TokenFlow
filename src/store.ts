import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { Period, parseTime, localDate, compareTime, type TimeKey, type Args } from "./dates";

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
      if (value !== null && typeof value !== "bigint") throw new StoreError("Token 字段不是整数，数据库结构或记录不兼容");
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
  if (typeof raw !== "string" || !/^[0-9]{1,8}$/.test(raw) || Number(raw) < 1) throw new StoreError("页码必须是正整数", 400);
  return Number(raw);
}
export function paged(total: bigint, page: number, size: number) {
  const pages = total === 0n ? 1n : (total + BigInt(size) - 1n) / BigInt(size);
  if (BigInt(page) > pages) throw new StoreError(`页码超出范围，请返回第 1 页（共 ${pages} 页）`, 400);
  return { page, pages, total, size };
}
function textFields(row: Row, fields: string[]) {
  if (fields.some(f => row[f] !== null && typeof row[f] !== "string")) throw new StoreError("数据库文本字段类型不兼容");
}
function numericFields(row: Row, fields: string[]) {
  for (const field of fields) {
    const value = row[field];
    if (value === null || typeof value === "bigint") continue;
    if (PERFORMANCE_FIELDS.has(field)) {
      if (typeof value === "number" && Number.isFinite(value)) continue;
      throw new StoreError(`请求耗时字段 ${field} 必须是有限数值或 NULL`);
    }
    throw new StoreError(`原始轮次字段 ${field} 必须是整数或 NULL`);
  }
}
function sqliteError(error: unknown): StoreError {
  const code = (error as { code?: string }).code ?? "";
  if (/BUSY|LOCKED/.test(code)) return new StoreError("数据库被锁定，读取超时；请稍后重试");
  if (/CORRUPT|NOTADB/.test(code)) return new StoreError("数据库损坏或不是 SQLite 文件；请检查数据源");
  if (/CANTOPEN|READONLY|PERM|AUTH/.test(code)) return new StoreError("无法只读访问数据库或 WAL/SHM；工具不会创建或修复它们");
  return new StoreError("数据库读取失败或结构不兼容；请检查数据源及 WAL/SHM");
}
export class Store {
  constructor(readonly db: string, readonly zone: string, readonly timeout = 12) {}
  dashboard(args: Args): any { return this.read(null, args); }
  session(sid: string, args: Args): any { return this.read(sid, args); }
  schema(db: Database): bigint[] {
    const tables = new Map(db.query<Row, []>("SELECT name,type FROM sqlite_master WHERE name IN ('sessions','assistant_usage_events','turns','schema_version')")
      .all().map(r => [r.name, r.type]));
    const numeric = new Set(["version", "id", "turn_index", "duration_ms", "time_to_first_token_ms", ...TOKEN_FIELDS]);
    for (const [table, fields] of [["sessions", SESSION_FIELDS], ["assistant_usage_events", USAGE_FIELDS],
      ["turns", TURN_FIELDS], ["schema_version", ["version"]]] as [string, string[]][]) {
      if (tables.get(table) !== "table") throw new StoreError(`数据库结构不兼容：缺少普通表 ${table}`);
      const columns = new Map(db.query<Row, []>(`PRAGMA table_info(${table})`).all().map(r => [r.name, r.type.toUpperCase()]));
      for (const field of fields) {
        const declared = columns.get(field);
        const isNumber = numeric.has(field) && !(table === "sessions" && field === "id");
        const validType = declared && (isNumber
          ? PERFORMANCE_FIELDS.has(field) ? /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(declared) : declared.includes("INT")
          : /TEXT|CHAR|CLOB/.test(declared));
        if (!validType) {
          throw new StoreError(`数据库结构不兼容：${table}.${field} 必需字段类型错误或缺失`);
        }
      }
    }
    const versions = db.query<{ version: bigint }, []>("SELECT version FROM schema_version").all().map(r => r.version);
    if (versions.some(v => typeof v !== "bigint")) throw new StoreError("数据库版本字段不兼容");
    return versions;
  }
  private read(sid: string | null, args: Args): any {
    const allowed = sid === null ? ["year", "month", "day", "page"] : ["year", "month", "day", "requestPage", "turnPage", "expandedTurn"];
    if (Object.keys(args).some(k => !allowed.includes(k))) throw new StoreError("未知查询参数", 400);
    let period: Period;
    try { period = new Period(args, this.zone); } catch { throw new StoreError("日期条件无效：请选择有效的年、月、日", 400); }
    const deadline = performance.now() + this.timeout * 1000;
    const check = () => { if (performance.now() >= deadline) throw new StoreError("数据库读取超时，请缩小范围后重试"); };
    let db: Database | undefined;
    try {
      db = new Database(this.db, { readonly: true, create: false, strict: true, safeIntegers: true });
      db.exec("PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN");
      check();
      const versions = this.schema(db);
      const sessions = new Map<string, Row>();
      for (const row of db.query<Row, []>(`SELECT ${SESSION_FIELDS} FROM sessions`).iterate()) {
        check(); textFields(row, SESSION_FIELDS);
        if (typeof row.id !== "string" || !row.id) throw new StoreError("会话 ID 不兼容");
        sessions.set(row.id, { ...row, acc: new Metrics(), models: new Set<string>(), latest_key: null, latest_request: null });
      }
      if (sid !== null && !sessions.has(sid)) throw new StoreError("会话不存在或已被删除，请返回会话列表", 404);
      const total = new Metrics(), models = new Map<string, Metrics>(), years = new Set<number>();
      let invalid = 0n, orphan = 0n;
      for (const row of db.query<Row, []>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events`).iterate()) {
        check();
        let key = parseTime(row.created_at);
        const local = localDate(key, period.formatter);
        if (!local) { invalid++; key = null; } else years.add(local[0]);
        const session = sessions.get(row.session_id);
        if (!session) { orphan++; continue; }
        if (typeof row.model !== "string" || !row.model.trim()) throw new StoreError("请求实际模型缺失或不兼容，请检查数据库结构");
        if (typeof row.id !== "bigint") throw new StoreError("请求 ID 类型不兼容");
        textFields(row, ["session_id", "model", "created_at", "agent_id", "initiator", "finish_reason"]);
        numericFields(row, ["duration_ms", "time_to_first_token_ms", "turn_index"]);
        if (!period.contains(key)) continue;
        session.acc.add(row); session.models.add(row.model);
        if (key && (!session.latest_key || compareTime(key, session.latest_key) > 0)) {
          session.latest_key = key; session.latest_request = row.created_at;
        }
        if (sid === null || row.session_id === sid) total.add(row);
        if (sid !== null && row.session_id === sid) {
          if (!models.has(row.model)) models.set(row.model, new Metrics());
          models.get(row.model)!.add(row);
        }
      }
      const result: Row = {
        metrics: total.result(), period: period.label, timezone: this.zone, years: [...years].sort((a, b) => b - a),
        schema_versions: versions, diagnostics: { invalid_times: invalid, orphan_requests: orphan },
        diagnostics_scope: "全库（两项可能重叠；孤立请求不计入会话汇总）", source: this.db, read_at: new Date().toISOString(),
      };
      if (sid === null) {
        const rows = [...sessions.values()].filter(s => period.year === null || s.acc.calls);
        rows.sort((a, b) => {
          if (!a.latest_key || !b.latest_key) return a.latest_key ? -1 : b.latest_key ? 1 : lexical(a.id, b.id);
          return -compareTime(a.latest_key, b.latest_key) || lexical(a.id, b.id);
        });
        check();
        const page = pageNumber(args, "page");
        result.pagination = paged(BigInt(rows.length), page, 20);
        result.session_count = rows.length;
        result.sessions = rows.slice((page - 1) * 20, page * 20).map(sessionRow);
      } else {
        result.session = sessionRow(sessions.get(sid)!);
        result.models = [...models.entries()].sort(([a], [b]) => lexical(a, b)).map(([model, acc]) => ({ model, ...acc.result() }));
        this.detail(db, sid, args, period, result, check);
      }
      check(); db.exec("ROLLBACK");
      return integerStrings(result);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw sqliteError(error);
    } finally { db?.close(); }
  }
  private detail(db: Database, sid: string, args: Args, period: Period, result: Row, check: () => void) {
    db.function("tf_seconds", { deterministic: true }, (value: unknown) => { check(); return parseTime(value)?.[0] ?? null; });
    db.function("tf_fraction", { deterministic: true }, (value: unknown) => parseTime(value)?.[1] ?? "");
    db.function("tf_period", { deterministic: true }, (value: unknown) => Number(period.contains(parseTime(value))));
    const page = pageNumber(args, "requestPage");
    result.request_pagination = paged(result.metrics.calls, page, 50);
    result.requests = [];
    for (const row of db.query<Row, [string, number]>(`SELECT ${USAGE_FIELDS} FROM assistant_usage_events
      WHERE session_id=? AND tf_period(created_at) ORDER BY tf_seconds(created_at) IS NULL,
      tf_seconds(created_at),tf_fraction(created_at) COLLATE BINARY,id LIMIT 50 OFFSET ?`).iterate(sid, (page - 1) * 50)) {
      check(); const acc = new Metrics(); acc.add(row);
      result.requests.push({ ...row, total_tokens: acc.result().total_tokens, invalid_time: parseTime(row.created_at) === null });
    }
    const turnPage = pageNumber(args, "turnPage");
    const count = db.query<{ n: bigint }, [string]>("SELECT count(*) AS n FROM turns WHERE session_id=?").get(sid)!.n;
    result.turn_pagination = paged(count, turnPage, 20);
    const expanded = args.expandedTurn;
    if (expanded !== undefined && !/^[0-9]{1,20}$/.test(expanded)) throw new StoreError("展开轮次 ID 无效", 400);
    const rows = db.query<Row, [string | null, string | null, string, number]>(`SELECT id,turn_index,timestamp,
      CASE WHEN CAST(id AS TEXT)=? THEN user_message ELSE substr(user_message,1,400) END AS user_message,
      CASE WHEN CAST(id AS TEXT)=? THEN assistant_response ELSE substr(assistant_response,1,400) END AS assistant_response,
      length(user_message)>400 OR length(assistant_response)>400 AS truncated FROM turns WHERE session_id=?
      ORDER BY turn_index,id LIMIT 20 OFFSET ?`).all(expanded ?? null, expanded ?? null, sid, (turnPage - 1) * 20);
    if (expanded !== undefined && !rows.some(r => String(r.id) === expanded)) throw new StoreError("该轮次不在当前页或已被删除，请刷新", 404);
    result.turns = rows.map(row => {
      check();
      if (typeof row.id !== "bigint" || typeof row.turn_index !== "bigint") throw new StoreError("对话轮次 ID 或序号类型不兼容");
      textFields(row, ["timestamp", "user_message", "assistant_response"]);
      return { ...row, truncated: !!row.truncated && String(row.id) !== expanded };
    });
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
