"use strict";
import { toolSynopsis, safeLabel } from "./tool-summary.js";

const fragment = new URLSearchParams(location.hash.slice(1));
let initializationError = null;
if (fragment.has("key")) {
  history.replaceState(null, "", location.pathname + location.search);
  try {
    sessionStorage.setItem("tokenflow-key", fragment.get("key"));
  } catch {
    initializationError = "浏览器禁止会话存储，请允许当前页面的会话存储后重试。";
  }
}
const params = new URLSearchParams(location.search);
const content = document.getElementById("content");
content.tabIndex = -1;
const status = document.getElementById("status");
const errorBox = document.getElementById("error");
document.body.className = params.has("sid") ? (params.has("round") ? "round-page" : "session-page") : "dashboard-page";
let lastRead = null;
let loading = false;
let refreshTimer;

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function integer(value) {
  return value === null || value === undefined ? "未知" : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function recorded(value) {
  return value === null || value === undefined || value === "" ? "未记录" : String(value);
}
function displayTime(row, field) {
  const raw = row[field];
  return row[field + "_display"] ?? (recorded(raw) + (raw === null || raw === undefined || raw === "" ? "" : "（时间异常）"));
}
function link(text, query) {
  const element = node("a", text);
  element.href = "/?" + query.toString();
  return element;
}
function button(text, action) {
  const element = node("button", text);
  element.type = "button";
  element.addEventListener("click", action);
  return element;
}
async function readData(path, query, signal = AbortSignal.timeout(20000)) {
  if (initializationError) throw new Error(initializationError);
  const key = sessionStorage.getItem("tokenflow-key");
  if (!key) throw new Error("缺少访问凭证，请重新执行 tokenflow start 并打开输出的完整地址。");
  const response = await fetch(path + "?" + query, {
    headers: {"X-TokenFlow-Key": key}, cache: "no-store", credentials: "omit", signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "读取失败");
  return data;
}
function requestValues(request) {
  return [
    request.id, displayTime(request, "created_at"), request.model,
    ...["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens"].map(key => integer(request[key])),
    ...["duration_ms", "time_to_first_token_ms", "turn_index", "agent_id", "initiator", "finish_reason"].map(key => recorded(request[key])),
  ];
}
function disclosure(title, ...children) {
  const detail = node("details");
  detail.append(node("summary", title), ...children);
  return detail;
}
const toolStates = {success: "成功", failed: "失败", pending: "结果尚未记录", unknown: "状态未记录"};
function toolStatus(status) {
  if (!Object.hasOwn(toolStates, status)) throw new Error("工具调用状态无效");
  return status === "success" ? "" : " · " + toolStates[status];
}
function activityLabels(tools) {
  const summaries = new Map();
  for (const tool of tools) {
    const key = JSON.stringify([tool.name, tool.summary, tool.status]);
    const item = summaries.get(key);
    if (item) item.count++;
    else summaries.set(key, {tool, count: 1});
  }
  return [...summaries.values()].map(({tool, count}) => {
    const summary = ["参数未记录", "参数格式无法概述", "参数过长，展开查看", "展开查看参数"].includes(tool.summary) ? "" : " · " + tool.summary;
    return `${tool.name.split(/[.:]/).at(-1)}${summary}${toolStatus(tool.status)}${count > 1 ? ` · ×${count}（同摘要）` : ""}`;
  });
}
function toolDetail(tool) {
  if (tool.truncated) throw new Error("工具接口未返回完整调用内容");
  if (!Object.hasOwn(toolStates, tool.status)) throw new Error("工具调用状态无效");
  return disclosure(`${recorded(tool.name)} · ${toolSynopsis(tool)}${toolStatus(tool.status)} · ${displayTime(tool, "timestamp")}`,
    node("h4", "调用参数"), node("pre", recorded(tool.arguments)),
    node("h4", "调用结果"), node("pre", recorded(tool.result)));
}
function roundToolStats(tools) {
  const groups = new Map(), ids = new Set();
  for (const tool of tools) {
    if (typeof tool.id !== "string" || ids.has(tool.id) || tool.truncated || !Object.hasOwn(toolStates, tool.status)) {
      throw new Error("工具统计记录无效或不完整");
    }
    ids.add(tool.id);
    const name = safeLabel(tool.name) || "未记录工具", type = name.split(/[.:]/).at(-1), summary = toolSynopsis(tool);
    const title = type === "skill" ? `skill · ${summary}` : type;
    const key = JSON.stringify([name, type === "skill" ? summary : null]);
    if (!groups.has(key)) groups.set(key, {title, count: 0, summaries: new Set(), states: new Map()});
    const group = groups.get(key);
    group.count++;
    if (type !== "skill" && !["参数未记录", "参数格式无法概述", "参数过长，展开查看", "展开查看参数"].includes(summary)) {
      group.summaries.add(summary);
    }
    if (tool.status !== "success") group.states.set(tool.status, (group.states.get(tool.status) || 0) + 1);
  }
  const list = node("ul", undefined, "round-tool-stats");
  for (const group of [...groups.values()].sort((a, b) => b.count - a.count)) {
    const row = node("li"), label = node("div");
    label.append(node("span", group.title));
    const summaries = [...group.summaries];
    if (summaries.length) label.append(node("small", summaries.slice(0, 2).join("；")
      + (summaries.length > 2 ? `；另 ${summaries.length - 2} 项` : ""), "round-tool-preview"));
    if (group.states.size) label.append(node("small", [...group.states].map(([state, count]) => `${toolStates[state]} ${count}`).join(" · "), "round-tool-state"));
    row.append(label, node("strong", "×" + integer(group.count)));
    list.append(row);
  }
  return list;
}
function metricCards(metrics, count, order = ["calls", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens"]) {
  const cards = node("section", undefined, "metrics");
  const labels = {session_count: "会话数", calls: "模型调用次数", input_tokens: "输入 Token", output_tokens: "输出 Token",
    total_tokens: "总 Token", cache_read_tokens: "缓存读取"};
  const fields = count !== undefined ? ["session_count", ...order] : order;
  for (const field of fields) {
    const card = node("div", labels[field], "metric");
    const value = node("strong", integer(field === "session_count" ? count : metrics[field]));
    value.setAttribute("title", value.textContent);
    card.append(value);
    cards.append(card);
  }
  return cards;
}
function tokenChart(points, onOpen, onActivities, rounds = false) {
  if (!Array.isArray(points)) throw new Error("Token 趋势接口返回无效结果");
  const section = node("section", undefined, "token-chart");
  section.setAttribute("aria-label", rounds ? "会话轮次 Token 走势" : "模型调用 Token 走势");
  if (!points.length) { section.append(node("p", rounds ? "当前范围暂无已记录序号的轮次走势。" : "本轮暂无调用趋势数据。")); return section; }
  const series = [["input_tokens", "输入", "trend-input"], ["output_tokens", "输出", "trend-output"], ["cache_read_tokens", "缓存读取", "trend-cache"]];
  const legend = node("div", undefined, "trend-legend");
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", "曲线颜色说明");
  for (const [, label, className] of series) legend.append(node("span", label, className));
  section.append(legend);
  let minimum = 0n, maximum = 0n, known = 0;
  const values = points.map(point => series.map(([key]) => {
    const raw = point[key];
    if (raw === null) return null;
    if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) throw new Error("Token 趋势值不是有效整数");
    const value = BigInt(raw);
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    known++;
    return value;
  }));
  if (!known) section.append(node("p", rounds ? "当前范围的 Token 指标均未记录，仅显示轮次位置。" : "本轮调用的 Token 指标均未记录，仅显示调用位置。", "notice"));
  if (maximum === minimum) maximum++;
  const svgNode = (tag, attrs = {}, text) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const chartHeight = rounds ? 240 : 280;
  const left = 12, top = 25, bottom = chartHeight - 50;
  const digits = rounds ? points.reduce((maximum, point) => Math.max(maximum, String(point.turn_index).length), 1) : String(points.length).length;
  const chartWidth = Math.max(740, left + 25 + (points.length - 1) * Math.max(32, digits * 8 + 8));
  const right = chartWidth - 25;
  const svg = svgNode("svg", { viewBox: `0 0 ${chartWidth} ${chartHeight}`, preserveAspectRatio: "none", role: "group",
    "aria-label": rounds ? "逐轮汇总的输入、输出和缓存读取 Token 折线图" : "逐次调用的输入、输出和缓存读取 Token 折线图" });
  const axis = svgNode("svg", { viewBox: `0 0 60 ${chartHeight}`, preserveAspectRatio: "none", class: "trend-axis",
    role: "img", "aria-label": "固定 Token 纵轴" });
  svg.style.minWidth = chartWidth + "px";
  let span = maximum - minimum;
  const x = index => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
  // Pixel scaling uses a bounded fixed-point ratio; accessible labels keep exact token values.
  const y = value => bottom - Number((value - minimum) * 1000000n / span) / 1000000 * (bottom - top);
  const axisLabel = value => {
    const sign = value < 0n ? "-" : "", digits = String(value < 0n ? -value : value);
    return digits.length > 6 ? `${sign}${digits[0]}.${digits.slice(1, 3)}e${digits.length - 1}` : integer(String(value));
  };
  const groups = [];
  let selected = 0, activityState = "idle", activityError = "", partialTail = false;
  const activities = new Map();
  const detail = node("section", undefined, "trend-tooltip");
  detail.hidden = true;
  detail.setAttribute("aria-live", "polite");
  const heading = node("h3"), header = node("div", undefined, "trend-tooltip-header"), detailBody = node("div");
  const open = onOpen ? node("button", rounds ? "查看本轮详情" : "查看单次调用详情", "trend-detail-open") : null;
  header.append(heading);
  if (open) {
    open.type = "button";
    if (!rounds) open.setAttribute("aria-haspopup", "dialog");
    open.addEventListener("click", () => onOpen(points[selected], groups[selected]));
    header.append(open);
  }
  detail.append(header, detailBody);
  const labels = points.map((point, index) => (rounds ? `第 ${point.turn_index} 轮 · ${integer(point.calls)} 次模型调用` : `第 ${index + 1} 次调用`)
    + ` · ${displayTime(point, "created_at")} · 模型 ${recorded(point.model)} · `
    + series.map(([key, name]) => `${name} ${integer(point[key])}`).join(" · ") + (point.invalid_time ? " · 时间异常，实际顺序未确定" : ""));
  const reference = svgNode("line", { y1: top, y2: bottom, class: "trend-reference" });
  let anchor = null;
  function updateAnchor(index, event) {
    if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      anchor = {x: event.clientX, y: event.clientY};
    } else {
      const box = (groups[index].querySelector("circle") || groups[index]).getBoundingClientRect();
      anchor = {x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2};
    }
  }
  function positionDetail() {
    if (detail.hidden || !anchor) return;
    const box = detail.getBoundingClientRect(), gap = 12;
    let left = anchor.x - box.width / 2, top = anchor.y - box.height - gap;
    if (top < 8) {
      top = anchor.y + gap;
      if (top + box.height > window.innerHeight - 8) {
        top = anchor.y - box.height / 2;
        left = anchor.x + gap;
        if (left + box.width > window.innerWidth - 8) left = anchor.x - box.width - gap;
      }
    }
    detail.style.left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8)) + "px";
    detail.style.top = Math.max(8, Math.min(top, window.innerHeight - box.height - 8)) + "px";
  }
  function showSelected(index, reveal = true, event) {
    selected = index;
    if (reveal) { updateAnchor(index, event); detail.hidden = false; }
    reference.setAttribute("visibility", detail.hidden ? "hidden" : "visible");
    reference.setAttribute("x1", String(x(index))); reference.setAttribute("x2", String(x(index)));
    groups.forEach((group, position) => group.setAttribute("data-selected", String(!detail.hidden && position === index)));
    const point = points[index];
    heading.textContent = rounds ? `第 ${point.turn_index} 轮` : `第 ${index + 1} 次调用`;
    detailBody.replaceChildren();
    if (rounds) {
      detailBody.append(node("p", `${integer(point.calls)} 次模型调用`, "muted"),
        node("p", recorded(point.summary), point.summary_status === "recorded" ? "round-hover-summary" : "notice"));
    } else if (activityState === "loading") detailBody.append(node("p", "正在整轮读取工具与 skill 摘要…", "muted"));
    else if (activityState === "error") {
      const warning = node("p", "工具摘要读取失败：" + activityError);
      warning.setAttribute("role", "alert");
      const retry = node("a", "重新读取摘要");
      retry.href = "#";
      retry.addEventListener("click", event => { event.preventDefault(); loadActivities(); });
      detailBody.append(warning, retry);
    } else {
      const call = activities.get(point.id);
      if (!call) detailBody.append(node("p", "摘要中未找到该请求，请刷新后重试。", "notice"));
      else if (call.status !== "matched") detailBody.append(node("p", call.message, "notice"));
      else {
        if (!call.tools.length) detailBody.append(node("p", "本次没有工具调用。", "muted"));
        const unique = activityLabels(call.tools);
        const list = node("ul");
        for (const summary of unique.slice(0, 5)) list.append(node("li", summary));
        if (unique.length) detailBody.append(list);
        if (unique.length > 5) {
          const remaining = node("ul");
          for (const summary of unique.slice(5)) remaining.append(node("li", summary));
          detailBody.append(disclosure(`另有 ${unique.length - 5} 种操作摘要`, remaining));
        }
      }
      if (partialTail) detailBody.append(node("p", "日志仍在写入，末尾不完整记录暂未纳入摘要。", "muted"));
    }
    positionDetail();
  }
  function hideDetails() {
    detail.hidden = true;
    reference.setAttribute("visibility", "hidden");
    groups.forEach(group => group.setAttribute("data-selected", "false"));
  }
  section.addEventListener("pointerleave", hideDetails);
  section.addEventListener("focusout", event => { if (!section.contains(event.relatedTarget)) hideDetails(); });
  section.addEventListener("keydown", event => { if (event.key === "Escape") hideDetails(); });
  async function loadActivities() {
    if (activityState === "loading") return;
    if (!params.has("round") || !params.has("sid")) { activityState = "idle"; showSelected(selected, false); return; }
    activityState = "loading";
    showSelected(selected, false);
    onActivities?.(activityState, activities, activityError, partialTail);
    const query = new URLSearchParams();
    for (const field of ["round", "year", "month", "day"]) if (params.has(field)) query.set(field, params.get(field));
    try {
      const data = await readData("/api/sessions/" + encodeURIComponent(params.get("sid")) + "/rounds/activities", query);
      if (!section.isConnected) return;
      if (!Array.isArray(data.calls)) throw new Error("工具摘要接口返回无效结果");
      const seen = new Set();
      for (const call of data.calls) {
        if (typeof call.request_id !== "string" || seen.has(call.request_id) || !["matched", "missing", "ambiguous", "unavailable"].includes(call.status)
          || typeof call.message !== "string" || !Array.isArray(call.tools)) throw new Error("工具摘要记录无效");
        seen.add(call.request_id);
        for (const tool of call.tools) if (typeof tool.name !== "string" || typeof tool.summary !== "string" || !Object.hasOwn(toolStates, tool.status)
          || !["skill", "tool"].includes(tool.kind)) throw new Error("工具摘要内容无效");
      }
      activities.clear();
      for (const call of data.calls) activities.set(call.request_id, call);
      partialTail = data.partial_tail === true;
      activityState = "ready";
    } catch (error) {
      if (!section.isConnected) return;
      activityState = "error"; activityError = error.message;
    }
    if (section.isConnected) {
      showSelected(selected, false);
      onActivities?.(activityState, activities, activityError, partialTail);
    }
  }
  function draw() {
    minimum = 0n; maximum = 0n;
    for (const row of values) row.forEach((value, column) => {
      if (value === null) return;
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    });
    if (maximum === minimum) maximum++;
    span = maximum - minimum;
    svg.replaceChildren(); axis.replaceChildren(); groups.length = 0;
    const ticks = new Set();
    for (let index = 0n; index <= 4n; index++) {
      const value = minimum + span * index / 4n;
      if (ticks.has(String(value))) continue;
      ticks.add(String(value));
      svg.append(svgNode("line", { x1: 0, x2: right, y1: y(value), y2: y(value), class: "trend-grid" }));
      axis.append(svgNode("text", { x: 54, y: y(value) + 4, "text-anchor": "end", class: "trend-label" }, axisLabel(value)));
    }
    axis.append(svgNode("text", { x: 54, y: 14, "text-anchor": "end", class: "trend-label" }, "Token"));
    points.forEach((_, index) => svg.append(svgNode("text", {
      x: x(index), y: bottom + 22, "text-anchor": "middle", class: "trend-label trend-index",
    }, rounds ? String(points[index].turn_index) : String(index + 1))));
    series.forEach(([, , className], column) => {
      let path = "", connected = false;
      values.forEach((row, index) => {
        const value = row[column];
        if (value === null) { connected = false; return; }
        path += `${connected && !points[index].invalid_time ? "L" : "M"}${x(index)},${y(value)} `;
        connected = !points[index].invalid_time;
      });
      svg.append(svgNode("path", { d: path.trim(), class: "trend-line " + className }));
    });
    svg.append(reference);
    points.forEach((point, index) => {
      const group = svgNode("g", { class: "trend-point", tabindex: "0", role: "img",
        "aria-label": labels[index] + (onOpen ? " · 按 Enter 或空格聚焦详情按钮" : "") });
      const width = points.length > 1 ? Math.min(24, (right - left) / (points.length - 1)) : 24;
      group.append(svgNode("rect", { x: x(index) - width / 2, y: top, width, height: bottom - top, class: "trend-hit" }));
      values[index].forEach((value, column) => {
        if (value !== null) group.append(svgNode("circle", { cx: x(index), cy: y(value), r: 3,
          class: "trend-dot " + series[column][2] }));
      });
      group.addEventListener("pointerenter", event => showSelected(index, true, event));
      group.addEventListener("pointermove", event => {
        if (detail.hidden || selected !== index) showSelected(index, true, event);
      });
      group.addEventListener("focus", () => showSelected(index));
      group.addEventListener("keydown", event => {
        if (open && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (!event.repeat) { showSelected(index); open.focus(); }
        }
      });
      groups.push(group);
      svg.append(group);
    });
    showSelected(selected, false);
  }
  const scroll = node("div", undefined, "trend-scroll");
  scroll.append(svg);
  scroll.addEventListener("scroll", () => {
    if (detail.hidden) return;
    const box = groups[selected].getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    if (box.right < viewport.left || box.left > viewport.right || document.activeElement !== groups[selected]) hideDetails();
    else { updateAnchor(selected); positionDetail(); }
  });
  const plot = node("div", undefined, "trend-plot");
  plot.append(axis, scroll);
  section.append(plot, detail);
  const invalid = points.filter(point => point.invalid_time).length;
  if (invalid) section.append(node("p", rounds
    ? `${invalid} 轮时间异常，放在末尾按轮次序号排列并显示为独立点，不代表真实时序。`
    : `${invalid} 次调用时间异常，放在末尾按请求 ID 排列并显示为独立点，不代表真实时序。`, "notice"));
  draw();
  if (!rounds) loadActivities();
  return section;
}
function table(headers, rows, onSelect, pagination, descending = false, numbered = true) {
  const wrapper = node("div", undefined, "scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", `${headers[0]}列表，可上下或左右滚动`);
  const element = node("table");
  const head = node("thead");
  const heading = node("tr");
  for (const title of [...(numbered ? ["序号"] : []), ...headers]) {
    const cell = node("th", title);
    cell.scope = "col";
    heading.append(cell);
  }
  head.append(heading);
  element.append(head);
  const body = node("tbody");
  const offset = pagination ? (BigInt(pagination.page) - 1n) * BigInt(pagination.size) : 0n;
  let ordinal = descending ? (pagination ? BigInt(pagination.total) : BigInt(rows.length)) - offset + 1n : offset;
  for (const [index, row] of rows.entries()) {
    const tr = node("tr");
    for (const value of [...(numbered ? [integer(descending ? --ordinal : ++ordinal)] : []), ...row]) {
      const td = node("td");
      td.append(value instanceof Node ? value : node("span", value));
      tr.append(td);
    }
    if (onSelect) {
      tr.className = "request-row";
      tr.tabIndex = 0;
      tr.setAttribute("aria-haspopup", "dialog");
      tr.setAttribute("aria-label", headers[0] === "ID" ? `查看请求 ${row[0]} 的详情` : `查看第 ${integer(ordinal)} 次调用的详情`);
      tr.addEventListener("click", () => {
        if (!window.getSelection().toString()) onSelect(row, tr, index);
      });
      tr.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!event.repeat) onSelect(row, tr, index);
        }
      });
    }
    body.append(tr);
  }
  element.append(body);
  wrapper.append(element);
  return wrapper;
}
function followTableLinks(listing) {
  for (const row of listing.querySelectorAll("tbody tr")) {
    row.className = "linked-row";
    row.addEventListener("click", event => {
      if (!event.target.closest("a") && !window.getSelection().toString()) row.querySelector("a").click();
    });
  }
}
async function loadTurnTools(tools, turn, read, active, statsTitle) {
  if (statsTitle) statsTitle.textContent = "工具调用";
  tools.replaceChildren(node("p", "正在读取本轮工具过程…", "muted"));
  tools.setAttribute("aria-busy", "true");
  try {
    let page = 1n, pages = 1n, partial = false;
    const records = [];
    do {
      const data = await read("/api/sessions/" + encodeURIComponent(params.get("sid"))
        + "/turns/" + encodeURIComponent(turn.id) + "/tools", new URLSearchParams({page: String(page), full: "1"}));
      if (!active()) return;
      if (!["matched", "unavailable", "missing", "ambiguous"].includes(data.status) || typeof data.message !== "string"
        || !Array.isArray(data.tools)) throw new Error("工具接口返回无效结果");
      if (page === 1n && !statsTitle) tools.replaceChildren();
      if (data.partial_tail) tools.append(node("p", "日志正在写入，末尾未完整写入的记录暂不显示。", "muted"));
      if (data.status !== "matched") {
        const notice = node("p", data.message, "notice");
        if (statsTitle) tools.replaceChildren(notice);
        else tools.append(notice);
        return;
      }
      if (BigInt(data.pagination.page) !== page) throw new Error("工具接口返回无效页码");
      pages = BigInt(data.pagination.pages);
      if (!data.tools.length) tools.append(node("p", "该轮完整日志中没有记录主会话工具调用。", "muted"));
      if (statsTitle) { records.push(...data.tools); partial ||= data.partial_tail === true; }
      else for (const tool of data.tools) tools.append(toolDetail(tool));
      page++;
    } while (page <= pages && active());
    if (statsTitle && active()) {
      const listing = roundToolStats(records);
      statsTitle.textContent = `工具调用 · ${integer(records.length)} 次`;
      tools.replaceChildren(records.length ? listing : node("p", "本轮没有工具调用。", "muted"));
      if (partial) tools.append(node("p", "日志写入中，统计暂不含末尾未完整记录。", "muted"));
    }
  } finally {
    tools.setAttribute("aria-busy", "false");
  }
}
function roundConversation(points) {
  const panel = node("section", undefined, "round-conversation");
  panel.setAttribute("aria-label", "本轮对话详情");
  panel.append(node("h2", "本轮对话"));
  const body = node("div");
  body.setAttribute("aria-live", "polite");
  panel.append(body);
  const active = () => panel.isConnected;
  const read = (path, query) => readData(path, query);
  async function loadConversation() {
    if (!active()) return;
    body.replaceChildren(node("p", "正在读取本轮对话…", "muted"));
    body.setAttribute("aria-busy", "true");
    try {
      if (!points.length || params.get("round") === "missing") {
        body.replaceChildren(node("p", "没有可唯一关联的轮次记录，无法展示本轮对话。", "notice"));
        return;
      }
      const data = await read("/api/sessions/" + encodeURIComponent(params.get("sid"))
        + "/requests/" + encodeURIComponent(points[0].id), new URLSearchParams({view: "matched", full: "1"}));
      if (!active()) return;
      if (!["matched", "missing", "ambiguous", "no_index"].includes(data.association) || !Array.isArray(data.turns)
        || data.request?.turn_index !== params.get("round")) throw new Error("本轮对话接口返回无效结果");
      if (data.association !== "matched") {
        body.replaceChildren(node("p", data.association === "ambiguous" ? "本轮存在多条对话记录，无法唯一确认。"
          : "本轮对话尚未记录，不能用其他轮次的内容代替。", "notice"));
        return;
      }
      const turn = data.turns[0];
      if (data.turns.length !== 1 || turn.turn_index !== params.get("round") || turn.truncated) throw new Error("本轮对话未返回唯一完整正文");
      const tools = node("div");
      const toolGroup = disclosure("工具调用", tools);
      let toolsStarted = false;
      async function loadTools() {
        try { await loadTurnTools(tools, turn, read, active, toolGroup.querySelector("summary")); }
        catch (error) {
          if (!active()) return;
          const warning = node("p", "工具统计读取失败：" + error.message);
          warning.setAttribute("role", "alert");
          tools.replaceChildren(warning, button("重试", loadTools));
        }
      }
      toolGroup.addEventListener("toggle", () => {
        if (toolGroup.open && !toolsStarted) { toolsStarted = true; loadTools(); }
      });
      body.replaceChildren(disclosure("用户消息", node("pre", recorded(turn.user_message))),
        disclosure("助手回复", node("pre", recorded(turn.assistant_response))), toolGroup);
    } catch (error) {
      if (!active()) return;
      const warning = node("p", "本轮对话读取失败：" + error.message);
      warning.setAttribute("role", "alert");
      body.replaceChildren(warning, button("重试", loadConversation));
    } finally {
      body.setAttribute("aria-busy", "false");
    }
  }
  queueMicrotask(loadConversation);
  return panel;
}
function requestDialog(requestId, trigger) {
  const dialog = node("dialog", undefined, "request-dialog");
  const hasRequest = requestId !== undefined;
  const heading = node("h2", hasRequest ? "单次模型调用详情" : "会话对话");
  heading.id = "request-detail-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.setAttribute("aria-describedby", "request-detail-hint");
  dialog.tabIndex = -1;
  const header = node("div", undefined, "dialog-header");
  const hint = node("p", "点击弹窗外空白处或按 Esc 关闭", "muted");
  hint.id = "request-detail-hint";
  header.append(heading, hint);
  const conversation = node("section");
  conversation.setAttribute("aria-live", "polite");
  let generation = 0, controller, outsidePress = false;
  const outside = event => {
    const rect = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
      || event.clientY < rect.top || event.clientY > rect.bottom);
  };
  dialog.addEventListener("pointerdown", event => { outsidePress = outside(event); });
  dialog.addEventListener("click", event => {
    if (outsidePress && outside(event)) dialog.close();
    outsidePress = false;
  });
  const actionLink = (label, action) => {
    const element = node("a", label);
    element.href = "#";
    element.addEventListener("click", event => { event.preventDefault(); action(); });
    return element;
  };
  dialog.append(header, conversation);
  async function loadConversation(view = hasRequest ? "matched" : "all", page = "1") {
    const current = ++generation;
    controller?.abort();
    const currentController = controller = new AbortController();
    const active = () => current === generation && dialog.open;
    const read = async (path, query) => {
      const timeout = setTimeout(() => currentController.abort(), 20000);
      try { return await readData(path, query, currentController.signal); }
      finally { clearTimeout(timeout); }
    };
    conversation.replaceChildren(node("p", hasRequest ? "正在读取本次模型调用…" : "正在读取对话…"));
    conversation.setAttribute("aria-busy", "true");
    const query = hasRequest ? new URLSearchParams() : new URLSearchParams({ turnPage: page, full: "1" });
    try {
      let path = "/api/sessions/" + encodeURIComponent(params.get("sid"));
      if (hasRequest) path += "/requests/" + encodeURIComponent(requestId) + "/call";
      const data = await read(path, query);
      if (!active()) return;
      if (hasRequest) {
        if (!["matched", "missing", "ambiguous", "unavailable"].includes(data.status) || typeof data.message !== "string"
          || !Array.isArray(data.outputs) || !data.outputs.every(output => typeof output === "string") || !Array.isArray(data.tools)) {
          throw new Error("单次调用接口返回无效结果");
        }
        conversation.replaceChildren(node("p", data.message, "notice"));
        if (data.partial_tail) conversation.append(node("p", "日志正在写入，末尾不完整的记录暂不显示。", "muted"));
        if (data.status !== "matched") return;
        if (!data.input || !["recorded", "missing", "ambiguous"].includes(data.input.status)) throw new Error("输入记录状态无效");
        const input = disclosure("本次调用输入" + (data.input.status === "recorded" ? "" : " · " + (data.input.status === "missing" ? "未记录" : "无法唯一确认")),
          node("p", data.input.message, "muted"));
        if (data.input.status === "recorded") input.append(node("pre", recorded(data.input.content)));
        const output = disclosure(data.outputs.length ? "本次模型输出" : data.tools.length ? "本次输出为工具调用" : "本次模型输出未记录");
        for (const text of data.outputs) output.append(node("pre", text));
        if (!data.outputs.length) output.append(node("p", data.tools.length
          ? "本次模型返回了工具调用指令，没有单独的文字回复。" : "日志中没有本次输出正文，也没有工具调用指令，不能用最终回复代替。", "muted"));
        conversation.append(input, output);
        if (data.tools.length) {
          conversation.append(node("h3", `本次工具调用 · ${integer(data.tools.length)} 次`));
          for (const tool of data.tools) conversation.append(toolDetail(tool));
        } else conversation.append(node("p", "本次未记录工具调用。", "muted"));
        return;
      }
      if (!Array.isArray(data.turns)) throw new Error("对话接口返回无效结果");
      conversation.replaceChildren(node("p", "全会话已记录对话，按时间倒序显示；不表示全部属于某一次请求，也不受页面日期筛选影响。", "notice"));
      for (const turn of data.turns) {
        const article = node("article");
        article.append(node("h4", "用户消息"), node("pre", recorded(turn.user_message)),
          node("h4", "最终助手回复"), node("pre", recorded(turn.assistant_response)));
        if (turn.truncated) throw new Error("对话接口未返回完整正文");
        const tools = node("section");
        article.append(node("h4", "工具调用过程（同一轮，不限于本次请求）"), tools);
        conversation.append(disclosure(`轮次 ${recorded(turn.turn_index)} · ${displayTime(turn, "timestamp")}`, article));
        const loadTools = async () => {
          try {
            await loadTurnTools(tools, turn, read, active);
          } catch (error) {
            if (!active()) return;
            const warning = node("p", `轮次 ${recorded(turn.turn_index)}：` + (error.name === "AbortError" ? "工具过程读取超时，请重新打开弹窗重试。" : "工具过程读取失败：" + error.message));
            warning.setAttribute("role", "alert");
            conversation.append(warning);
          }
        };
        await loadTools();
        if (!active()) return;
      }
      if (!hasRequest) {
        if (!data.turns.length) conversation.append(node("p", "数据库中暂无对话记录"));
        const pagination = data.turn_pagination, currentPage = BigInt(pagination.page);
        const nav = node("nav");
        nav.setAttribute("aria-label", "弹窗对话分页");
        nav.append(node("span", `共 ${integer(pagination.total)} 轮，第 ${integer(pagination.page)} / ${integer(pagination.pages)} 页`));
        for (const [label, target] of [["上一页", currentPage - 1n], ["下一页", currentPage + 1n]]) {
          if (target >= 1n && target <= BigInt(pagination.pages)) {
            nav.append(actionLink(label, () => loadConversation(view, target.toString())));
          }
        }
        conversation.append(nav);
      }
    } catch (error) {
      if (!active()) return;
      const warning = node("p", error.name === "AbortError" ? "详情读取超时，请重试。" : "详情读取失败：" + error.message);
      warning.setAttribute("role", "alert");
      conversation.replaceChildren(warning, actionLink("重试", () => loadConversation(view, page)));
    } finally {
      if (current === generation) conversation.setAttribute("aria-busy", "false");
    }
  }
  dialog.addEventListener("close", () => {
    generation++;
    controller?.abort();
    dialog.remove();
    const fallback = params.has("round") ? content.querySelector(".round-title") : content;
    (trigger.isConnected ? trigger : fallback || content).focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  dialog.focus();
  loadConversation(hasRequest ? "matched" : "all");
}
function pagination(data, field, onPage) {
  const nav = node("nav");
  nav.setAttribute("aria-label", field === "page" ? "会话分页" : field === "requestPage" ? "请求分页" : "轮次分页");
  nav.append(node("span", `共 ${integer(data.total)} 条，第 ${integer(data.page)} / ${integer(data.pages)} 页`));
  const current = BigInt(data.page);
  for (const [label, target] of [["上一页", current - 1n], ["下一页", current + 1n]]) {
    if (target >= 1n && target <= BigInt(data.pages)) {
      const next = new URLSearchParams(params);
      next.set(field, target.toString());
      next.delete("expandedTurn");
      const action = link(label, next);
      if (onPage) action.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault();
        onPage(next, label);
      });
      nav.append(action);
    }
  }
  return nav;
}
function roundQuery(round) {
  const query = new URLSearchParams(params);
  query.set("round", round === null ? "missing" : round);
  for (const field of ["requestPage", "turnPage", "expandedTurn"]) query.delete(field);
  return query;
}
function roundCallSection(initial, overview = false) {
  let data = initial, generation = 0, controller;
  let activityState = "loading", activities = new Map(), activityError = "", partial = false;
  const scope = new URLSearchParams(params), summaries = new Map();
  const field = overview ? "rounds" : "requests", pageField = overview ? "roundPage" : "requestPage";
  const paginationField = overview ? "round_pagination" : "request_pagination";
  const section = node("section", undefined, "round-call-section"), heading = node("h2", overview ? "轮次列表" : "调用明细");
  heading.tabIndex = -1;
  const warning = node("p");
  warning.hidden = true;
  warning.setAttribute("role", "alert");
  function updateActivities(state, calls, reason, tail) {
    activityState = state; activities = calls; activityError = reason; partial = tail;
    for (const [id, cell] of summaries) {
      let text = state === "error" ? "读取失败：" + reason : "正在读取调用摘要…";
      if (state === "ready") {
        const call = calls.get(id);
        if (!call) text = "未找到调用摘要，请刷新重试。";
        else if (call.status !== "matched") text = call.message;
        else {
          const labels = activityLabels(call.tools);
          text = labels.length ? labels.slice(0, 3).join("；") + (labels.length > 3 ? `；另 ${labels.length - 3} 项` : "") : "本次没有工具调用。";
        }
        if (tail) text += "（日志写入中）";
      }
      cell.textContent = text;
      cell.setAttribute("data-state", state);
    }
  }
  function draw(focusLabel) {
    summaries.clear();
    if (!overview) for (const request of data.requests) summaries.set(request.id, node("span", undefined, "call-summary"));
    const rows = data[field];
    const listing = !rows.length ? node("p", "当前范围内暂无模型请求。") : overview
      ? table(["轮次", "调用次数", "总 Token", "模型", "对话摘要"], rows.map(round => {
        const summary = node("span", recorded(round.summary), "call-summary");
        summary.setAttribute("title", recorded(round.summary));
        return [link(round.turn_index === null ? "未记录轮次" : `第 ${round.turn_index} 轮`, roundQuery(round.turn_index)),
          integer(round.metrics.calls), integer(round.metrics.total_tokens), node("span", round.models.join("、") || "未记录", "round-models"), summary];
      }), undefined, data[paginationField], false, false)
      : table(["模型", "输入", "输出", "总 Token", "缓存读取", "调用摘要"],
      data.requests.map(request => [recorded(request.model), ...requestValues(request).slice(3, 7), summaries.get(request.id)]),
      (_, trigger, index) => requestDialog(data.requests[index].id, trigger), data.request_pagination, true);
    if (rows.length) {
      listing.className += " round-call-list" + (overview ? " session-round-list" : "");
      listing.setAttribute("aria-label", overview ? "轮次列表，表头固定，内容可滚动" : "模型调用列表，表头固定，内容可滚动");
      if (overview) followTableLinks(listing);
    }
    section.replaceChildren(heading, listing);
    if (BigInt(data[paginationField].pages) > 1n) section.append(pagination(data[paginationField], pageField,
      (next, label) => loadPage(next, label)));
    section.append(warning);
    updateActivities(activityState, activities, activityError, partial);
    if (focusLabel) {
      const target = [...section.querySelectorAll("nav a")].find(action => action.textContent === focusLabel)
        || (rows.length ? listing : heading);
      target.focus({preventScroll: true});
    }
  }
  async function loadPage(next, focusLabel) {
    const current = ++generation;
    controller?.abort();
    const currentController = controller = new AbortController();
    const timeout = setTimeout(() => currentController.abort(), 20000);
    const active = () => current === generation && section.isConnected;
    section.setAttribute("aria-busy", "true");
    warning.hidden = true;
    const query = new URLSearchParams();
    for (const field of [...(overview ? [] : ["round"]), "year", "month", "day", pageField]) if (next.has(field)) query.set(field, next.get(field));
    try {
      const result = await readData("/api/sessions/" + encodeURIComponent(scope.get("sid")) + "/rounds", query, currentController.signal);
      if (!active()) return;
      const page = result[paginationField];
      if (!Array.isArray(result[field]) || result[field].length > 10 || result.round !== initial.round
        || result.session?.id !== scope.get("sid") || page?.size !== "10"
        || BigInt(page.page) !== BigInt(next.get(pageField) || "1") || BigInt(page.pages) < BigInt(page.page)
        || BigInt(page.total) < 0n || !result[field].every(row => overview ? row.turn_index === null || typeof row.turn_index === "string" : typeof row.id === "string")) {
        throw new Error((overview ? "轮次" : "调用") + "列表接口返回无效结果");
      }
      history.replaceState(null, "", "/?" + next);
      for (const key of [...params.keys()]) params.delete(key);
      for (const [key, value] of next) params.append(key, value);
      data = result;
      warning.textContent = "";
      draw(focusLabel);
    } catch (error) {
      if (!active()) return;
      warning.replaceChildren();
      warning.textContent = "翻页读取失败：" + (error.name === "AbortError" ? "读取超时，请重试。" : error.message) + " 当前仍显示上一页数据。";
      warning.append(button("重试", () => loadPage(next, focusLabel)));
      warning.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (active()) section.setAttribute("aria-busy", "false");
    }
  }
  draw();
  return {element: section, updateActivities};
}
function diagnostics(data) {
  const box = node("p", `全库诊断：无法参与日期筛选的请求 ${integer(data.diagnostics.invalid_times)} 条；`
    + `孤立请求 ${integer(data.diagnostics.orphan_requests)} 条（不纳入会话汇总）。两项可能重叠。`, "notice");
  return box;
}
function dateForm(years) {
  const form = node("form", undefined, "date-filter");
  form.setAttribute("aria-label", "按日期筛选会话");
  const year = node("select"), month = node("select"), day = node("select");
  for (const [select, label, name] of [[year, "年份", "year"], [month, "月份", "month"], [day, "日期", "day"]]) {
    select.name = name;
    const wrapper = node("label", label + " ");
    wrapper.append(select);
    form.append(wrapper);
  }
  function options(select, choices, selected) {
    select.replaceChildren();
    for (const value of ["", ...choices]) {
      const option = node("option", value === "" ? "全部" : value);
      option.value = value;
      option.selected = value === selected;
      select.append(option);
    }
  }
  const availableYears = new Set(years);
  if (params.get("year")) availableYears.add(params.get("year"));
  options(year, [...availableYears].sort((a, b) => Number(b) - Number(a)), params.get("year") || "");
  options(month, Array.from({length: 12}, (_, i) => String(i + 1)), String(parseInt(params.get("month"), 10) || ""));
  function days(selected = "") {
    month.disabled = !year.value;
    day.disabled = !year.value || !month.value;
    // Date controls use bounded civil integers only; usage values never become Number.
    const count = day.disabled ? 0 : new Date(Number(year.value), Number(month.value), 0).getDate();
    options(day, Array.from({length: count}, (_, i) => String(i + 1)), selected);
  }
  days(String(parseInt(params.get("day"), 10) || ""));
  year.addEventListener("change", () => { month.value = ""; days(); });
  month.addEventListener("change", () => days());
  const submit = node("button", "查询");
  submit.type = "submit";
  submit.className = "filter-submit";
  form.append(submit, link("重置", new URLSearchParams()));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const query = new URLSearchParams();
    for (const field of [year, month, day]) if (!field.disabled && field.value) query.set(field.name, field.value);
    location.search = query.toString();
  });
  return form;
}
function renderDashboard(data, automatic = false) {
  document.body.className = "dashboard-page";
  const form = automatic ? content.querySelector(".date-filter") : null;
  const previousList = automatic ? content.querySelector(".scroll") : null;
  const scroll = previousList ? {top: previousList.scrollTop, left: previousList.scrollLeft, x: window.scrollX, y: window.scrollY} : null;
  if (form) {
    const year = form.querySelector("select");
    for (const value of data.years) if (![...year.options].some(option => option.value === value)) {
      const option = node("option", value);
      option.value = value;
      year.insertBefore(option, [...year.options].find(option => option.value && Number(option.value) < Number(value)) || null);
    }
  }
  const children = [];
  const overview = node("section", undefined, "dashboard-overview");
  const metrics = metricCards(data.metrics, undefined, ["input_tokens", "output_tokens", "cache_read_tokens", "total_tokens"]);
  metrics.className += " compact-metrics dashboard-metrics";
  const toolbar = node("div", undefined, "dashboard-toolbar");
  const period = node("span", data.period, "filter-period");
  toolbar.append(form || dateForm(data.years), period);
  overview.append(toolbar, metrics);
  children.push(overview);
  if (["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) children.push(diagnostics(data));
  if (data.sessions.length === 0) {
    children.push(node("p", "此期间没有匹配会话。"), link("重置日期条件", new URLSearchParams()));
  } else {
    const rows = data.sessions.map(session => {
      const query = new URLSearchParams();
      query.set("sid", session.id);
      query.set("list", params.toString());
      for (const field of ["year", "month", "day"]) if (params.get(field)) query.set(field, params.get(field));
      return [
        link(session.title, query), session.project, displayTime(session, "created_at"), displayTime(session, "latest_request"),
        session.models.join("\n") || "—", integer(session.metrics.calls), integer(session.metrics.input_tokens),
        integer(session.metrics.output_tokens), integer(session.metrics.total_tokens), integer(session.metrics.cache_read_tokens),
      ];
    });
    const listing = table(["会话摘要", "项目", "创建时间", "范围内最近请求", "实际模型", "调用次数",
      "输入", "输出", "总 Token", "缓存读取"], rows, undefined, data.pagination);
    followTableLinks(listing);
    children.push(listing);
  }
  children.push(pagination(data.pagination, "page"));
  content.replaceChildren(...children);
  if (scroll) {
    const listing = content.querySelector(".scroll");
    if (listing) { listing.scrollTop = scroll.top; listing.scrollLeft = scroll.left; }
    window.scrollTo(scroll.x, scroll.y);
  }
}
function renderRoundOverview(data) {
  if (!Array.isArray(data.round_trend)) throw new Error("轮次走势接口返回无效结果");
  document.body.className = "session-page";
  const summary = node("div", undefined, "session-summary");
  const title = node("h1", recorded(data.session.summary));
  title.setAttribute("title", title.textContent);
  summary.append(title);
  const info = node("section", undefined, "session-info");
  const original = new URLSearchParams(params.get("list") || "");
  const actions = node("span", undefined, "session-actions");
  const all = new URLSearchParams(params);
  for (const field of ["year", "month", "day", "roundPage"]) all.delete(field);
  if (params.has("year")) {
    actions.append(node("span", data.period, "muted"), link("全部时间", all));
  } else if (original.get("year")) {
    const restored = new URLSearchParams(all);
    for (const field of ["year", "month", "day"]) if (original.get(field)) restored.set(field, original.get(field));
    actions.append(link("恢复原日期范围", restored));
  }
  const records = button("全会话记录", () => requestDialog(undefined, records));
  records.className = "text-action";
  records.setAttribute("aria-haspopup", "dialog");
  actions.append(records);
  const fields = node("dl", undefined, "session-fields");
  for (const [key, label] of [["cwd", "工作目录"], ["id", "会话 ID"]]) {
    const field = node("div", undefined, "session-field");
    const text = recorded(data.session[key]);
    const value = node("dd", text);
    value.setAttribute("title", text);
    field.append(node("dt", label), value);
    fields.append(field);
  }
  info.append(fields);
  const metrics = metricCards(data.metrics, undefined, ["input_tokens", "output_tokens", "cache_read_tokens", "total_tokens"]);
  metrics.className += " compact-metrics session-metrics";
  info.append(metrics);
  content.append(summary, info);
  if (["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) content.append(diagnostics(data));
  const points = data.round_trend.filter(round => round.turn_index !== null).map(round => ({
    id: round.turn_index, turn_index: round.turn_index, ...round.metrics,
    created_at: round.first_request, created_at_display: round.first_request_display, model: round.models.join("、"),
    summary: round.summary, summary_status: round.summary_status, invalid_time: round.invalid_time,
  }));
  const chart = tokenChart(points, point => { location.href = "/?" + roundQuery(point.turn_index); }, undefined, true);
  const missing = data.round_trend.length - points.length;
  if (missing) chart.append(node("p", `${missing} 组请求未记录轮次序号，仅在列表和汇总中保留，不推测曲线位置。`, "notice"));
  const calls = roundCallSection(data, true);
  calls.element.querySelector("h2").append(actions);
  content.append(chart, calls.element);
}
function renderSession(data) {
  if (!params.has("round") && Array.isArray(data.rounds)) { renderRoundOverview(data); return; }
  const original = new URLSearchParams(params.get("list") || "");
  const navigation = node("nav");
  const roundView = params.has("round");
  const roundCalls = roundView ? roundCallSection(data) : null;
  document.body.className = roundView ? "round-page" : "";
  if (roundView) {
    const heading = node("h1", params.get("round") === "missing" ? "未记录轮次 · 模型调用" : `第 ${recorded(data.round)} 轮 · 模型调用`, "round-title");
    heading.tabIndex = -1;
    if (data.period !== "全部时间") heading.append(node("span", " · " + data.period, "round-period"));
    const top = node("div", undefined, "round-heading");
    top.append(heading);
    content.append(top);
  } else {
    navigation.append(link("返回会话列表", original));
    const all = new URLSearchParams(params);
    for (const field of ["year", "month", "day", "requestPage", "expandedTurn", "roundPage"]) all.delete(field);
    navigation.append(link("查看该会话全部时间", all));
    if (original.get("year")) {
      const restored = new URLSearchParams(all);
      for (const field of ["year", "month", "day"]) if (original.get(field)) restored.set(field, original.get(field));
      navigation.append(link("恢复原日期范围", restored));
    }
    content.append(navigation, node("h2", data.session.title));
    const definition = node("dl");
    for (const [key, title] of [["id", "会话 ID"], ["summary", "摘要"], ["repository", "仓库"],
      ["cwd", "工作目录"], ["branch", "分支"], ["host_type", "宿主类型"],
      ["created_at", "创建时间"], ["updated_at", "更新时间"]]) {
      definition.append(node("dt", title), node("dd", key.endsWith("_at") ? displayTime(data.session, key) : recorded(data.session[key])));
    }
    content.append(definition, node("h2", (params.get("year") ? "当前期间用量：" : "全部时间用量：") + data.period), metricCards(data.metrics));
  }
  if (!roundView || ["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) content.append(diagnostics(data));
  if (roundView) {
    const overview = node("div", undefined, "round-overview");
    overview.append(tokenChart(data.token_trend, (point, trigger) => requestDialog(point.id, trigger),
      roundCalls.updateActivities), roundConversation(data.token_trend));
    content.append(overview);
    content.append(roundCalls.element);
    return;
  }
  if (!roundView) {
    const viewAll = button("全会话记录", () => requestDialog(undefined, viewAll));
    content.append(viewAll);
  }
  content.append(node("h2", "模型请求明细（最新在前）"));
  if (!roundView) content.append(node("p", "每行代表一次模型调用，点击查看当次输出和工具详情。原始轮次序号仅是源数据；耗时及首 Token 延迟单位为毫秒。", "muted"));
  if (data.requests.length === 0) content.append(node("p", "当前范围内暂无模型请求。"));
  else {
    const headers = ["ID", "发生时间", "实际模型", "输入", "输出", "总 Token", "缓存读取",
      "耗时 ms", "首 Token ms", "原始轮次序号", "Agent", "发起方", "结束原因"];
    const rows = data.requests.map(requestValues);
    if (!roundView) content.append(node("p", "点击任意请求行查看详情，也可使用 Enter 或空格打开。", "muted"));
    const listing = table(headers, rows, (values, trigger) => requestDialog(values[0], trigger), data.request_pagination, true);
    content.append(listing);
  }
  if (!roundView || BigInt(data.request_pagination.pages) > 1n) content.append(pagination(data.request_pagination, "requestPage"));
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!params.has("sid") && !document.hidden) refreshTimer = setTimeout(() => load(true), 15000);
}
function refreshPaused() {
  return document.hidden || (document.activeElement && document.activeElement !== content && content.contains(document.activeElement))
    || Boolean(window.getSelection().toString());
}
async function load(automatic = false) {
  if (loading) return;
  if (automatic && refreshPaused()) { scheduleRefresh(); return; }
  loading = true;
  const previousStatus = status.textContent;
  status.textContent = "正在读取…";
  content.setAttribute("aria-busy", "true");
  if (!automatic) errorBox.hidden = true;
  try {
    const query = new URLSearchParams();
    const sid = params.get("sid");
    const fields = sid ? ["year", "month", "day", ...(params.has("round") ? ["round", "requestPage"] : ["roundPage"])] : ["year", "month", "day", "page"];
    for (const field of fields) if (params.has(field)) query.set(field, params.get(field));
    const path = sid ? "/api/sessions/" + encodeURIComponent(sid) + "/rounds" : "/api/dashboard";
    const data = await readData(path, query);
    if (automatic && refreshPaused()) { status.textContent = previousStatus; return; }
    if (sid) { content.replaceChildren(); renderSession(data); }
    else renderDashboard(data, automatic);
    lastRead = displayTime(data, "read_at");
    document.getElementById("metadata").textContent =
      `数据源：${data.source} · OS 本地时区：${data.timezone}（修改后需重启） · 最近成功读取：${lastRead}`;
    content.querySelector(".filter-period")?.setAttribute("title", document.getElementById("metadata").textContent);
    errorBox.hidden = true;
    status.textContent = "读取完成";
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = `${lastRead ? "数据已过期（最近成功读取：" + lastRead + "）。" : ""}`
      + `${error.message} 如服务不可用，请执行 tokenflow start。`;
    status.textContent = "读取失败";
    if (!content.children.length) {
      content.append(link("返回会话列表", new URLSearchParams(params.get("list") || "")),
        link("重置并返回全部时间", new URLSearchParams()));
    }
  } finally {
    loading = false;
    content.setAttribute("aria-busy", "false");
    scheduleRefresh();
  }
}
if (!params.has("sid")) document.addEventListener("visibilitychange", () => {
  clearTimeout(refreshTimer);
  if (!document.hidden) load(true);
});
load();
