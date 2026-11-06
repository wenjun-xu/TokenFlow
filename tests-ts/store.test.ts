import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { Fixture } from "./support";
import { Store, StoreError, Metrics, integerStrings } from "../src/store";
import { Period, parseTime, compareTime, systemZone } from "../src/dates";

let f: Fixture;
let store: Store;
beforeEach(() => { f = new Fixture(); f.session(); store = new Store(f.db, "UTC"); });
afterEach(() => f.close());

test("display timestamps use the frozen OS zone while preserving raw values", () => {
  const local = new Store(f.db, "Asia/Shanghai");
  f.usage({ id: 1, turn_index: 0, created_at: "2024-11-03T08:01:02.123456789Z" });
  f.usage({ id: 2, created_at: "2024-02-30T00:00:00Z" });
  f.insert("turns", { session_id: "s", turn_index: 0, timestamp: "2024-11-03 08:01:02", user_message: "synthetic" });
  const result = local.session("s", {});
  expect(result.session.created_at_display).toBe("2024-01-01 08:00:00");
  expect(result.requests[0].created_at).toBe("2024-11-03T08:01:02.123456789Z");
  expect(result.requests[0].created_at_display).toBe("2024-11-03 16:01:02");
  expect(result.requests[1].created_at_display).toBeNull();
  expect(result.turns[0].timestamp_display).toBe("2024-11-03 16:01:02");
  expect(local.request("s", "1", {}).turns[0].timestamp_display).toBe("2024-11-03 16:01:02");
  expect(result.read_at_display).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const eastern = new Store(f.db, "America/New_York");
  f.usage({ id: 3, created_at: "2024-03-10T06:59:59Z" });
  f.usage({ id: 4, created_at: "2024-03-10T07:00:00Z" });
  const requests = eastern.session("s", {}).requests;
  expect(requests.find((row: any) => row.id === "3").created_at_display).toBe("2024-03-10 01:59:59");
  expect(requests.find((row: any) => row.id === "4").created_at_display).toBe("2024-03-10 03:00:00");
});
test("detail requests and dialogue paginate newest timestamps first with invalid times last", () => {
  f.usage({ id: 1, created_at: "2024-02-29T12:00:00.0000000000009Z" });
  f.usage({ id: 2, created_at: "2024-02-29T12:00:00.0000000000001Z" });
  f.usage({ id: 3, created_at: "invalid" });
  f.usage({ id: 4, created_at: "2024-02-29T20:00:00.0000000000009+08:00" });
  for (let i = 0; i < 25; i++) f.insert("turns", {
    session_id: "s", turn_index: 24 - i, timestamp: `2024-02-29T12:00:${String(i).padStart(2, "0")}Z`,
    user_message: "synthetic",
  });
  f.insert("turns", { session_id: "s", turn_index: 26, timestamp: null });
  f.insert("turns", { session_id: "s", turn_index: 99, timestamp: "bad" });
  const first = store.session("s", {});
  expect(first.requests.map((row: any) => row.id)).toEqual(["4", "1", "2", "3"]);
  expect(first.turns[0].id).toBe("25");
  expect(first.turns[19].id).toBe("6");
  const second = store.session("s", { turnPage: "2" });
  expect(second.turns[0].id).toBe("5");
  expect(second.turns.slice(-2).map((row: any) => row.id)).toEqual(["27", "26"]);
  expect(store.request("s", "1", { view: "all", turnPage: "2" }).turns).toEqual(second.turns);
});

