import { StoreError, type CallAnchor, type CallRequest } from "./store";
import { sessionEvents, MissingEventsError, isRecord, stringValue, contentText, type SessionEvent, type EventData } from "./events";
import { parseTime, formatTime, zoneFormatter } from "./dates";
import { toolSynopsis, safeLabel } from "./tool-summary.js";

type Status = "matched" | "missing" | "ambiguous" | "unavailable";
type Tool = { id: string; name: string | null; arguments: string | null; result: string | null;
  status: string; timestamp: string | null; timestamp_display: string | null; truncated: false };
export type CallDetail = { status: Status; message: string; api_call_id: string | null; outputs: string[]; tools: Tool[];
  partial_tail: boolean; input: { status: "recorded" | "missing" | "ambiguous"; content: string | null; message: string } };
function sameInteger(value: unknown, expected: string | null): boolean {
  if (expected === null) return value === null || value === undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) && String(value) === expected;
  return typeof value === "string" && /^-?\d+$/.test(value) && String(BigInt(value)) === expected;
}
function metric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  return null;
}
function matches(event: SessionEvent, request: CallRequest): boolean {
  const usage = event.data.usage;
  if (!isRecord(usage)) return false;
  const rowTime = parseTime(request.created_at), eventTime = parseTime(event.timestamp);
  return !!rowTime && !!eventTime && rowTime[0] === eventTime[0]
    && usage.model === request.model && sameInteger(usage.inputTokens, request.input_tokens)
    && sameInteger(usage.outputTokens, request.output_tokens) && sameInteger(usage.cacheReadTokens, request.cache_read_tokens)
    && metric(usage.duration) === metric(request.duration_ms)
    && stringValue(usage.initiator) === request.initiator && stringValue(usage.finishReason) === request.finish_reason;
}

const missingInput: CallDetail["input"] = { status: "missing", content: null,
    message: "The full input context for this Call was not recorded. A user message or an entire Round cannot substitute for it." };
const unavailable = (status: Status, message: string): CallDetail => ({
    status, message, api_call_id: null, outputs: [], tools: [], input: missingInput, partial_tail: false,
  });
function anchorError(sid: string, anchor: CallAnchor): CallDetail | null {
  if (anchor.request.session_id !== sid) throw new StoreError("The request does not belong to this Session", 404);
  if (anchor.candidate_count !== "1") return unavailable(anchor.candidate_count === "0" ? "missing" : "ambiguous",
    "Database timestamps and metrics do not uniquely identify this Call. A Round index or whole-Round content cannot substitute for it.");
  if (anchor.request.input_tokens === null || anchor.request.output_tokens === null || metric(anchor.request.duration_ms) === null) {
    return unavailable("missing", "Required request metrics are missing; this model Call cannot be reliably linked.");
  }
  return null;
}
type Scope = { usages: SessionEvent[]; messages: SessionEvent[]; modelCalls: SessionEvent[];
  callIds: Map<string, number>; starts: Map<string, SessionEvent[]>; completes: Map<string, SessionEvent[]> };
