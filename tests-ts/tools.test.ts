import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./support";
import { Store } from "../src/store";
import { toolActivity } from "../src/tools";
import { QueryRunner } from "../src/query";
import { makeServer } from "../src/server";

let f: Fixture, path: string;
beforeEach(() => {
  f = new Fixture(); f.session(); f.turn(0, "synthetic unique user");
  path = join(f.root, "session-state", "s", "events.jsonl");
  mkdirSync(join(f.root, "session-state", "s"), { recursive: true, mode: 0o700 });
});
afterEach(() => f.close());
const record = (type: string, data: Record<string, unknown>, extra = {}) => ({ type, data, timestamp: "2024-11-03T08:01:02Z", ...extra });
function log(entries: object[], tail = "") { writeFileSync(path, entries.map(value => JSON.stringify(value)).join("\n") + "\n" + tail, { mode: 0o600 }); }
function basic() {
  return [record("session.start", { sessionId: "s" }),
    record("user.message", { content: "synthetic unique user", interactionId: "round" }),
    record("assistant.turn_start", { turnId: "model-turn", interactionId: "round" })];
}
test("tool activity uses unique user message and explicit round IDs; previews, expansion and paging are read-only", async () => {
  const entries = basic();
  for (let i = 0; i < 23; i++) entries.push(
    record("tool.execution_start", { toolCallId: `call-${i}`, toolName: "<script>synthetic tool</script>", turnId: "model-turn", arguments: { text: "x".repeat(1000) } }),
    record("tool.execution_complete", { toolCallId: `call-${i}`, interactionId: "round", success: i !== 1, result: { content: "y".repeat(1000) } }));
  entries.push(record("tool.execution_start", { toolCallId: "other", toolName: "wrong", arguments: {} }),
    record("tool.execution_complete", { toolCallId: "other", interactionId: "other-round", success: true, result: "wrong" }),
    record("tool.execution_complete", { toolCallId: "subagent", interactionId: "round", success: true, result: "wrong" }, { agentId: "child" }));
  log(entries, '{"type":');
  const before = readFileSync(path), anchor = new Store(f.db, "UTC").toolAnchor("s", "1");
  const first = await toolActivity(f.db, "s", anchor, {}, "Asia/Shanghai");
  expect(first.status).toBe("matched");
  expect(first.pagination.total).toBe("23");
  expect(first.partial_tail).toBe(true);
  expect(first.tools[0]).toMatchObject({ name: "<script>synthetic tool</script>", timestamp_display: "2024-11-03 16:01:02", truncated: true });
  expect(first.tools[0].arguments?.length).toBe(400);
  expect(first.tools[1].status).toBe("failed");
  const full = await toolActivity(f.db, "s", anchor, { full: "1" }, "UTC");
  expect(full.tools[0].truncated).toBe(false);
  expect(full.tools[0].arguments?.length).toBeGreaterThan(1000);
  expect(full.tools[0].result?.length).toBeGreaterThan(1000);
  await expect(toolActivity(f.db, "s", anchor, { full: "invalid" }, "UTC")).rejects.toThrow();
  const last = await toolActivity(f.db, "s", anchor, { page: "2", expandedTool: "call-20" }, "UTC");
  expect(last.tools.length).toBe(3);
  expect(last.tools[0].result?.length).toBeGreaterThan(1000);
  await expect(toolActivity(f.db, "s", anchor, { expandedTool: "other" }, "UTC")).rejects.toThrow();
  await expect(toolActivity(f.db, "s", anchor, { unknown: "x" }, "UTC")).rejects.toThrow();
  expect(() => new Store(f.db, "UTC").toolAnchor("other", "1")).toThrow();
  expect(readFileSync(path)).toEqual(before);
});
test("tool activity reports missing or repeated user messages and pending calls without inventing results", async () => {
  const entries = basic();
  entries.push(record("tool.execution_start", { toolCallId: "pending", toolName: "native", turnId: "model-turn", arguments: {} }));
  log(entries);
  expect((await toolActivity(f.db, "s", "synthetic unique user", {}, "UTC")).tools[0]).toMatchObject({ status: "pending", result: null });
  expect((await toolActivity(f.db, "s", "not present", {}, "UTC")).status).toBe("missing");
  entries.push(record("user.message", { content: "synthetic unique user", interactionId: "different-round" }));
  log(entries);
  expect((await toolActivity(f.db, "s", "synthetic unique user", {}, "UTC"))).toMatchObject({ status: "ambiguous", tools: [] });
  expect((await toolActivity(f.db, "s", null, {}, "UTC")).status).toBe("unavailable");
  log([...basic(), record("user.message", { content: "different user", interactionId: "round" })]);
  expect((await toolActivity(f.db, "s", "synthetic unique user", {}, "UTC"))).toMatchObject({ status: "matched", scope: "interaction", tools: [] });
});
test("steering messages share explicit interaction tools without losing pending calls or leaking reused model turn IDs", async () => {
  log([
    record("session.start", {sessionId:"s"}),
    record("user.message", {content:"unrelated",interactionId:"previous"}),
    record("assistant.turn_start", {turnId:"reused",interactionId:"previous"}),
    record("tool.execution_start", {toolCallId:"unrelated-pending",turnId:"reused",toolName:"wrong",arguments:{}}),
    ...basic().slice(1),
    record("assistant.turn_start", {turnId:"reused",interactionId:"round"}),
    record("assistant.message", {turnId:"reused",interactionId:"round",toolRequests:[{toolCallId:"first"}]}),
    record("tool.execution_start", {toolCallId:"first",turnId:"reused",toolName:"view",arguments:{path:"first"}}),
    record("tool.execution_complete", {toolCallId:"first",turnId:"reused",interactionId:"round",success:true,result:"first result"}),
    record("user.message", {content:"steering user",interactionId:"round",delivery:"steering",turnId:"next"}),
    record("assistant.turn_start", {turnId:"next",interactionId:"round"}),
    record("tool.execution_start", {toolCallId:"pending",turnId:"next",toolName:"bash",arguments:{command:"test"}}),
  ]);
  const original = await toolActivity(f.db,"s","synthetic unique user",{full:"1"},"UTC");
  const steering = await toolActivity(f.db,"s","steering user",{full:"1"},"UTC");
  expect(original).toMatchObject({status:"matched",scope:"interaction",pagination:{total:"2"}});
  expect(original.message).toContain("messages added during execution");
  expect(original.tools.map(tool=>tool.id)).toEqual(["first","pending"]);
  expect(original.tools[1]).toMatchObject({status:"pending",result:null});
  expect(steering.tools).toEqual(original.tools);
});
test("identical user and tool records in one interaction deduplicate, but conflicting interaction evidence is rejected", async () => {
  const start = record("tool.execution_start", {toolCallId:"one",turnId:"model-turn",toolName:"view",arguments:{}});
  const complete = record("tool.execution_complete", {toolCallId:"one",interactionId:"round",success:true,result:"result"});
  log([...basic(),basic()[1],start,start,complete,complete]);
  const data = await toolActivity(f.db,"s","synthetic unique user",{},"UTC");
  expect(data).toMatchObject({status:"matched",pagination:{total:"1"}});
  log([...basic(),start,{...complete,data:{...complete.data,interactionId:"wrong"}}]);
  expect(await toolActivity(f.db,"s","synthetic unique user",{},"UTC")).toMatchObject({status:"ambiguous",tools:[]});
});
test("tool activity refuses unsafe paths, wrong sessions and malformed committed records", async () => {
  expect((await toolActivity(f.db, "../s", "synthetic", {}, "UTC")).status).toBe("unavailable");
  expect((await toolActivity(f.db, "absent", "synthetic", {}, "UTC")).status).toBe("unavailable");
  log([record("session.start", { sessionId: "other" })]);
  await expect(toolActivity(f.db, "s", "synthetic", {}, "UTC")).rejects.toThrow();
  writeFileSync(path, "not-json\n");
  await expect(toolActivity(f.db, "s", "synthetic", {}, "UTC")).rejects.toThrow();
  symlinkSync(join(f.root, "session-state", "s"), join(f.root, "session-state", "alias"));
  await expect(toolActivity(f.db, "alias", "synthetic", {}, "UTC")).rejects.toThrow();
});
test("authenticated tool endpoint reads synthetic logs inside the isolated worker without changing source files", async () => {
  log([...basic(),
    record("tool.execution_start", { toolCallId: "call", toolName: "native", turnId: "model-turn", arguments: { command: "synthetic" } }),
    record("tool.execution_complete", { toolCallId: "call", interactionId: "round", success: true, result: { content: "synthetic result" } })]);
  const before = readFileSync(f.db), logBefore = readFileSync(path);
  const runner = await QueryRunner.create(f.db, f.state, "UTC");
  const server = makeServer(runner, "synthetic-key");
  const origin = `http://127.0.0.1:${server.port}`, url = origin + "/api/sessions/s/turns/1/tools";
  const headers = { "X-TokenFlow-Key": "synthetic-key" };
  try {
    expect((await fetch(url)).status).toBe(403);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).tools[0]).toMatchObject({ name: "native", arguments: '{\n  "command": "synthetic"\n}', status: "success" });
    for (const suffix of ["?page=0", "?expandedTool=other", "?page=1&page=2", "?unknown=x"]) {
      expect((await fetch(url + suffix, { headers })).status).toBe(suffix.includes("expandedTool") ? 404 : 400);
    }
    expect((await fetch(origin + "/api/sessions/other/turns/1/tools", { headers })).status).toBe(404);
    expect(readFileSync(f.db)).toEqual(before);
    expect(readFileSync(path)).toEqual(logBefore);
  } finally { await runner.close(); await server.stop(true); }
});
