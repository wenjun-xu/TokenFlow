import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Fixture } from "../tests-ts/support";

const project = resolve(import.meta.dir, "..");
const workspace = basename(dirname(project)) === ".publish" ? resolve(project, "../..") : project;
const home = join(workspace, ".h");
if (Buffer.byteLength(join(home, "Library/Application Support/TokenFlow/c")) >= 104) {
  throw new Error("Synthetic HOME exceeds the macOS socket path limit");
}
const binary = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: bun scripts/verify_native.ts /path/to/extracted/tokenflow [expected-version]");
const expectedVersion = process.argv[3] ?? "0.2.1";
mkdirSync(home, { mode: 0o700 });
const fixture = new Fixture();
const env = { PATH: "/usr/bin:/bin", HOME: home };
async function cli(args: string[]) {
  const process = Bun.spawn([binary, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  return { out, err, code };
}
try {
  fixture.session();
  fixture.usage({ duration_ms: 1.5, time_to_first_token_ms: 12.375, turn_index: 0 });
  const dialogue = "<script>synthetic linked dialogue</script>" + "x".repeat(600);
  fixture.turn(0, dialogue);
  const eventPath = join(fixture.root, "session-state", "s", "events.jsonl");
  mkdirSync(dirname(eventPath), { recursive: true, mode: 0o700 });
  writeFileSync(eventPath, [
    { type: "session.start", data: { sessionId: "s" } },
    { type: "user.message", data: { content: dialogue, interactionId: "round" } },
    { type: "assistant.turn_start", data: { turnId: "model-turn", interactionId: "round" } },
    { type: "session.usage_record", timestamp: "2024-02-29T12:00:00Z", data: { usage: {
      apiCallId: "native-call", model: "actual-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, duration: 1.5 } } },
    { type: "assistant.message", data: { apiCallId: "native-call", content: "Synthetic single-call output",
      toolRequests: [{ toolCallId: "tool", name: "native", arguments: { command: "synthetic" } }] } },
    { type: "tool.execution_start", data: { toolCallId: "tool", turnId: "model-turn", toolName: "native", arguments: { command: "synthetic" } } },
    { type: "tool.execution_complete", data: { toolCallId: "tool", interactionId: "round", success: true, result: { content: "synthetic result" + "x".repeat(600) } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", { mode: 0o600 });
  const eventsBefore = readFileSync(eventPath);
  fixture.connection.exec("PRAGMA journal_mode=WAL");
  fixture.usage();
  const before = ["", "-wal", "-shm"].map(suffix => readFileSync(fixture.db + suffix));
  assert.equal((await cli(["--version"])).out.trim(), expectedVersion);
  const missing = await cli(["start", "--db", join(home, "missing.db"), "--no-browser"]);
  assert.equal(missing.code, 1);
  const started = await cli(["start", "--db", fixture.db, "--no-browser"]);
  assert.equal(started.code, 0, started.err);
  const info = JSON.parse(readFileSync(join(home, "Library/Application Support/TokenFlow/state.json"), "utf8")) as { port: number; token: string };
  const origin = `http://127.0.0.1:${info.port}`;
  const headers = { "X-TokenFlow-Key": info.token };
  for (const query of ["sid=s&list=", "year=2024&month=2&day=29&page=3",
    "sid=s&list=year%3D2024%26page%3D3&requestPage=2&turnPage=2&expandedTurn=1",
    "sid=s&round=0&roundPage=1&list="]) {
    const page = await fetch(origin + "/?" + query);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Type") ?? "", /text\/html/);
  }
  const response = await fetch(origin + "/api/dashboard", { headers });
  assert.equal(response.status, 200);
  const data = await response.json() as { metrics: { total_tokens: string; calls: string } };
  assert.equal(data.metrics.total_tokens, "240");
  assert.equal(data.metrics.calls, "2");
  const detail = await (await fetch(origin + "/api/sessions/s", { headers })).json() as {
    requests: Array<{ id: string; created_at_display: string; duration_ms: number | string | null; time_to_first_token_ms: number | string | null }>;
  };
  assert.deepEqual(detail.requests.map(row => row.id), ["2", "1"]);
  assert.match(detail.requests[1]!.created_at_display, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(detail.requests[1]?.duration_ms, 1.5);
  assert.equal(detail.requests[1]?.time_to_first_token_ms, 12.375);
  const roundsResponse = await fetch(origin + "/api/sessions/s/rounds", { headers });
  assert.equal(roundsResponse.status, 200);
  const rounds = await roundsResponse.json() as { rounds: Array<{ turn_index: string | null; metrics: { calls: string } }> };
  assert.equal(rounds.rounds.length, 2);
  assert.equal(rounds.rounds.find(row => row.turn_index === "0")?.metrics.calls, "1");
  const roundResponse = await fetch(origin + "/api/sessions/s/rounds?round=0", { headers });
  assert.equal(roundResponse.status, 200);
  const round = await roundResponse.json() as { metrics: { calls: string }; requests: Array<{ id: string }>;
    token_trend: Array<{ id: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; created_at_display: string }> };
  assert.equal(round.metrics.calls, "1");
  assert.deepEqual(round.requests.map(row => row.id), ["1"]);
  assert.equal(round.token_trend.length, 1);
  assert.deepEqual([round.token_trend[0]!.id, round.token_trend[0]!.input_tokens, round.token_trend[0]!.output_tokens, round.token_trend[0]!.cache_read_tokens],
    ["1", "100", "20", "80"]);
  assert.match(round.token_trend[0]!.created_at_display, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  const conversationResponse = await fetch(origin + "/api/sessions/s/requests/1?full=1", { headers });
  assert.equal(conversationResponse.status, 200);
  const conversation = await conversationResponse.json() as {
    association: string; turns: Array<{ turn_index: string; user_message: string }>;
  };
  assert.equal(conversation.association, "matched");
  assert.equal(conversation.turns[0]?.turn_index, "0");
  assert.equal(conversation.turns[0]?.user_message, dialogue);
  const toolsResponse = await fetch(origin + "/api/sessions/s/turns/1/tools?full=1", { headers });
  assert.equal(toolsResponse.status, 200);
  const tools = await toolsResponse.json() as { status: string; tools: Array<{ name: string; result: string }> };
  assert.equal(tools.status, "matched");
  assert.equal(tools.tools[0]?.name, "native");
  assert.match(tools.tools[0]!.result, /synthetic result/);
  assert(tools.tools[0]!.result.length > 600);
  const callResponse = await fetch(origin + "/api/sessions/s/requests/1/call", { headers });
  assert.equal(callResponse.status, 200);
  const call = await callResponse.json() as { status: string; outputs: string[]; tools: Array<{ name: string; result: string }>; input: { status: string } };
  assert.equal(call.status, "matched");
  assert.deepEqual(call.outputs, ["Synthetic single-call output"]);
  assert.equal(call.tools[0]?.name, "native");
  assert(call.tools[0]!.result.length > 600);
  assert.equal(call.input.status, "missing");
  assert.equal((await fetch(origin + "/api/sessions/s/requests/1/call")).status, 403);
  const activitiesResponse = await fetch(origin + "/api/sessions/s/rounds/activities?round=0", {headers});
  assert.equal(activitiesResponse.status, 200);
  const activities = await activitiesResponse.json() as {calls:Array<{request_id:string;status:string;tools:Array<{name:string;summary:string}>}>};
  assert.equal(activities.calls.length, 1);
  assert.equal(activities.calls[0]?.request_id, "1");
  assert.equal(activities.calls[0]?.status, "matched");
  assert.equal(activities.calls[0]?.tools[0]?.name, "native");
  assert(!/Synthetic single-call output|Synthetic tool result|"arguments"|"outputs"|"result"/.test(JSON.stringify(activities)));
  assert.equal((await fetch(origin + "/api/sessions/s/rounds/activities?round=0")).status, 403);
  assert.deepEqual(readFileSync(eventPath), eventsBefore);
  assert.equal(await (await fetch(origin + "/app.js")).text(), readFileSync(join(import.meta.dir, "../web/app.js"), "utf8"));
  assert.equal(await (await fetch(origin + "/tool-summary.js")).text(), readFileSync(join(import.meta.dir, "../web/tool-summary.js"), "utf8"));
  assert.equal((await fetch(origin + "/api/dashboard")).status, 403);
  for (const [index, suffix] of ["", "-wal", "-shm"].entries()) {
    assert.deepEqual(readFileSync(fixture.db + suffix), before[index]);
  }
  assert.match((await cli(["start", "--db", fixture.db, "--no-browser"])).out, /复用/);
  assert.equal((await cli(["stop"])).code, 0);
  await assert.rejects(fetch(origin));
  assert.match((await cli(["stop"])).out, /未运行/);
  console.log("Public native CLI passed: no runtime on PATH, active WAL unchanged, total=240, embedded UI, authentication, reuse and verified stop.");
} finally {
  const stopped = await cli(["stop"]);
  if (stopped.code !== 0) throw new Error("Synthetic native service could not be stopped; preserving test HOME");
  fixture.close();
  rmSync(home, { recursive: true });
}
