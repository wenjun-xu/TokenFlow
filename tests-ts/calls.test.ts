import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./support";
import { Store } from "../src/store";
import { singleCall, roundActivities } from "../src/calls";
import { QueryRunner } from "../src/query";
import { makeServer } from "../src/server";

let f: Fixture, store: Store, path: string;
const time = "2024-02-29T12:00:00Z";
const event = (type: string, data: Record<string, unknown>, extra = {}) => ({ type, data, timestamp: time, ...extra });
beforeEach(() => {
  f = new Fixture(); f.session(); store = new Store(f.db, "UTC");
  f.usage({ id: 1, turn_index: 61, duration_ms: 12, finish_reason: "tool_calls", initiator: "agent" });
  f.usage({ id: 2, turn_index: 61, input_tokens: 101, duration_ms: 13, finish_reason: "stop", initiator: "agent" });
  path = join(f.root, "session-state", "s", "events.jsonl");
  mkdirSync(join(f.root, "session-state", "s"), { recursive: true, mode: 0o700 });
});
afterEach(() => f.close());
function usage(apiCallId: string, values = {}) {
  return event("session.usage_record", { usage: { apiCallId, model: "actual-model", inputTokens: 100,
    outputTokens: 20, cacheReadTokens: 80, duration: 12, finishReason: "tool_calls", initiator: "agent", ...values } });
}
function basic() {
  return [
    event("session.start", { sessionId: "s" }),
    usage("api-a"),
    event("assistant.message", { apiCallId: "api-a", content: "", interactionId: "same-round",
      toolRequests: [{ toolCallId: "tool-a", name: "<script>tool-a</script>", arguments: { command: "only-a" } }] }),
    event("tool.execution_start", { toolCallId: "tool-a", toolName: "<script>tool-a</script>", arguments: { command: "only-a" } }),
    event("tool.execution_complete", { toolCallId: "tool-a", success: true, result: { content: "result-a" } }),
    usage("api-b", { inputTokens: 101, duration: 13, finishReason: "stop" }),
    event("assistant.message", { apiCallId: "api-b", content: "<script>final-b</script>", interactionId: "same-round", toolRequests: [] }),
    event("tool.execution_start", { toolCallId: "unrelated", toolName: "wrong", arguments: {} }),
    event("tool.execution_complete", { toolCallId: "unrelated", success: true, result: "wrong" }),
  ];
}
function log(entries = basic()) { writeFileSync(path, entries.map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 }); }
test("same-round calls display different outputs and only their own tools without needing any turns row", async () => {
  log();
  const before = readFileSync(f.db), logBefore = readFileSync(path);
  const first = await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC");
  const second = await singleCall(f.db, "s", store.callAnchor("s", "2"), "UTC");
  expect(first.status).toBe("matched");
  expect(first.outputs).toEqual([]);
  expect(first.tools.map(tool => tool.id)).toEqual(["tool-a"]);
  expect(first.tools[0]).toMatchObject({ name: "<script>tool-a</script>", arguments: '{\n  "command": "only-a"\n}', status: "success" });
  expect(second.status).toBe("matched");
  expect(second.outputs).toEqual(["<script>final-b</script>"]);
  expect(second.tools).toEqual([]);
  expect(first.input.status).toBe("missing");
  expect(store.session("s", {}).turn_pagination.total).toBe("0");
  expect(readFileSync(f.db)).toEqual(before);
  expect(readFileSync(path)).toEqual(logBefore);
});
test("single-call matching refuses duplicate log or database fingerprints and never guesses an index", async () => {
  const entries = basic(); entries.push(usage("duplicate")); log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("ambiguous");
  log();
  f.usage({ id: 3, turn_index: 99, duration_ms: 12, finish_reason: "tool_calls", initiator: "agent" });
  expect(store.callAnchor("s", "1").candidate_count).toBe("2");
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("ambiguous");
  expect(() => store.callAnchor("other", "1")).toThrow();
  expect(() => store.callAnchor("s", "9223372036854775808")).toThrow();
});
test("partial text, pending tools and exactly identified input are preserved without a fabricated final reply", async () => {
  const entries = basic().filter(value => value.type !== "tool.execution_complete");
  entries.push(event("assistant.message", { apiCallId: "api-a", content: "partial-a", toolRequests: [] }),
    event("model.model_call_success", { callId: "api-a", requestMessages: '[{"role":"user","content":"exact input-a"}]' }));
  log(entries);
  const result = await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC");
  expect(result.outputs).toEqual(["partial-a"]);
  expect(result.tools[0]).toMatchObject({ status: "pending", result: null });
  expect(result.input).toMatchObject({ status: "recorded", content: '[{"role":"user","content":"exact input-a"}]' });
});
test("agent scope and subsecond write differences cannot pull in another agent or a different request second", async () => {
  const entries = basic();
  entries[1].timestamp = "2024-02-29T12:00:00.001Z";
  entries.push(usage("child"));
  Object.assign(entries.at(-1)!, { agentId: "child" });
  log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("matched");
  f.usage({ id: 4, turn_index: 0, agent_id: "child", duration_ms: 12, finish_reason: "tool_calls", initiator: "agent" });
  expect((await singleCall(f.db, "s", store.callAnchor("s", "4"), "UTC")).status).toBe("missing");
  entries[1].timestamp = "2024-02-29T12:00:01Z"; log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("missing");
});
test("authenticated call endpoint is session-scoped and rejects query parameters", async () => {
  log();
  const runner = await QueryRunner.create(f.db, f.state, "UTC"), server = makeServer(runner, "synthetic-key");
  const origin = `http://127.0.0.1:${server.port}`, url = origin + "/api/sessions/s/requests/1/call";
  const headers = { "X-TokenFlow-Key": "synthetic-key" };
  try {
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).tools.map((tool: { id: string }) => tool.id)).toEqual(["tool-a"]);
    expect((await fetch(url + "?view=all", { headers })).status).toBe(400);
    expect((await fetch(origin + "/api/sessions/other/requests/1/call", { headers })).status).toBe(404);
  } finally { await runner.close(); await server.stop(true); }
});
test("missing logs, reused call IDs and conflicting tool execution records are explicit instead of whole-round fallbacks", async () => {
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("unavailable");
  const entries = basic();
  entries.push(usage("api-a", { inputTokens: 555 }));
  log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("ambiguous");
  log([...basic(), event("tool.execution_complete", { toolCallId: "tool-a", success: false, error: "conflict" })]);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("ambiguous");
});
test("empty provider IDs cannot join unrelated input and multiple exact input candidates stay ambiguous", async () => {
  const entries = basic();
  entries[1] = usage("api-a", { providerCallId: "", serviceRequestId: "" });
  entries.push(event("model.model_call_success", { modelCall: { request_id: "", service_request_id: "" }, requestMessages: "unrelated input" }));
  log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).input.status).toBe("missing");
  log([...basic(), event("model.model_call_success", { callId: "api-a", requestMessages: "input-a" }),
    event("model.model_call_success", { callId: "api-a", requestMessages: "input-b" })]);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).input.status).toBe("ambiguous");
});
test("large token counts match exact decimal strings but never rounded JavaScript numbers", async () => {
  f.connection.query("UPDATE assistant_usage_events SET input_tokens=? WHERE id=1").run(9007199254740993n);
  const entries = basic();
  entries[1] = usage("api-a", { inputTokens: "9007199254740993" });
  log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("matched");
  entries[1] = usage("api-a", { inputTokens: Number("9007199254740993") });
  log(entries);
  expect((await singleCall(f.db, "s", store.callAnchor("s", "1"), "UTC")).status).toBe("missing");
});
test("round activity batches the same unique per-call association without returning full inputs, outputs, parameters or results", async () => {
  const entries = basic();
  entries[2] = event("assistant.message", { apiCallId: "api-a", content: "private output", toolRequests: [
    {toolCallId: "tool-a", name: "functions.skill", arguments: {skill: "ponytail"}}] });
  entries[3] = event("tool.execution_start", {toolCallId: "tool-a", toolName: "functions.skill", arguments: {skill: "ponytail"}});
  entries[4] = event("tool.execution_complete", {toolCallId: "tool-a", success: true, result: "private tool result"});
  log(entries);
  const before = readFileSync(f.db), logBefore = readFileSync(path);
  const data = await roundActivities(f.db, "s", store.roundAnchors("s", {round: "61"}), "UTC");
  expect(data.calls.map(call => call.request_id)).toEqual(["1", "2"]);
  expect(data.calls[0]).toMatchObject({status: "matched", tools: [{name: "functions.skill", summary: "加载 ponytail", status: "success", kind: "skill"}]});
  expect(data.calls[1]).toMatchObject({status: "matched", tools: []});
  expect(JSON.stringify(data)).not.toMatch(/private output|private tool result|exact input|"arguments"|"outputs"|"result"/);
  expect(readFileSync(f.db)).toEqual(before);
  expect(readFileSync(path)).toEqual(logBefore);
  f.usage({id: 3, turn_index: 62, duration_ms: 12, finish_reason: "tool_calls", initiator: "agent"});
  const duplicate = await roundActivities(f.db, "s", store.roundAnchors("s", {round: "61"}), "UTC");
  expect(duplicate.calls[0].status).toBe("ambiguous");
});