test("request conversation uses only a unique same-session same-index turn and lazy bodies", () => {
  f.session("other");
  f.turn(0, "x".repeat(10000));
  f.turn(0, "wrong-session", "other");
  f.turn(1, "wrong-index");
  f.usage({ id: 1, turn_index: 0 });
  f.usage({ id: 2, turn_index: 0 });
  const before = readFileSync(f.db);
  const result = store.request("s", "1", {});
  expect(result.association).toBe("matched");
  expect(result.turns.length).toBe(1);
  expect(result.turns[0].turn_index).toBe("0");
  expect(result.turns[0].user_message).toBe("x".repeat(400));
  expect(result.turns[0].truncated).toBe(true);
  expect(store.request("s", "2", {}).turns[0].id).toBe(result.turns[0].id);
  expect(store.request("s", "1", { expandedTurn: result.turns[0].id }).turns[0].user_message.length).toBe(10000);
  expect(store.request("s", "1", { full: "1" }).turns[0]).toMatchObject({ user_message: "x".repeat(10000), truncated: false });
  expect(store.session("s", { full: "1" }).turns[0].truncated).toBe(false);
  expect(() => store.request("s", "1", { full: "invalid" })).toThrow(StoreError);
  expect(readFileSync(f.db)).toEqual(before);
});
test("request conversation missing or ambiguous is explicit and never offset-guessed", () => {
  f.turn(1, "not-index-zero"); f.usage({ id: 1, turn_index: 0 });
  expect(store.request("s", "1", {})).toMatchObject({ association: "missing", turns: [] });
  f.usage({ id: 2, turn_index: null });
  expect(store.request("s", "2", {})).toMatchObject({ association: "no_index", turns: [] });
  f.turn(0, "candidate-one"); f.turn(0, "candidate-two");
  expect(store.request("s", "1", {})).toMatchObject({ association: "ambiguous", turns: [] });
  expect(() => store.request("s", "1", { expandedTurn: "2" })).toThrow(StoreError);
});
test("request dialog full-session fallback preserves unmatched turns and validates paging and IDs", () => {
  f.usage({ id: 9007199254740993n, turn_index: 0 });
  for (let i = 0; i < 25; i++) f.turn(i, "y".repeat(1000));
  const result = store.request("s", "9007199254740993", { view: "all", turnPage: "2" });
  expect(result.association).toBe("all");
  expect(result.request.id).toBe("9007199254740993");
  expect(result.turn_pagination.total).toBe("25");
  expect(result.turns.length).toBe(5);
  expect(result.turns[0].turn_index).toBe("4");
  expect(store.request("s", "9007199254740993", { view: "all", turnPage: "2", expandedTurn: result.turns[0].id })
    .turns[0].user_message.length).toBe(1000);
  for (const args of [{ view: "guess" }, { turnPage: "0" }, { unknown: "x" }, { view: "all", turnPage: "3" }]) {
    expect(() => store.request("s", "9007199254740993", args)).toThrow(StoreError);
  }
  expect(() => store.request("s", "9223372036854775808", {})).toThrow(StoreError);
  expect(() => store.request("s", "1 OR 1=1", {})).toThrow(StoreError);
  try { store.request("other", "9007199254740993", {}); throw Error("Missing session must fail"); }
  catch (error) { expect((error as StoreError).status).toBe(404); }
  expect(store.dashboard({}).metrics.calls).toBe("1");
});
test("formula, unknown, zero and actual models", () => {
  f.session("empty"); f.usage();
  expect(store.dashboard({}).metrics.total_tokens).toBe("120");
  expect(store.dashboard({}).metrics.cache_read_tokens).toBe("80");
  f.usage({ input_tokens: null, model: "second" });
  const r = store.session("s", {});
  expect(r.metrics.total_tokens).toBeNull();
  expect(r.metrics.calls).toBe("2");
  expect(r.models.length).toBe(2);
  expect(store.session("empty", {}).metrics.total_tokens).toBe("0");
});
test("cache unknown independent; exact sum beyond signed SQLite and JS integers", () => {
  f.usage({ input_tokens: 2n ** 62n, cache_read_tokens: null });
  f.usage({ input_tokens: 2n ** 62n });
  expect(store.dashboard({}).metrics).toMatchObject({
    input_tokens: String(2n ** 63n), total_tokens: String(2n ** 63n + 40n), cache_read_tokens: null,
  });
});
test("cross-day diagnostics, orphan and empty sessions", () => {
  f.session("empty");
  for (const created_at of ["2024-02-28T23:59:59Z", "2024-02-29T00:00:00Z", "bad"]) f.usage({ created_at });
  f.usage({ session_id: "orphan", created_at: null });
  const r = store.dashboard({ year: "2024", month: "2", day: "29" });
  expect(r.metrics.calls).toBe("1");
  expect(r.session_count).toBe("1");
  expect(r.diagnostics).toEqual({ invalid_times: "2", orphan_requests: "1" });
  expect(store.dashboard({}).metrics.calls).toBe("3");
  expect(store.dashboard({}).session_count).toBe("2");
});
test("arbitrary fractional precision, normalized ties and latest order", () => {
  f.usage({ id: 1, created_at: "2024-02-29T12:00:00.0000000000009Z" });
  f.usage({ id: 2, created_at: "2024-02-29T12:00:00.0000000000001Z" });
  f.usage({ id: 3, created_at: "invalid" });
  expect(store.session("s", {}).requests.map((r: any) => r.id)).toEqual(["1", "2", "3"]);
  expect(store.dashboard({}).sessions[0].latest_request).toEndWith(".0000000000009Z");
  for (const [turn_index, timestamp] of [
    [20, "2024-02-29T12:00:00.0000000000009Z"],
    [10, "2024-02-29T12:00:00.0000000000001Z"],
    [30, "2024-02-29T20:00:00.0000000000009+08:00"],
  ] as const) f.insert("turns", { session_id: "s", turn_index, timestamp });
  expect(store.session("s", {}).turns.map((row: any) => row.id)).toEqual(["3", "1", "2"]);
});
test("pagination totals, lazy body, no join multiplication", () => {
  for (let i = 0; i < 55; i++) f.usage();
  for (let i = 0; i < 25; i++) f.turn(i, "x".repeat(10000));
  for (let i = 0; i < 23; i++) f.session("empty-" + i);
  const r = store.session("s", { requestPage: "2", turnPage: "2" });
  expect(r.metrics.calls).toBe("55");
  expect(r.requests.length).toBe(5);
  expect(r.requests.map((row: any) => row.id)).toEqual(["5", "4", "3", "2", "1"]);
  expect(r.turns.length).toBe(5);
  expect(r.turns[0].user_message.length).toBe(400);
  const id = r.turns[0].id;
  expect(store.session("s", { turnPage: "2", expandedTurn: id }).turns[0].user_message.length).toBe(10000);
  expect(() => store.session("s", { expandedTurn: id })).toThrow(StoreError);
  expect(store.dashboard({}).sessions.length).toBe(20);
  expect(store.dashboard({ page: "2" }).session_count).toBe("24");
});
test("invalid queries, schema values and absent session", () => {
  for (const args of [{ month: "2" }, { year: "2024", month: "2", day: "30" },
    { year: "2024", month: "0" }, { year: "2024", month: "2", day: "0" },
    { day: "1" }, { year: "0" }, { page: "0" }, { page: "999" }, { unknown: "x" }]) {
    expect(() => store.dashboard(args)).toThrow(StoreError);
  }
  try { store.session("absent", {}); throw Error("must fail"); } catch (e) { expect((e as StoreError).status).toBe(404); }
  f.usage({ input_tokens: "not integer" });
  expect(() => store.dashboard({})).toThrow(StoreError);
  f.connection.exec("DROP TABLE turns");
  expect(() => store.dashboard({})).toThrow(StoreError);
});
test("refresh and source bytes unchanged", () => {
  f.usage(); const before = readFileSync(f.db);
  expect(store.dashboard({}).metrics.calls).toBe("1");
  expect(readFileSync(f.db)).toEqual(before);
  f.usage(); expect(store.dashboard({}).metrics.calls).toBe("2");
});
test("null actual model explicit error", () => {
  f.usage({ model: null }); expect(() => store.dashboard({})).toThrow(StoreError);
});
test("calendar year month and local timezone", () => {
  store = new Store(f.db, "Asia/Shanghai");
  for (const created_at of ["2023-12-31T16:00:00Z", "2024-01-31T16:00:00Z",
    "2024-02-29T16:00:00Z", "2024-12-31T16:00:00Z"]) f.usage({ created_at });
  expect(store.dashboard({ year: "2024" }).metrics.calls).toBe("3");
  expect(store.dashboard({ year: "2024", month: "2" }).metrics.calls).toBe("1");
  expect(store.dashboard({ year: "2024", month: "1", day: "1" }).metrics.calls).toBe("1");
  expect(store.dashboard({ year: "2022" }).session_count).toBe("0");
});
test("one explicit read snapshot and refresh concurrent committed writer", () => {
  f.connection.exec("PRAGMA journal_mode=WAL"); f.usage();
  const original = store.schema.bind(store);
  store.schema = (db) => { const versions = original(db); f.usage(); return versions; };
  const r = store.dashboard({});
  expect(r.metrics.calls).toBe("1");
  expect(r.sessions[0].metrics.calls).toBe("1");
  store.schema = original;
  expect(store.dashboard({}).metrics.calls).toBe("2");
});
test("locked corrupt deleted never empty success or create missing database", () => {
  f.connection.exec("BEGIN EXCLUSIVE");
  try { expect(() => store.dashboard({})).toThrow(StoreError); } finally { f.connection.exec("ROLLBACK"); }
  f.connection.close();
  writeFileSync(f.db, "not sqlite");
  expect(() => store.dashboard({})).toThrow(StoreError);
  unlinkSync(f.db);
  expect(() => store.dashboard({})).toThrow(StoreError);
});
test("fallbacks and full-session turn scope independent of period", () => {
  expect(store.dashboard({}).sessions[0]).toMatchObject({ title: "s", project: "Unspecified", latest_request: null });
  f.session("root", { cwd: "/" });
  expect(store.session("root", {}).session.project).toBe("/");
  f.turn(2); f.turn(0); f.usage({ created_at: "2024-01-01T12:00:00Z" });
  const r = store.session("s", { year: "2025" });
  expect(r.metrics.calls).toBe("0");
  expect(r.turns.map((t: any) => t.turn_index)).toEqual(["2", "0"]);
  expect(r.turns[0].user_message).toContain("<script>");
  f.connection.exec("DELETE FROM sessions WHERE id='s'");
  expect(() => store.session("s", {})).toThrow(StoreError);
});
test("latest missing last and stable lexical id, project fallback", () => {
  f.session("a", { cwd: "/some/project" });
  f.session("b", { repository: "owner/repo", cwd: "/ignored" });
  f.usage({ session_id: "a" }); f.usage({ session_id: "b" });
  expect(store.dashboard({}).sessions.map((r: any) => r.id)).toEqual(["a", "b", "s"]);
  expect(store.dashboard({}).sessions.map((r: any) => r.project)).toEqual(["project", "owner/repo", "Unspecified"]);
});
test("stable Python-compatible Unicode id/model ordering and ID preview", () => {
  f.session("\uE000"); f.session("😀".repeat(13));
  f.usage({ session_id: "\uE000" }); f.usage({ session_id: "😀".repeat(13) });
  expect(store.dashboard({}).sessions.slice(0, 2).map((r: any) => r.id)).toEqual(["\uE000", "😀".repeat(13)]);
  expect(store.session("😀".repeat(13), {}).session.title).toBe("😀".repeat(12) + "…");
});
test("fractional millisecond metrics retain precision under INTEGER declarations", () => {
  f.usage({ duration_ms: 1.5, time_to_first_token_ms: 12.375 });
  f.usage({ duration_ms: null, time_to_first_token_ms: null });
  expect(store.dashboard({}).metrics.total_tokens).toBe("240");
  const requests = store.session("s", {}).requests;
  expect(requests.find((row: any) => row.id === "1")).toMatchObject({ duration_ms: 1.5, time_to_first_token_ms: 12.375, turn_index: null });
  expect(requests.find((row: any) => row.id === "2")).toMatchObject({ duration_ms: null, time_to_first_token_ms: null });
  const encoded = JSON.parse(JSON.stringify(requests));
  expect(encoded.find((row: { id: string }) => row.id === "1").time_to_first_token_ms).toBe(12.375);
});
test("fractional millisecond metrics support REAL declarations", () => {
  f.connection.exec("DROP TABLE assistant_usage_events");
  f.connection.exec(`CREATE TABLE assistant_usage_events(
    id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, created_at TEXT, duration_ms REAL, time_to_first_token_ms REAL,
    turn_index INTEGER, agent_id TEXT, initiator TEXT, finish_reason TEXT)`);
  f.usage({ duration_ms: 1.5, time_to_first_token_ms: 12.375, turn_index: 2 });
  expect(store.dashboard({}).metrics.calls).toBe("1");
  expect(store.session("s", {}).requests[0]).toMatchObject({
    duration_ms: 1.5, time_to_first_token_ms: 12.375, turn_index: "2",
  });
});
test("invalid performance values and fractional turn indices fail explicitly", () => {
  f.usage({ time_to_first_token_ms: "invalid" });
  expect(() => store.dashboard({})).toThrow("time_to_first_token_ms");
  f.connection.exec("UPDATE assistant_usage_events SET time_to_first_token_ms=1.5,turn_index=1.5");
  expect(() => store.dashboard({})).toThrow("turn_index");
  f.connection.exec("UPDATE assistant_usage_events SET turn_index=1");
  f.usage({ duration_ms: Infinity });
  expect(() => store.dashboard({})).toThrow("duration_ms");
});
test("aggregation deadline and malformed performance field", () => {
  f.usage({ duration_ms: "invalid" });
  expect(() => store.dashboard({})).toThrow(StoreError);
  f.connection.exec("UPDATE assistant_usage_events SET duration_ms=1");
  expect(() => new Store(f.db, "UTC", 0).dashboard({})).toThrow(StoreError);
});
describe("strict Gregorian time", () => {
  test("strict exact parser, offsets and invalid dates", () => {
    expect(parseTime("2024-01-01 00:00:00")).toEqual(parseTime("2024-01-01T01:00:00+01:00"));
    expect(compareTime(parseTime("2024-01-01T00:00:00.0000001Z"), parseTime("2024-01-01T00:00:00.0000009Z"))).toBeLessThan(0);
    expect(parseTime("2024-01-01T00:00:00.100Z")).toEqual(parseTime("2024-01-01T00:00:00.1Z"));
    for (const value of ["2024-02-30 12:00:00", "0000-01-01T00:00:00Z", "2024-01-01T24:00:00Z",
      "2024-01-01T00:00:60Z", "2024-01-01T00:00:00+24:00", "2024-01-01"]) expect(parseTime(value)).toBeNull();
  });
  test("local DST leap and historical repeated/skipped midnight", () => {
    const cases: [string, string, string, boolean][] = [
      ["America/New_York", "2024-03-10", "2024-03-10T05:00:00Z", true],
      ["America/New_York", "2024-03-10", "2024-03-11T04:00:00Z", false],
      ["America/New_York", "2024-02-29", "2024-03-01T04:59:59Z", true],
      ["Asia/Shanghai", "2025-01-01", "2024-12-31T16:00:00Z", true],
      ["Pacific/Apia", "2011-12-30", "2011-12-30T10:00:00Z", false],
      ["America/Sao_Paulo", "2018-11-04", "2018-11-04T03:00:00Z", true],
      ["America/Havana", "2024-11-03", "2024-11-03T04:30:00Z", true],
      ["America/Havana", "2024-11-03", "2024-11-03T05:30:00Z", true],
    ];
    for (const [zone, date, instant, expected] of cases) {
      const [year, month, day] = date.split("-");
      expect(new Period({ year, month, day }, zone).contains(parseTime(instant))).toBe(expected);
    }
  });
  test("OS zone ignores process TZ, rejects unsupported discovery", () => {
    const old = process.env.TZ;
    const frozen = systemZone();
    try { process.env.TZ = "Pacific/Honolulu"; expect(systemZone()).toBe(frozen); }
    finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
    expect(() => systemZone("/missing-localtime")).toThrow();
  });
});
