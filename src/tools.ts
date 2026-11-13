import { StoreError, pageNumber, paged, integerStrings } from "./store";
import { formatTime, zoneFormatter, type Args } from "./dates";
import { sessionEvents, MissingEventsError, isRecord as object, stringValue as text, contentText as body, type EventData as Data, type SessionEvent as Event } from "./events";

export async function toolActivity(db: string, sid: string, userMessage: string | null, args: Args, zone: string) {
  if (Object.keys(args).some(key => !["page", "expandedTool", "full"].includes(key))) throw new StoreError("Unknown query parameter", 400);
  if (args.full !== undefined && args.full !== "1") throw new StoreError("Invalid tool content read parameter", 400);
  const page = pageNumber(args, "page");
  const expanded = args.expandedTool;
  if (expanded !== undefined && (expanded.length > 256 || !expanded.length)) throw new StoreError("Invalid tool Call ID", 400);
  const unavailable = (message: string, status = "unavailable") => ({ status, message, partial_tail: false, tools: [], pagination: integerStrings(paged(0n, page, 20)) });
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) return unavailable("The Session ID is not valid for a local tool log path");
  if (userMessage === null || !userMessage.length) return unavailable("This Round has no user message; tool activity cannot be linked");
  try {
    const users: Data[] = [], contexts: Array<{ turnId: unknown; interactionId: unknown; toolRequests: unknown[] }> = [];
    const userInteractions = new Map<string, number>();
    const turnInteractions = new Map<string, string>(), startInteractions = new Map<string, string>();
    const starts = new Map<string, Event>(), completions = new Map<string, Event>();
    const diagnostics = { partial_tail: false };
    for await (const item of sessionEvents(db, sid, diagnostics)) {
      if (item.agentId) continue;
      if (item.type === "user.message" && item.data.content === userMessage) users.push(item.data);
      if (item.type === "user.message" && typeof item.data.interactionId === "string") {
        const id = item.data.interactionId;
        userInteractions.set(id, (userInteractions.get(id) ?? 0) + 1);
      }
      if (item.type === "assistant.turn_start" || item.type === "assistant.message") {
        const turn = text(item.data.turnId), interaction = text(item.data.interactionId);
        if (turn && interaction) turnInteractions.set(turn, interaction);
        contexts.push({
          turnId: item.data.turnId, interactionId: item.data.interactionId,
          toolRequests: Array.isArray(item.data.toolRequests) ? item.data.toolRequests.map(value => object(value) ? value.toolCallId : null) : [],
        });
      }
      if (item.type === "tool.execution_start" || item.type === "tool.execution_complete") {
        const id = text(item.data.toolCallId);
        if (!id) throw new StoreError("A local tool record is missing its Call ID");
        const target = item.type === "tool.execution_start" ? starts : completions;
        if (target.has(id)) {
          if (JSON.stringify(target.get(id)) === JSON.stringify(item)) continue;
          throw new StoreError("Conflicting records have the same tool Call ID; no unique match is possible");
        }
        target.set(id, item);
        if (item.type === "tool.execution_start") {
          const interaction = text(item.data.interactionId) ?? turnInteractions.get(text(item.data.turnId) ?? "");
          if (interaction) startInteractions.set(id, interaction);
        }
      }
    }
    if (!users.length) return unavailable("The log has no matching user message", "missing");
    const interaction = text(users[0].interactionId);
    if (!interaction) return unavailable("The Round log has no interactionId; tool activity cannot be linked");
    if (users.some(user => user.interactionId !== interaction)) return unavailable("The same user message occurs in different interactions; tool ownership cannot be uniquely identified", "ambiguous");
    const shared = (userInteractions.get(interaction) ?? 0) > 1;
    const toolIds = new Set<string>();
    for (const context of contexts) {
      if (context.interactionId !== interaction) continue;
      for (const id of context.toolRequests) if (typeof id === "string") toolIds.add(id);
    }
    for (const [id, scope] of startInteractions) if (scope === interaction) toolIds.add(id);
    for (const [id, complete] of completions) if (complete.data.interactionId === interaction) toolIds.add(id);
    for (const id of toolIds) {
      const scope = startInteractions.get(id), completeScope = text(completions.get(id)?.data.interactionId);
      if ((scope && scope !== interaction) || (completeScope && completeScope !== interaction)) {
        return unavailable("Tool start and end records refer to different interactions; ownership cannot be confirmed", "ambiguous");
      }
    }
    const formatter = zoneFormatter(zone);
    const records = [...toolIds].flatMap(id => {
      const start = starts.get(id), complete = completions.get(id);
      return [{
        id, name: text(start?.data.toolName), timestamp: start?.timestamp ?? complete?.timestamp ?? null,
        timestamp_display: formatTime(start?.timestamp ?? complete?.timestamp, formatter),
        status: !complete ? "pending" : complete.data.success === true ? "success" : complete.data.success === false ? "failed" : "unknown",
        arguments: body(start?.data.arguments), result: body(complete?.data.result ?? complete?.data.error),
      }];
    });
    const pagination = paged(BigInt(records.length), page, 20);
    const selected = records.slice((page - 1) * 20, page * 20);
    if (expanded !== undefined && !selected.some(item => item.id === expanded)) throw new StoreError("The tool Call is not on this page or was deleted", 404);
    return {
      status: "matched", scope: shared ? "interaction" : "round",
      message: shared ? "This interaction includes the original message and messages added during execution. The main Session tool activity below is shared by the interaction, not necessarily triggered only by this message; internal subagent Calls are excluded."
        : "Main Session tool activity for this Round, linked by user message and an explicit logged interactionId. It is not necessarily exclusive to this model request; internal subagent Calls are excluded.",
      partial_tail: diagnostics.partial_tail, pagination: integerStrings(pagination),
      tools: selected.map(item => {
        const full = args.full === "1" || item.id === expanded;
        const truncated = !full && ((item.arguments?.length ?? 0) > 400 || (item.result?.length ?? 0) > 400);
        return { ...item, truncated, arguments: full ? item.arguments : item.arguments?.slice(0, 400) ?? null,
          result: full ? item.result : item.result?.slice(0, 400) ?? null };
      }),
    };
  } catch (error) {
    if (error instanceof MissingEventsError) return unavailable(error.message);
    if (error instanceof StoreError) throw error;
    throw new StoreError("Failed to read the local tool log; check the file and permissions");
  }
}
