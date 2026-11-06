import { beforeEach, afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Fixture } from "./support";
import { Store } from "../src/store";
import { QueryRunner } from "../src/query";
import { makeServer } from "../src/server";

let f: Fixture, store: Store;
beforeEach(() => { f = new Fixture(); f.session(); store = new Store(f.db, "UTC"); });
afterEach(() => f.close());
test("round groups aggregate all calls before paging, preserve zero/null and exact token counts without turns", () => {
  f.usage({ turn_index: 61, input_tokens: 9007199254740993n });
  f.usage({ turn_index: 61, input_tokens: 7, output_tokens: null, created_at: "2024-02-29T12:00:01Z" });
  f.usage({ turn_index: 62, created_at: "2024-02-29T12:00:02Z" });
  f.usage({ turn_index: 0, created_at: "2024-02-29T12:00:03Z" });
  f.usage({ turn_index: null, created_at: "invalid" });
  const before = readFileSync(f.db), data = store.rounds("s", {});
  expect(data.rounds.map((row: { turn_index: string | null }) => row.turn_index)).toEqual(["0", "62", "61", null]);
  expect(data.rounds[2].metrics).toMatchObject({ calls: "2", input_tokens: "9007199254741000", output_tokens: null, total_tokens: null });
  expect(data.rounds[2]).toMatchObject({ first_request: "2024-02-29T12:00:00Z", last_request: "2024-02-29T12:00:01Z",
    first_request_display: "2024-02-29 12:00:00", models: ["actual-model"] });
  expect(data.round_pagination.total).toBe("4");
  expect(data.requests).toBeUndefined();
  expect(readFileSync(f.db)).toEqual(before);
});
test("selected round metrics and call pagination stay scoped to session and period, and null is not zero", () => {
  f.session("other");
  for (let index = 0; index < 55; index++) f.usage({ turn_index: 61 });
  f.usage({ turn_index: 61, created_at: "2024-03-01T00:00:00Z" });
  f.usage({ turn_index: 62 });
  f.usage({ turn_index: 61, session_id: "other" });
  f.usage({ turn_index: null });
  f.usage({ turn_index: 0 });
  const selected = store.rounds("s", { round: "61", year: "2024", month: "2", requestPage: "2" });
  expect(selected.metrics.calls).toBe("55");
  expect(selected.models[0].calls).toBe("55");
  expect(selected.requests.length).toBe(10);
  expect(selected.request_pagination).toMatchObject({size:"10", pages:"6"});
  expect(selected.requests.every((row: { turn_index: string }) => row.turn_index === "61")).toBe(true);
  expect(selected.request_pagination.total).toBe("55");
  expect(selected.token_trend.length).toBe(55);
  expect(selected.token_trend.map((row: { id: string }) => row.id)).toEqual(Array.from({ length: 55 }, (_, index) => String(index + 1)));
  const pages = Array.from({length:6}, (_, index) => store.rounds("s", {
    round:"61", year:"2024", month:"2", requestPage:String(index+1),
  }));
  expect(pages.map(page => page.requests.length)).toEqual([10,10,10,10,10,5]);
  expect(pages.flatMap(page => page.requests.map((row: {id:string}) => row.id))).toEqual(
    Array.from({length:55}, (_, index) => String(55-index)));
  expect(pages.every(page => page.token_trend.length === 55 && page.metrics.calls === "55")).toBe(true);
  expect(() => store.rounds("s", {round:"61",year:"2024",month:"2",requestPage:"7"})).toThrow("页码超出范围");
  expect(store.session("s", {}).request_pagination.size).toBe("50");
  expect(store.session("s", {}).requests.length).toBe(50);
  expect(store.rounds("s", { round: "missing" }).requests[0].turn_index).toBeNull();
  expect(store.rounds("s", { round: "0" }).requests[0].turn_index).toBe("0");
  expect(store.rounds("s", { round: "99" }).metrics.calls).toBe("0");
  for (const round of ["", "1.5", "null", "9223372036854775808"]) expect(() => store.rounds("s", { round })).toThrow();
  expect(() => store.rounds("s", { surprise: "1" })).toThrow();
});
test("token trend preserves exact per-call metrics and chronological fractional order, with missing values and invalid times explicit", () => {
  f.usage({ id: 1, turn_index: 61, created_at: "2024-02-29T12:00:00.000000002Z", input_tokens: 9007199254740993n, output_tokens: null });
  f.usage({ id: 2, turn_index: 61, created_at: "2024-02-29T12:00:00.000000001Z", input_tokens: 0, cache_read_tokens: null });
  f.usage({ id: 3, turn_index: 61, created_at: "invalid", input_tokens: -1 });
  const before = readFileSync(f.db), data = store.rounds("s", { round: "61" });
  expect(data.token_trend.map((row: { id: string }) => row.id)).toEqual(["2", "1", "3"]);
  expect(data.token_trend[0]).toMatchObject({ input_tokens: "0", cache_read_tokens: null, invalid_time: false });
  expect(data.token_trend[1]).toMatchObject({ input_tokens: "9007199254740993", output_tokens: null,
    created_at_display: "2024-02-29 12:00:00" });
  expect(data.token_trend[2].invalid_time).toBe(true);
  expect(store.rounds("s", {}).token_trend).toBeUndefined();
  expect(store.rounds("s", { round: "99" }).token_trend).toEqual([]);
  expect(readFileSync(f.db)).toEqual(before);
});
test("group paging counts groups instead of calls and handles latest ordering beyond the first call page", () => {
  for (let index = 0; index < 55; index++) f.usage({ turn_index: index });
  f.usage({ turn_index: 0, created_at: "2024-02-29T12:00:00.000000001Z" });
  const first = store.rounds("s", {}), second = store.rounds("s", { roundPage: "6" });
  expect(first.round_pagination.total).toBe("55");
  expect(first.rounds[0].turn_index).toBe("0");
  expect(first.rounds[0].metrics.calls).toBe("2");
  expect(first.rounds.length).toBe(10);
  expect(first.round_pagination.size).toBe("10");
  expect(first.round_trend.length).toBe(55);
  expect(second.rounds.length).toBe(5);
  expect(second.round_trend).toEqual(first.round_trend);
});
test("overview trend covers all scoped rounds with unique bounded user previews and exact aggregate values", () => {
  f.session("other");
  f.turn(61, "unique round 61 ".repeat(100));
  f.turn(61, "wrong session", "other");
  f.turn(62, "duplicate one"); f.turn(62, "duplicate two");
  f.usage({turn_index:61,input_tokens:9007199254740993n,created_at:"2024-02-29T12:00:00.000000001Z"});
  f.usage({turn_index:61,input_tokens:7,output_tokens:null,created_at:"2024-02-29T12:00:01Z"});
  f.usage({turn_index:62,created_at:"2024-02-29T12:00:00.000000002Z"});
  f.usage({turn_index:63,created_at:"2024-03-01T00:00:00Z"});
  f.usage({turn_index:null,created_at:"invalid"});
  const before = readFileSync(f.db), overview = store.rounds("s",{year:"2024",month:"2"});
  expect(overview.round_trend.map((row:{turn_index:string})=>row.turn_index)).toEqual(["61","62"]);
  const first = overview.round_trend[0];
  expect(first.metrics).toMatchObject({calls:"2",input_tokens:"9007199254741000",output_tokens:null,total_tokens:null});
  expect(first.summary_status).toBe("recorded");
  expect(first.summary).toBe("unique round 61 ".repeat(100).slice(0,240));
  expect(overview.round_trend[1]).toMatchObject({summary_status:"ambiguous",summary:"本轮对话无法唯一确认。"});
  expect(store.rounds("s",{}).round_trend.find((row:{turn_index:string|null})=>row.turn_index===null))
    .toMatchObject({summary_status:"no_index",invalid_time:true});
  expect(readFileSync(f.db)).toEqual(before);
});
test("round endpoints and page navigation preserve authentication and reject unknown queries", async () => {
  f.usage({ turn_index: 61 });
  const runner = await QueryRunner.create(f.db, f.state, "UTC"), server = makeServer(runner, "synthetic-key");
  const origin = `http://127.0.0.1:${server.port}`, headers = { "X-TokenFlow-Key": "synthetic-key" };
  try {
    expect((await fetch(origin + "/api/sessions/s/rounds")).status).toBe(403);
    const response = await fetch(origin + "/api/sessions/s/rounds?round=61", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).requests[0].turn_index).toBe("61");
    expect((await fetch(origin + "/?sid=s&round=61&roundPage=2&list=")).status).toBe(200);
    expect((await fetch(origin + "/api/sessions/s/rounds?unknown=1", { headers })).status).toBe(400);
    expect((await fetch(origin + "/api/sessions/other/rounds", { headers })).status).toBe(404);
    expect((await fetch(origin + "/api/sessions/s/rounds/activities?round=61")).status).toBe(403);
    const activities = await fetch(origin + "/api/sessions/s/rounds/activities?round=61", {headers});
    expect(activities.status).toBe(200);
    expect((await activities.json()).calls[0]).toMatchObject({request_id:"1", status:"missing", tools:[]});
    for (const query of ["", "round=61&requestPage=2", "round=61&unknown=1", "round=1.5"]) {
      expect((await fetch(origin + "/api/sessions/s/rounds/activities?" + query, {headers})).status).toBe(400);
    }
    expect((await fetch(origin + "/api/sessions/other/rounds/activities?round=61", {headers})).status).toBe(404);
  } finally { await runner.close(); await server.stop(true); }
});