type CallLog = { scopes: Map<string | null, Scope>; partial_tail: boolean };
function emptyScope(): Scope {
  return { usages: [], messages: [], modelCalls: [], callIds: new Map(), starts: new Map(), completes: new Map() };
}
async function readCallLog(db: string, sid: string): Promise<CallLog> {
  const scopes = new Map<string | null, Scope>();
  const diagnostics = { partial_tail: false };
  for await (const event of sessionEvents(db, sid, diagnostics)) {
      if (!["session.usage_record", "assistant.message", "model.model_call_success", "tool.execution_start", "tool.execution_complete"].includes(event.type)) continue;
      let scope = scopes.get(event.agentId);
      if (!scope) { scope = emptyScope(); scopes.set(event.agentId, scope); }
      if (event.type === "session.usage_record") {
        scope.usages.push(event);
        const id = isRecord(event.data.usage) ? stringValue(event.data.usage.apiCallId) : null;
        if (id) scope.callIds.set(id, (scope.callIds.get(id) ?? 0) + 1);
      }
      if (event.type === "assistant.message") scope.messages.push(event);
      if (event.type === "model.model_call_success") scope.modelCalls.push(event);
      if (event.type === "tool.execution_start" || event.type === "tool.execution_complete") {
        const id = stringValue(event.data.toolCallId);
        if (!id) continue;
        const target = event.type === "tool.execution_start" ? scope.starts : scope.completes;
        const records = target.get(id) ?? [];
        records.push(event); target.set(id, records);
      }
  }
  return { scopes, partial_tail: diagnostics.partial_tail };
}
function resolveCall(sid: string, anchor: CallAnchor, zone: string, log: CallLog | null): CallDetail {
  const problem = anchorError(sid, anchor);
  if (problem) return problem;
  if (!log) return unavailable("unavailable", new MissingEventsError().message);
  const scope = log.scopes.get(anchor.request.agent_id) ?? emptyScope();
  const { messages, modelCalls, callIds, starts, completes } = scope;
  const candidates = scope.usages.filter(event => matches(event, anchor.request));
  if (candidates.length !== 1) return unavailable(candidates.length ? "ambiguous" : "missing",
    candidates.length ? "Multiple logged Calls have the same timestamp and metrics; no unique match is possible." : "No logged Call uniquely matches this request.");
  const usage = candidates[0].data.usage;
  if (!isRecord(usage)) throw new StoreError("Incompatible model usage log structure");
  const apiCallId = stringValue(usage.apiCallId);
  if (!apiCallId) return unavailable("missing", "The log has no apiCallId for this Call; its Output and tool Calls cannot be linked.");
  if (callIds.get(apiCallId) !== 1) return unavailable("ambiguous", "Multiple Calls reuse this apiCallId; the individual Output cannot be identified.");
  const replies = messages.filter(event => event.data.apiCallId === apiCallId);
  if (!replies.length) return unavailable("missing", "No model Output has been recorded for this Call yet. Reopen it later.");
  const outputs: string[] = [], requests = new Map<string, EventData>();
  for (const reply of replies) {
    if (reply.data.content !== null && reply.data.content !== undefined && typeof reply.data.content !== "string") {
      throw new StoreError("Incompatible model Output structure");
    }
    if (typeof reply.data.content === "string" && reply.data.content.length) outputs.push(reply.data.content);
    if (reply.data.toolRequests !== undefined && reply.data.toolRequests !== null && !Array.isArray(reply.data.toolRequests)) {
      throw new StoreError("Incompatible tool Call instruction structure");
    }
    if (!Array.isArray(reply.data.toolRequests)) continue;
    for (const tool of reply.data.toolRequests) {
      if (!isRecord(tool) || !stringValue(tool.toolCallId)) throw new StoreError("The tool Call instruction is missing an ID");
      const id = String(tool.toolCallId);
      if (requests.has(id) && JSON.stringify(requests.get(id)) !== JSON.stringify(tool)) {
        return unavailable("ambiguous", "This Output contains conflicting tool Call IDs; linking was stopped.");
      }
      requests.set(id, tool);
    }
  }
  const formatter = zoneFormatter(zone), tools: Tool[] = [];
  for (const [id, request] of requests) {
    const startCandidates = starts.get(id) ?? [], endCandidates = completes.get(id) ?? [];
    if (startCandidates.length > 1 || endCandidates.length > 1) return unavailable("ambiguous", "This tool Call has duplicate execution records; no unique match is possible.");
    const start = startCandidates[0], end = endCandidates[0];
    if (start && ((stringValue(start.data.toolName) && stringValue(request.name) && start.data.toolName !== request.name)
      || (start.data.arguments !== undefined && request.arguments !== undefined && contentText(start.data.arguments) !== contentText(request.arguments)))) {
      return unavailable("ambiguous", "The tool instruction and execution records disagree; linking was stopped.");
    }
    const timestamp = start?.timestamp ?? end?.timestamp ?? null;
    tools.push({ id, name: stringValue(request.name) ?? stringValue(start?.data.toolName),
      arguments: contentText(request.arguments ?? start?.data.arguments), result: contentText(end?.data.result ?? end?.data.error),
      status: !end ? "pending" : end.data.success === true ? "success" : end.data.success === false ? "failed" : "unknown",
      timestamp, timestamp_display: formatTime(timestamp, formatter), truncated: false });
  }
  const inputCandidates = modelCalls.filter(event => {
    const record = event.data, modelCall = isRecord(record.modelCall) ? record.modelCall : {};
    const providerId = stringValue(usage.providerCallId), serviceId = stringValue(usage.serviceRequestId);
    return record.callId === apiCallId || (!!providerId && modelCall.request_id === providerId)
      || (!!serviceId && (record.serviceRequestId === serviceId || modelCall.service_request_id === serviceId));
  });
  let input = missingInput;
  if (inputCandidates.length > 1) input = { status: "ambiguous", content: null, message: "Multiple full Input records match this Call; no unique match is possible." };
  else if (inputCandidates.length === 1 && (typeof inputCandidates[0].data.requestMessages === "string" || Array.isArray(inputCandidates[0].data.requestMessages))) {
    input = { status: "recorded", content: contentText(inputCandidates[0].data.requestMessages), message: "Recorded Input for this Call, linked by Call ID." };
  }
  return { status: "matched", message: "Uniquely matched by Session, Agent, request second, model, and usage/duration metrics, then linked to this Call's Output and execution results by apiCallId and toolCallId; this is not the entire Round.",
    api_call_id: apiCallId, outputs, tools, input, partial_tail: log.partial_tail };
}
export async function singleCall(db: string, sid: string, anchor: CallAnchor, zone: string): Promise<CallDetail> {
  const problem = anchorError(sid, anchor);
  if (problem) return problem;
  try { return resolveCall(sid, anchor, zone, await readCallLog(db, sid)); }
  catch (error) {
    if (error instanceof MissingEventsError) return resolveCall(sid, anchor, zone, null);
    throw error;
  }
}
export async function roundActivities(db: string, sid: string, anchors: CallAnchor[], zone: string) {
  let log: CallLog | null = null;
  if (anchors.map(anchor => anchorError(sid, anchor)).some(problem => !problem)) {
    try { log = await readCallLog(db, sid); }
    catch (error) { if (!(error instanceof MissingEventsError)) throw error; }
  }
  return { partial_tail: log?.partial_tail ?? false, calls: anchors.map(anchor => {
    const detail = resolveCall(sid, anchor, zone, log);
    return { request_id: anchor.request.id, status: detail.status, message: detail.message, tools: detail.tools.map(tool => {
      const label = safeLabel(tool.name);
      const name = label && /^[a-zA-Z][\w.:/-]{0,159}$/.test(label) ? label : "Tool name not recorded";
      return { id: tool.id, name, summary: toolSynopsis(tool), status: tool.status, kind: name.split(/[.:]/).at(-1) === "skill" ? "skill" : "tool" };
    }) };
  }) };
}
