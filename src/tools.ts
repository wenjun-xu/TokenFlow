import { StoreError, pageNumber, paged, integerStrings } from "./store";
import { formatTime, zoneFormatter, type Args } from "./dates";
import { sessionEvents, MissingEventsError, isRecord as object, stringValue as text, contentText as body, type EventData as Data, type SessionEvent as Event } from "./events";

export async function toolActivity(db: string, sid: string, userMessage: string | null, args: Args, zone: string) {
  if (Object.keys(args).some(key => !["page", "expandedTool", "full"].includes(key))) throw new StoreError("未知查询参数", 400);
  if (args.full !== undefined && args.full !== "1") throw new StoreError("工具正文读取参数无效", 400);
  const page = pageNumber(args, "page");
  const expanded = args.expandedTool;
  if (expanded !== undefined && (expanded.length > 256 || !expanded.length)) throw new StoreError("工具调用 ID 无效", 400);
  const unavailable = (message: string, status = "unavailable") => ({ status, message, partial_tail: false, tools: [], pagination: integerStrings(paged(0n, page, 20)) });
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sid)) return unavailable("会话 ID 不适用于本地工具日志路径");
  if (userMessage === null || !userMessage.length) return unavailable("该轮没有用户消息，无法关联工具过程");
  try {
    const users: Data[] = [], contexts: Array<{ turnId: unknown; interactionId: unknown; toolRequests: unknown[] }> = [];
    const userInteractions = new Map<string, number>();
    const starts = new Map<string, Event>(), completions = new Map<string, Event>();
    const diagnostics = { partial_tail: false };
    for await (const item of sessionEvents(db, sid, diagnostics)) {
      if (item.agentId) continue;
      if (item.type === "user.message" && item.data.content === userMessage) users.push(item.data);
      if (item.type === "user.message" && typeof item.data.interactionId === "string") {
        const id = item.data.interactionId;
        userInteractions.set(id, (userInteractions.get(id) ?? 0) + 1);
      }
      if (item.type === "assistant.turn_start" || item.type === "assistant.message") contexts.push({
        turnId: item.data.turnId, interactionId: item.data.interactionId,
        toolRequests: Array.isArray(item.data.toolRequests) ? item.data.toolRequests.map(value => object(value) ? value.toolCallId : null) : [],
      });
      if (item.type === "tool.execution_start" || item.type === "tool.execution_complete") {
        const id = text(item.data.toolCallId);
        if (!id) throw new StoreError("本地工具记录缺少调用 ID");
        const target = item.type === "tool.execution_start" ? starts : completions;
        if (target.has(id)) throw new StoreError("本地工具记录调用 ID 重复，无法唯一关联");
        target.set(id, item);
      }
    }
    if (users.length !== 1) return unavailable(users.length ? "同一用户消息在日志中出现多次，无法唯一关联工具过程" : "日志中没有匹配的用户消息", users.length ? "ambiguous" : "missing");
    const interaction = text(users[0].interactionId);
    if (!interaction) return unavailable("该轮日志缺少 interactionId，无法关联工具过程");
    if (userInteractions.get(interaction) !== 1) return unavailable("多条用户消息共享同一 interactionId，无法唯一关联工具过程", "ambiguous");
    const turnIds = new Set<string>(), toolIds = new Set<string>();
    for (const context of contexts) {
      if (context.interactionId !== interaction) continue;
      if (typeof context.turnId === "string") turnIds.add(context.turnId);
      for (const id of context.toolRequests) if (typeof id === "string") toolIds.add(id);
    }
    for (const [id, start] of starts) if (turnIds.has(text(start.data.turnId) ?? "")) toolIds.add(id);
    for (const [id, complete] of completions) if (complete.data.interactionId === interaction) toolIds.add(id);
    const formatter = zoneFormatter(zone);
    const records = [...toolIds].flatMap(id => {
      const start = starts.get(id), complete = completions.get(id);
      if (complete && typeof complete.data.interactionId === "string" && complete.data.interactionId !== interaction) return [];
      return [{
        id, name: text(start?.data.toolName), timestamp: start?.timestamp ?? complete?.timestamp ?? null,
        timestamp_display: formatTime(start?.timestamp ?? complete?.timestamp, formatter),
        status: !complete ? "pending" : complete.data.success === true ? "success" : complete.data.success === false ? "failed" : "unknown",
        arguments: body(start?.data.arguments), result: body(complete?.data.result ?? complete?.data.error),
      }];
    });
    const pagination = paged(BigInt(records.length), page, 20);
    const selected = records.slice((page - 1) * 20, page * 20);
    if (expanded !== undefined && !selected.some(item => item.id === expanded)) throw new StoreError("工具调用不在当前页或已被删除", 404);
    return {
      status: "matched", message: "按唯一用户消息及日志 interactionId 关联的同轮主会话工具过程，不代表仅属于本次模型请求；不含子代理内部调用。",
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
    throw new StoreError("本地工具日志读取失败，请检查文件及权限");
  }
}
