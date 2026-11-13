"use strict";
import { toolSynopsis } from "./tool-summary.js";

const fragment = new URLSearchParams(location.hash.slice(1));
let initializationError = null;
if (fragment.has("key")) {
  history.replaceState(null, "", location.pathname + location.search);
  try {
    sessionStorage.setItem("tokenflow-key", fragment.get("key"));
  } catch {
    initializationError = "Session storage is blocked. Allow session storage for this page and try again.";
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
let loadController = null;
let loadRevision = 0;
let refreshTimer;
let serviceToday = null;
let dashboardRange = null;
const dateFields = ["year", "month", "day", "start", "end"];

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function svgNode(tag, attrs = {}, text) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
function integer(value) {
  return value === null || value === undefined ? "Unknown" : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function recorded(value) {
  return value === null || value === undefined || value === "" ? "Not recorded" : String(value);
}
function displayTime(row, field) {
  const raw = row[field];
  return row[field + "_display"] ?? (recorded(raw) + (raw === null || raw === undefined || raw === "" ? "" : " (invalid time)"));
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
  if (!key) throw new Error("Missing access key. Run tokenflow start again and open the complete URL.");
  const response = await fetch(path + "?" + query, {
    headers: { "X-TokenFlow-Key": key }, cache: "no-store", credentials: "omit", signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Read failed");
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
const toolStates = { success: "Success", failed: "Failed", pending: "Result not recorded yet", unknown: "Status not recorded" };
function toolStatus(status) {
  if (!Object.hasOwn(toolStates, status)) throw new Error("Invalid tool Call status");
  return status === "success" ? "" : " · " + toolStates[status];
}
function activityLabels(tools) {
  const summaries = new Map();
  for (const tool of tools) {
    const key = JSON.stringify([tool.name, tool.summary, tool.status]);
    const item = summaries.get(key);
    if (item) item.count++;
    else summaries.set(key, { tool, count: 1 });
  }
  return [...summaries.values()].map(({ tool, count }) => {
    const summary = ["Arguments not recorded", "Argument format cannot be summarized", "Arguments are too long; expand to view", "Expand to view arguments"].includes(tool.summary) ? "" : " · " + tool.summary;
    return `${tool.name.split(/[.:]/).at(-1)}${summary}${toolStatus(tool.status)}${count > 1 ? ` · ×${count} (same summary)` : ""}`;
  });
}
async function readRoundActivities(sid, query, signal) {
  const data = await readData("/api/sessions/" + encodeURIComponent(sid) + "/rounds/activities", query, signal);
  if (!Array.isArray(data.calls)) throw new Error("Tool summary endpoint returned an invalid result");
  const seen = new Set();
  for (const call of data.calls) {
    if (typeof call.request_id !== "string" || seen.has(call.request_id) || !["matched", "missing", "ambiguous", "unavailable"].includes(call.status)
      || typeof call.message !== "string" || !Array.isArray(call.tools)) throw new Error("Invalid tool summary record");
    seen.add(call.request_id);
    for (const tool of call.tools) if (typeof tool.name !== "string" || typeof tool.summary !== "string" || !Object.hasOwn(toolStates, tool.status)
      || !["skill", "tool"].includes(tool.kind)) throw new Error("Invalid tool summary content");
  }
  return { calls: new Map(data.calls.map(call => [call.request_id, call])), partial: data.partial_tail === true };
}
function toolDetail(tool) {
  if (tool.truncated) throw new Error("Tool endpoint did not return the full Call content");
  if (!Object.hasOwn(toolStates, tool.status)) throw new Error("Invalid tool Call status");
  return disclosure(`${recorded(tool.name)} · ${toolSynopsis(tool)}${toolStatus(tool.status)} · ${displayTime(tool, "timestamp")}`,
    node("h4", "Call arguments"), node("pre", recorded(tool.arguments)),
    node("h4", "Call result"), node("pre", recorded(tool.result)));
}
function metricCards(metrics, count, order = ["calls", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens"]) {
  const cards = node("section", undefined, "metrics");
  const labels = {
    session_count: "Sessions", calls: "Calls", input_tokens: "Input", output_tokens: "Output",
    total_tokens: "Total tokens", cache_read_tokens: "Cache read"
  };
  const fields = count !== undefined ? ["session_count", ...order] : order;
  for (const field of fields) {
    const card = node("div", labels[field], "metric");
    card.setAttribute("data-field", field);
    const value = node("strong", integer(field === "session_count" ? count : metrics[field]));
    value.setAttribute("title", value.textContent);
    card.append(value);
    cards.append(card);
  }
  return cards;
}
function smoothTrendPath(segment) {
  if (!segment.length) return "";
  let path = `M${segment[0].x} ${segment[0].y}`;
  for (let index = 1; index < segment.length; index++) {
    const previous = segment[index - 1], current = segment[index], step = (current.x - previous.x) / 3;
    path += ` C${previous.x + step} ${previous.y} ${current.x - step} ${current.y} ${current.x} ${current.y}`;
  }
  return path;
}
function tokenChart(points, onOpen, onActivities, rounds = false) {
  if (!Array.isArray(points)) throw new Error("Token trend endpoint returned an invalid result");
  const section = node("section", undefined, "token-chart");
  section.setAttribute("aria-label", rounds ? "Session Round token trend" : "Model Call token trend");
  const chartHeading = rounds ? node("div", undefined, "trend-heading") : section;
  if (rounds) {
    chartHeading.append(node("h2", "Session Round token usage trend"));
    section.append(chartHeading);
  }
  if (!points.length) { section.append(node("p", rounds ? "No Rounds with recorded indexes in this range." : "No Call trend data for this Round.")); return section; }
  const series = [["input_tokens", "Input", "trend-input"], ["output_tokens", "Output", "trend-output"], ["cache_read_tokens", "Cache read", "trend-cache"]];
  const areaClass = rounds ? "trend-input" : "trend-output";
  const legend = node("div", undefined, "trend-legend");
  legend.setAttribute("role", "group");
  legend.setAttribute("aria-label", "Series legend");
  for (const [, label, className] of series) legend.append(node("span", label, className));
  chartHeading.append(legend);
  let minimum = 0n, maximum = 0n, known = 0;
  const values = points.map(point => series.map(([key]) => {
    const raw = point[key];
    if (raw === null) return null;
    if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) throw new Error("Token trend value is not a valid integer");
    const value = BigInt(raw);
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    known++;
    return value;
  }));
  if (!known) section.append(node("p", rounds ? "No token metrics were recorded in this range; only Round positions are shown." : "No token metrics were recorded for this Round's Calls; only Call positions are shown.", "notice"));
  if (maximum === minimum) maximum++;
  const chartHeight = rounds ? 240 : 280;
  const left = 12, top = 25, bottom = chartHeight - 50;
  const digits = String(points.length).length;
  const roundWidth = 64;
  const chartWidth = rounds ? points.length * roundWidth : Math.max(740, left + 25 + (points.length - 1) * Math.max(32, digits * 8 + 8));
  const right = rounds ? chartWidth : chartWidth - 25;
  const svg = svgNode("svg", {
    viewBox: `0 0 ${chartWidth} ${chartHeight}`, preserveAspectRatio: "none", role: "group",
    "aria-label": rounds ? "Input, Output, and Cache read token usage trend by Round" : "Input, Output, and Cache read token usage trend by Call"
  });
  const axis = svgNode("svg", {
    viewBox: `0 0 60 ${chartHeight}`, preserveAspectRatio: "none", class: "trend-axis",
    role: "img", "aria-label": "Fixed token axis"
  });
  const backdrop = rounds ? svgNode("svg", {
    viewBox: `0 0 1 ${chartHeight}`, preserveAspectRatio: "none",
    class: "trend-backdrop", "aria-hidden": "true"
  }) : null;
  svg.style.minWidth = chartWidth + "px";
  if (rounds) svg.style.width = chartWidth + "px";
  let span = maximum - minimum;
  const x = index => rounds ? (index + 0.5) * roundWidth
    : points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
  // Pixel scaling uses a bounded fixed-point ratio; accessible labels keep exact token values.
  const y = value => bottom - Number((value - minimum) * 1000000n / span) / 1000000 * (bottom - top);
  const axisLabel = value => {
    const sign = value < 0n ? "-" : "", digits = String(value < 0n ? -value : value);
    return digits.length > 6 ? `${sign}${digits[0]}.${digits.slice(1, 3)}e${digits.length - 1}` : integer(String(value));
  };
  const groups = [];
  let selected = 0, activityState = "idle", activityError = "", partialTail = false;
  const activities = new Map();
  const roundDetails = new Map();
  const detail = node("section", undefined, "trend-tooltip");
  if (rounds) detail.className += " trend-round-tooltip";
  detail.hidden = true;
  detail.setAttribute("aria-live", "polite");
  detail.tabIndex = -1;
  const heading = node("h3"), header = node("div", undefined, "trend-tooltip-header"), detailBody = node("div");
  const open = onOpen && !rounds ? node("button", "View Call details", "trend-detail-open") : null;
  header.append(heading);
  if (open) {
    open.type = "button";
    if (!rounds) open.setAttribute("aria-haspopup", "dialog");
    open.addEventListener("click", () => onOpen(points[selected], groups[selected]));
    header.append(open);
  }
  detail.append(header, detailBody);
  const labels = points.map((point, index) => (rounds ? `Round ${point.turn_index} · ${integer(point.calls)} model Calls` : `Call ${index + 1}`)
    + ` · ${displayTime(point, "created_at")} · Model ${recorded(point.model)} · `
    + series.map(([key, name]) => `${name} ${integer(point[key])}`).join(" · ") + (point.invalid_time ? " · Invalid time; actual order is unknown" : ""));
  const reference = svgNode("line", { y1: top, y2: bottom, class: "trend-reference" });
  let anchor = null;
  function updateAnchor(index, event) {
    if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      anchor = { x: event.clientX, y: event.clientY };
    } else {
      const box = (groups[index].querySelector("circle") || groups[index]).getBoundingClientRect();
      anchor = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
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
    const unchanged = rounds && selected === index && !detail.hidden;
    selected = index;
    if (reveal) {
      clearTimeout(hideTimer);
      if (!unchanged) updateAnchor(index, event);
      detail.hidden = false;
    }
    reference.setAttribute("visibility", detail.hidden ? "hidden" : "visible");
    reference.setAttribute("x1", String(x(index))); reference.setAttribute("x2", String(x(index)));
    groups.forEach((group, position) => group.setAttribute("data-selected", String(!detail.hidden && position === index)));
    const point = points[index];
    heading.textContent = rounds ? `Round ${point.turn_index}` : `Call ${index + 1}`;
    if (rounds) {
      if (!reveal) return;
      if (!roundDetails.has(index)) roundDetails.set(index, roundHoverConversation(point, () => section.isConnected));
      const body = roundDetails.get(index);
      if (!unchanged) {
        for (const group of body.querySelectorAll("details")) group.open = false;
        detail.scrollTop = 0;
      }
      if (detailBody.children[0] !== body) {
        detailBody.replaceChildren(body);
        detail.scrollTop = 0;
      }
      if (!unchanged) positionDetail();
      return;
    }
    detailBody.replaceChildren();
    if (activityState === "loading") detailBody.append(node("p", "Loading tool and skill Summaries for the entire Round…", "muted"));
    else if (activityState === "error") {
      const warning = node("p", "Failed to read tool Summaries: " + activityError);
      warning.setAttribute("role", "alert");
      const retry = node("a", "Reload Summaries");
      retry.href = "#";
      retry.addEventListener("click", event => { event.preventDefault(); loadActivities(); });
      detailBody.append(warning, retry);
    } else {
      const call = activities.get(point.id);
      if (!call) detailBody.append(node("p", "This request was not found in the Summaries; refresh and try again.", "notice"));
      else if (call.status !== "matched") detailBody.append(node("p", call.message, "notice"));
      else {
        if (!call.tools.length) detailBody.append(node("p", "No tool Calls for this Call.", "muted"));
        const unique = activityLabels(call.tools);
        const list = node("ul");
        for (const summary of unique.slice(0, 5)) list.append(node("li", summary));
        if (unique.length) detailBody.append(list);
        if (unique.length > 5) {
          const remaining = node("ul");
          for (const summary of unique.slice(5)) remaining.append(node("li", summary));
          detailBody.append(disclosure(`${unique.length - 5} more activity Summaries`, remaining));
        }
      }
      if (partialTail) detailBody.append(node("p", "The log is still being written; incomplete trailing records are not included in the Summaries yet.", "muted"));
    }
    positionDetail();
  }
  let hideTimer;
  function hideDetails() {
    clearTimeout(hideTimer);
    detail.hidden = true;
    reference.setAttribute("visibility", "hidden");
    groups.forEach(group => group.setAttribute("data-selected", "false"));
  }
  const leaveDetails = event => {
    if (rounds && detail.contains(event?.relatedTarget)) return;
    clearTimeout(hideTimer);
    if (rounds) hideTimer = setTimeout(hideDetails, 250);
    else hideDetails();
  };
  section.addEventListener("pointerleave", leaveDetails);
  if (rounds) {
    detail.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    detail.addEventListener("pointerleave", leaveDetails);
  }
  section.addEventListener("focusout", event => { if (!section.contains(event.relatedTarget)) hideDetails(); });
  section.addEventListener("keydown", event => { if (event.key === "Escape") hideDetails(); });
  async function loadActivities() {
    if (activityState === "loading") return;
    if (!params.has("round") || !params.has("sid")) { activityState = "idle"; showSelected(selected, false); return; }
    activityState = "loading";
    showSelected(selected, false);
    onActivities?.(activityState, activities, activityError, partialTail);
    const query = new URLSearchParams();
    for (const field of ["round", ...dateFields]) if (params.has(field)) query.set(field, params.get(field));
    try {
      const data = await readRoundActivities(params.get("sid"), query);
      if (!section.isConnected) return;
      activities.clear();
      for (const [id, call] of data.calls) activities.set(id, call);
      partialTail = data.partial;
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
    const padding = (maximum - minimum) / 10n;
    maximum += padding || 1n;
    if (minimum < 0n) minimum -= padding;
    if (maximum - minimum < 4n) maximum = minimum + 4n;
    span = maximum - minimum;
    svg.replaceChildren(); axis.replaceChildren(); backdrop?.replaceChildren(); groups.length = 0;
    const defs = svgNode("defs");
    for (const [, , className] of series) {
      if (className !== areaClass) continue;
      const gradient = svgNode("linearGradient", {
        id: `${className}-area`, class: className,
        x1: "0", y1: "0", x2: "0", y2: "1"
      });
      gradient.append(svgNode("stop", { offset: "0%", "stop-color": rounds ? "#246bff" : "var(--series)", "stop-opacity": rounds ? ".30" : ".25" }),
        svgNode("stop", { offset: "100%", "stop-color": rounds ? "#246bff" : "var(--series)", "stop-opacity": rounds ? ".04" : ".02" }));
      defs.append(gradient);
    }
    svg.append(defs);
    const ticks = new Set();
    for (let index = 0n; index <= 4n; index++) {
      const value = minimum + span * index / 4n;
      if (ticks.has(String(value))) continue;
      ticks.add(String(value));
      (backdrop || svg).append(svgNode("line", { x1: 0, x2: backdrop ? 1 : right, y1: y(value), y2: y(value), class: "trend-grid" }));
      axis.append(svgNode("text", { x: 54, y: y(value) + 4, "text-anchor": "end", class: "trend-label" }, axisLabel(value)));
    }
    axis.append(svgNode("text", { x: 54, y: 14, "text-anchor": "end", class: "trend-label" }, "Token"));
    points.forEach((_, index) => svg.append(svgNode("text", {
      x: x(index), y: bottom + 22, "text-anchor": "middle", class: "trend-label trend-index",
    }, rounds ? String(points[index].turn_index) : String(index + 1))));
    series.forEach(([, , className], column) => {
      let path = "", area = "", segment = [];
      function flush() {
        if (!segment.length) return;
        const curve = smoothTrendPath(segment);
        path += curve + " ";
        if (segment.length > 1) area += `${curve} L${segment.at(-1).x} ${y(0n)} L${segment[0].x} ${y(0n)} Z `;
        segment = [];
      }
      values.forEach((row, index) => {
        const value = row[column];
        if (value === null) { flush(); return; }
        if (points[index].invalid_time) flush();
        segment.push({ x: x(index), y: y(value) });
        if (points[index].invalid_time) flush();
      });
      flush();
      if (area && className === areaClass) svg.append(svgNode("path", {
        d: area.trim(), class: "trend-area " + className,
        fill: `url(#${className}-area)`
      }));
      svg.append(svgNode("path", { d: path.trim(), class: "trend-line " + className }));
    });
    svg.append(reference);
    points.forEach((point, index) => {
      const group = svgNode("g", {
        class: "trend-point", tabindex: "0", role: "img",
        "aria-label": labels[index] + (rounds ? " · Press Enter or Space to view this Round's conversation" : onOpen ? " · Press Enter or Space to focus the details button" : "")
      });
      const width = points.length > 1 ? Math.min(24, (right - left) / (points.length - 1)) : 24;
      group.append(svgNode("rect", { x: x(index) - width / 2, y: top, width, height: bottom - top,
        class: "trend-hit", "pointer-events": rounds ? "none" : "all" }));
      values[index].forEach((value, column) => {
        if (value !== null) group.append(svgNode("circle", {
          cx: x(index), cy: y(value), r: 3,
          class: "trend-dot " + series[column][2]
        }));
      });
      group.addEventListener("pointerenter", event => showSelected(index, true, event));
      group.addEventListener("pointerleave", leaveDetails);
      group.addEventListener("pointermove", event => {
        if (detail.hidden || selected !== index) showSelected(index, true, event);
      });
      group.addEventListener("focus", () => showSelected(index));
      group.addEventListener("keydown", event => {
        if ((open || rounds) && ["Enter", " "].includes(event.key)) {
          event.preventDefault();
          if (!event.repeat) {
            showSelected(index);
            (open || detail.querySelector("summary") || detail).focus();
          }
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
  if (backdrop) plot.append(backdrop);
  plot.append(axis, scroll);
  section.append(plot, detail);
  const invalid = points.filter(point => point.invalid_time).length;
  if (invalid) section.append(node("p", rounds
    ? `${invalid} Rounds have invalid times. They appear as separate points ordered by Round index, not actual chronology.`
    : `${invalid} Calls have invalid times. They appear as separate points at the end ordered by request ID, not actual chronology.`, "notice"));
  draw();
  if (!rounds) loadActivities();
  return section;
}
function table(headers, rows, onSelect, pagination, descending = false, numbered = true) {
  const wrapper = node("div", undefined, "scroll");
  wrapper.tabIndex = 0;
  wrapper.setAttribute("role", "region");
  wrapper.setAttribute("aria-label", `${headers[0]} list; scroll vertically or horizontally`);
  const element = node("table");
  const head = node("thead");
  const heading = node("tr");
  for (const title of [...(numbered ? ["No."] : []), ...headers]) {
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
      tr.setAttribute("aria-label", headers[0] === "ID" ? `View request ${row[0]} details` : `View Call ${integer(ordinal)} details`);
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
      if (!event.target.closest("a, details") && !window.getSelection().toString()) row.querySelector("a").click();
    });
  }
}
async function loadTurnTools(tools, turn, read, active) {
  tools.replaceChildren(node("p", "Loading tool activity for this Round…", "muted"));
  tools.setAttribute("aria-busy", "true");
  try {
    let page = 1n, pages = 1n;
    do {
      const data = await read("/api/sessions/" + encodeURIComponent(params.get("sid"))
        + "/turns/" + encodeURIComponent(turn.id) + "/tools", new URLSearchParams({ page: String(page), full: "1" }));
      if (!active()) return;
      if (!["matched", "unavailable", "missing", "ambiguous"].includes(data.status) || typeof data.message !== "string"
        || !Array.isArray(data.tools)) throw new Error("Tool endpoint returned an invalid result");
      if (page === 1n) tools.replaceChildren();
      if (data.partial_tail) tools.append(node("p", "The log is being written; incomplete trailing records are not displayed yet.", "muted"));
      if (data.status !== "matched") {
        const notice = node("p", data.message, "notice");
        tools.append(notice);
        return;
      }
      if (page === 1n && data.scope === "interaction") {
        tools.append(node("p", data.message, "notice"));
      }
      if (BigInt(data.pagination.page) !== page) throw new Error("Tool endpoint returned an invalid page number");
      pages = BigInt(data.pagination.pages);
      if (!data.tools.length) tools.append(node("p", "No main Session tool Calls were recorded in this Round's complete log.", "muted"));
      for (const tool of data.tools) tools.append(toolDetail(tool));
      page++;
    } while (page <= pages && active());
  } finally {
    tools.setAttribute("aria-busy", "false");
  }
}
function roundHoverConversation(point, active) {
  const panel = node("div", undefined, "round-dialogue");
  panel.append(node("p", `${integer(point.calls)} model Calls · Model: ${recorded(point.model)}`, "muted"));
  if (params.has("year")) panel.append(node("p", "Call counts and models use the current date range; conversation and tools show this Round's full recorded content.", "muted"));
  const body = node("div");
  panel.append(body);
  const path = "/api/sessions/" + encodeURIComponent(params.get("sid"));
  const read = (url, query) => readData(url, query);
  async function loadConversation() {
    body.replaceChildren(node("p", "Loading this Round's conversation…", "muted"));
    body.setAttribute("aria-busy", "true");
    try {
      if (typeof point.request_id !== "string") throw new Error("This Round is missing a request ID for the conversation query; refresh the page.");
      const data = await read(path + "/requests/" + encodeURIComponent(point.request_id),
        new URLSearchParams({ view: "matched", full: "1" }));
      if (!active()) return;
      if (!["matched", "missing", "ambiguous", "no_index"].includes(data.association) || !Array.isArray(data.turns)
        || data.request?.turn_index !== point.turn_index) throw new Error("Round conversation endpoint returned an invalid result");
      if (data.association !== "matched") {
        body.replaceChildren(node("p", data.association === "ambiguous" ? "Multiple conversation records exist for this Round; no unique match is possible."
          : "This Round's conversation has not been recorded; another Round's content cannot substitute for it.", "notice"));
        return;
      }
      const turn = data.turns[0];
      if (data.turns.length !== 1 || turn.turn_index !== point.turn_index || turn.truncated) throw new Error("The Round conversation endpoint did not return uniquely matched full content");
      const message = (title, content) => {
        const value = content || (title === "Assistant reply" ? "The assistant reply for this message has not been recorded; another Round's reply cannot substitute for it." : "The user message for this Round was not recorded.");
        const group = disclosure(title, node("pre", value));
        group.querySelector("summary").append(node("span", recorded(content).slice(0, 240), "round-hover-summary"));
        return group;
      };
      const tools = node("div"), toolGroup = disclosure("Main Session tools", tools);
      let toolsStarted = false;
      async function loadTools() {
        try { await loadTurnTools(tools, turn, read, active); }
        catch (error) {
          if (!active()) return;
          const warning = node("p", "Failed to read this Round's tools: " + error.message);
          warning.setAttribute("role", "alert");
          tools.replaceChildren(warning, button("Retry", loadTools));
        }
      }
      toolGroup.addEventListener("toggle", () => {
        if (toolGroup.open && !toolsStarted) { toolsStarted = true; loadTools(); }
      });
      body.replaceChildren(message("User message", turn.user_message), message("Assistant reply", turn.assistant_response),
        node("p", "Main Session tools for this Round; internal subagent Calls are excluded.", "muted"), toolGroup);
    } catch (error) {
      if (!active()) return;
      const warning = node("p", "Failed to read this Round's conversation: " + error.message);
      warning.setAttribute("role", "alert");
      body.replaceChildren(warning, button("Retry", loadConversation));
    } finally { body.setAttribute("aria-busy", "false"); }
  }
  loadConversation();
  return panel;
}
function requestDialog(requestId, trigger, round) {
  const dialog = node("dialog", undefined, "request-dialog");
  const hasRound = round !== undefined;
  let hasRequest = requestId !== undefined;
  const scope = hasRound ? roundQuery(round) : new URLSearchParams(params);
  const roundTitle = round === null ? "Round not recorded · Call details" : `Round ${round} · Call details`;
  let listTitle = roundTitle;
  const heading = node("h2", hasRound ? listTitle : hasRequest ? "Model Call details" : "Session conversation");
  heading.id = "request-detail-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  dialog.setAttribute("aria-describedby", "request-detail-hint");
  dialog.tabIndex = -1;
  const header = node("div", undefined, "dialog-header");
  const hint = node("p", "Click outside the dialog or press Esc to close", "muted");
  hint.id = "request-detail-hint";
  header.append(heading, hint);
  const conversation = node("section");
  conversation.setAttribute("aria-live", "polite");
  const roundList = hasRound ? node("section", undefined, "round-dialog-list") : null;
  let roundCalls, selectedCall, listScroll = 0;
  const back = hasRound ? button("Back to Call list", showCallList) : null;
  if (hasRound) {
    dialog.className += " round-call-dialog";
    roundList.tabIndex = -1;
    roundList.setAttribute("aria-live", "polite");
    conversation.className = "round-dialog-detail";
    conversation.hidden = true;
    back.hidden = true;
    header.replaceChildren(back, heading, hint, button("Close", () => dialog.close()));
  }
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
  if (roundList) dialog.append(roundList);
  function showCallList() {
    generation++;
    controller?.abort();
    hasRequest = false;
    requestId = undefined;
    conversation.hidden = true;
    conversation.replaceChildren();
    conversation.setAttribute("aria-busy", "false");
    roundList.hidden = false;
    back.hidden = true;
    heading.textContent = listTitle;
    dialog.scrollTop = listScroll;
    (selectedCall?.isConnected ? selectedCall : roundList).focus({ preventScroll: true });
  }
  function showCall(id, action) {
    selectedCall = action;
    listScroll = dialog.scrollTop;
    hasRequest = true;
    requestId = id;
    roundList.hidden = true;
    conversation.hidden = false;
    back.hidden = false;
    heading.textContent = "Model Call details";
    dialog.scrollTop = 0;
    back.focus({ preventScroll: true });
    loadConversation();
  }
  async function loadRoundList() {
    const current = ++generation;
    controller?.abort();
    const currentController = controller = new AbortController();
    const active = () => current === generation && dialog.open;
    roundList.replaceChildren(node("p", "Loading Call details for this Round…", "muted"));
    roundList.setAttribute("aria-busy", "true");
    const query = new URLSearchParams();
    for (const field of ["round", ...dateFields]) if (scope.has(field)) query.set(field, scope.get(field));
    try {
      const data = await readData("/api/sessions/" + encodeURIComponent(scope.get("sid")) + "/rounds", query,
        AbortSignal.any([currentController.signal, AbortSignal.timeout(20000)]));
      if (!active()) return;
      const page = data.request_pagination;
      if (data.session?.id !== scope.get("sid") || data.round !== round || !Array.isArray(data.requests)
        || data.requests.length > 10 || !data.requests.every(request => typeof request.id === "string")
        || page?.size !== "10" || BigInt(page.page) !== 1n || BigInt(page.pages) < 1n || BigInt(page.total) < 0n
        || typeof data.metrics?.calls !== "string" || !/^\d+$/.test(data.metrics.calls)
        || (data.metrics.total_tokens !== null && (typeof data.metrics.total_tokens !== "string" || !/^-?\d+$/.test(data.metrics.total_tokens)))) {
        throw new Error("Round Call details endpoint returned an invalid result");
      }
      listTitle = roundTitle + (data.period !== "All" && typeof data.period === "string" ? " · " + data.period : "");
      heading.textContent = listTitle;
      roundCalls = roundCallSection(data, false, { query: scope, dialog, list: roundList, openRequest: showCall });
      roundList.replaceChildren(node("p", `${integer(data.metrics.calls)} Calls total · Round Total tokens ${integer(data.metrics.total_tokens)}`, "call-overview"),
        roundCalls.element);
    } catch (error) {
      if (!active()) return;
      const warning = node("p", error.name === "AbortError" || error.name === "TimeoutError" ? "Call details read timed out; try again." : "Failed to read Call details: " + error.message);
      warning.setAttribute("role", "alert");
      roundList.replaceChildren(warning, button("Retry", loadRoundList));
    } finally {
      if (current === generation) roundList.setAttribute("aria-busy", "false");
    }
  }
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
    conversation.replaceChildren(node("p", hasRequest ? "Loading this model Call…" : "Loading conversation…"));
    conversation.setAttribute("aria-busy", "true");
    const query = hasRequest ? new URLSearchParams() : new URLSearchParams({ turnPage: page, full: "1" });
    try {
      let path = "/api/sessions/" + encodeURIComponent(scope.get("sid"));
      if (hasRequest) path += "/requests/" + encodeURIComponent(requestId) + "/call";
      const data = await read(path, query);
      if (!active()) return;
      if (hasRequest) {
        if (!["matched", "missing", "ambiguous", "unavailable"].includes(data.status) || typeof data.message !== "string"
          || !Array.isArray(data.outputs) || !data.outputs.every(output => typeof output === "string") || !Array.isArray(data.tools)) {
          throw new Error("Call endpoint returned an invalid result");
        }
        conversation.replaceChildren(node("p", data.message, "notice"));
        if (data.partial_tail) conversation.append(node("p", "The log is being written; incomplete trailing records are not displayed yet.", "muted"));
        if (data.status !== "matched") return;
        if (!data.input || !["recorded", "missing", "ambiguous"].includes(data.input.status)) throw new Error("Invalid Input record status");
        const input = disclosure("Input for this Call" + (data.input.status === "recorded" ? "" : " · " + (data.input.status === "missing" ? "Not recorded" : "Cannot uniquely identify")),
          node("p", data.input.message, "muted"));
        if (data.input.status === "recorded") input.append(node("pre", recorded(data.input.content)));
        const output = disclosure(data.outputs.length ? "Model Output for this Call" : data.tools.length ? "This Call's Output is a tool Call" : "Model Output for this Call was not recorded");
        for (const text of data.outputs) output.append(node("pre", text));
        if (!data.outputs.length) output.append(node("p", data.tools.length
          ? "The model returned tool Call instructions with no separate text reply." : "The log has neither Output text nor tool Call instructions for this Call; a final reply cannot substitute for them.", "muted"));
        conversation.append(input, output);
        if (data.tools.length) {
          conversation.append(node("h3", `Tool Calls for this Call · ${integer(data.tools.length)} total`));
          for (const tool of data.tools) conversation.append(toolDetail(tool));
        } else conversation.append(node("p", "No tool Calls were recorded for this Call.", "muted"));
        return;
      }
      if (!Array.isArray(data.turns)) throw new Error("Conversation endpoint returned an invalid result");
      conversation.replaceChildren(node("p", "All recorded conversations in this Session, newest first; they are not all attributed to one request and are not affected by the page's date filter.", "notice"));
      for (const turn of data.turns) {
        const article = node("article");
        article.append(node("h4", "User message"), node("pre", recorded(turn.user_message)),
          node("h4", "Final assistant reply"), node("pre", recorded(turn.assistant_response)));
        if (turn.truncated) throw new Error("Conversation endpoint did not return full content");
        const tools = node("section");
        article.append(node("h4", "Tool activity (same Round, not limited to this request)"), tools);
        conversation.append(disclosure(`Round ${recorded(turn.turn_index)} · ${displayTime(turn, "timestamp")}`, article));
        const loadTools = async () => {
          try {
            await loadTurnTools(tools, turn, read, active);
          } catch (error) {
            if (!active()) return;
            const warning = node("p", `Round ${recorded(turn.turn_index)}: ` + (error.name === "AbortError" ? "Tool activity read timed out; reopen the dialog to try again." : "Failed to read tool activity: " + error.message));
            warning.setAttribute("role", "alert");
            conversation.append(warning);
          }
        };
        await loadTools();
        if (!active()) return;
      }
      if (!hasRequest) {
        if (!data.turns.length) conversation.append(node("p", "No conversation records in the database yet"));
        const pagination = data.turn_pagination, currentPage = BigInt(pagination.page);
        const nav = node("nav");
        nav.setAttribute("aria-label", "Dialog conversation pagination");
        nav.append(node("span", `${integer(pagination.total)} Rounds total, page ${integer(pagination.page)} / ${integer(pagination.pages)}`));
        for (const [label, target] of [["Previous", currentPage - 1n], ["Next", currentPage + 1n]]) {
          if (target >= 1n && target <= BigInt(pagination.pages)) {
            nav.append(actionLink(label, () => loadConversation(view, target.toString())));
          }
        }
        conversation.append(nav);
      }
    } catch (error) {
      if (!active()) return;
      const warning = node("p", error.name === "AbortError" ? "Details read timed out; try again." : "Failed to read details: " + error.message);
      warning.setAttribute("role", "alert");
      conversation.replaceChildren(warning, actionLink("Retry", () => loadConversation(view, page)));
    } finally {
      if (current === generation) conversation.setAttribute("aria-busy", "false");
    }
  }
  dialog.addEventListener("close", () => {
    generation++;
    controller?.abort();
    roundCalls?.dispose();
    dialog.remove();
    const fallback = params.has("round") ? content.querySelector(".round-title") : content;
    (trigger.isConnected ? trigger : fallback || content).focus();
  });
  document.body.append(dialog);
  dialog.showModal();
  dialog.focus();
  if (hasRound) loadRoundList();
  else loadConversation(hasRequest ? "matched" : "all");
}
function pagination(data, field, onPage, localScope) {
  const nav = node("nav");
  nav.setAttribute("aria-label", field === "page" ? "Session pagination" : field === "requestPage" ? "Request pagination" : "Round pagination");
  nav.append(node("span", `${integer(data.total)} records total, page ${integer(data.page)} / ${integer(data.pages)}`));
  const current = BigInt(data.page);
  for (const [label, target] of [["Previous", current - 1n], ["Next", current + 1n]]) {
    if (target >= 1n && target <= BigInt(data.pages)) {
      const next = new URLSearchParams(localScope || params);
      next.set(field, target.toString());
      next.delete("expandedTurn");
      if (localScope) {
        nav.append(button(label, () => onPage(next, label)));
        continue;
      }
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
function roundCallSection(initial, overview = false, dialogView) {
  let data = initial, generation = 0, controller, listing, pageLoading = false;
  let activityState = "idle", activities = new Map(), activityError = "", partial = false;
  const scope = new URLSearchParams(dialogView?.query || params), summaries = new Map();
  const activityController = new AbortController();
  const field = overview ? "rounds" : "requests", pageField = overview ? "roundPage" : "requestPage";
  const paginationField = overview ? "round_pagination" : "request_pagination";
  let firstPage = BigInt(initial[paginationField].page), lastPage = firstPage, lastScrollTop = 0;
  const scrollStatus = node("p", undefined, "round-scroll-status");
  scrollStatus.setAttribute("role", "status");
  const section = node("section", undefined, "round-call-section"), heading = node("h2", overview ? "Round list" : "Model Calls (newest first)");
  heading.tabIndex = -1;
  const warning = node("p");
  warning.hidden = true;
  warning.setAttribute("role", "alert");
  const activityWarning = node("p");
  activityWarning.hidden = true;
  activityWarning.setAttribute("role", "alert");
  const connected = () => section.isConnected && (!dialogView || dialogView.dialog.open);
  function updateActivities(state, calls, reason, tail) {
    activityState = state; activities = calls; activityError = reason; partial = tail;
    for (const [id, cell] of summaries) {
      let text = state === "error" ? "Read failed: " + reason : "Loading Call Summaries…";
      if (state === "ready") {
        const call = calls.get(id);
        if (!call) text = "Call Summaries not found; refresh and try again.";
        else if (call.status !== "matched") text = call.message;
        else {
          const labels = activityLabels(call.tools);
          text = labels.length ? labels.slice(0, 3).join("; ") + (labels.length > 3 ? `; ${labels.length - 3} more` : "") : "No tool Calls for this Call.";
        }
        if (tail) text += " (log being written)";
      }
      cell.textContent = text;
      cell.setAttribute("data-state", state);
      cell.setAttribute("title", text);
    }
    activityWarning.hidden = state !== "error";
    activityWarning.replaceChildren();
    if (state === "error") {
      activityWarning.textContent = "Failed to read activity Summaries: " + reason + " ";
      activityWarning.append(button("Reload Summaries", loadActivities));
    }
  }
  async function loadActivities() {
    if (overview || !connected() || activityState === "loading") return;
    updateActivities("loading", activities, "", partial);
    const query = new URLSearchParams();
    for (const field of ["round", ...dateFields]) if (scope.has(field)) query.set(field, scope.get(field));
    try {
      const result = await readRoundActivities(scope.get("sid"), query,
        AbortSignal.any([activityController.signal, AbortSignal.timeout(20000)]));
      if (connected()) updateActivities("ready", result.calls, "", result.partial);
    } catch (error) {
      if (connected()) updateActivities("error", activities, error.message, partial);
    }
  }
  function createListing(data) {
    if (!overview) for (const request of data.requests) summaries.set(request.id, node("span", undefined, "call-summary"));
    const rows = data[field];
    const listing = !rows.length ? node("p", "No model requests in this range.") : overview
      ? table(["Round", "Calls", "Total tokens", "Model", "Conversation summary", "Action"], rows.map(round => {
        const summary = node("span", recorded(round.summary), "call-summary");
        summary.setAttribute("title", recorded(round.summary));
        const action = button("Call details", () => requestDialog(undefined, action, round.turn_index));
        action.className = "call-detail-open";
        action.setAttribute("aria-haspopup", "dialog");
        action.setAttribute("aria-label", round.turn_index === null ? "View Call details for an unrecorded Round" : `View Round ${round.turn_index} Call details`);
        return [round.turn_index === null ? "Round not recorded" : `Round ${round.turn_index}`,
        integer(round.metrics.calls), integer(round.metrics.total_tokens), node("span", round.models.join(", ") || "Not recorded", "round-models"), summary,
          action];
      }), undefined, data[paginationField], false, false)
      : table(["Model", "Input", "Output", "Cache read", "Total tokens", "Summaries", "Action"],
        data.requests.map((request, index) => {
          const action = button("View", () => dialogView ? dialogView.openRequest(request.id, action) : requestDialog(request.id, action));
          action.className = "call-detail-open";
          action.setAttribute("aria-haspopup", "dialog");
          const ordinal = BigInt(data.request_pagination.total) - (BigInt(data.request_pagination.page) - 1n) * BigInt(data.request_pagination.size) - BigInt(index);
          action.setAttribute("aria-label", `View Call ${integer(ordinal)} details`);
          return [recorded(request.model), ...["input_tokens", "output_tokens", "cache_read_tokens", "total_tokens"].map(key => integer(request[key])),
          summaries.get(request.id), action];
        }), undefined, data.request_pagination, true);
    if (rows.length) {
      listing.className += " round-call-list" + (overview ? " session-round-list" : "");
      listing.setAttribute("aria-label", overview ? "Round list with fixed headers and scrollable content" : "Model Call list with fixed headers and scrollable content");
    }
    return listing;
  }
  function adjacentPage(direction) {
    if (pageLoading || !connected() || !warning.hidden) return;
    const page = direction < 0 ? firstPage - 1n : lastPage + 1n;
    if (page < 1n || page > BigInt(data[paginationField].pages)) return;
    const next = new URLSearchParams(params);
    next.set(pageField, page.toString());
    next.delete("expandedTurn");
    loadPage(next, undefined, direction);
  }
  function scrollPage(direction) {
    if (direction < 0 && listing.scrollTop <= 32) adjacentPage(-1);
    if (direction > 0 && listing.scrollHeight - listing.clientHeight - listing.scrollTop <= 32) adjacentPage(1);
  }
  function updateScrollStatus() {
    scrollStatus.textContent = pageLoading ? "Loading more records…"
      : firstPage === 1n && lastPage === BigInt(data[paginationField].pages) ? "All records shown"
      : "Scroll up or down to load more records";
  }
  function draw(focusLabel) {
    summaries.clear();
    listing = createListing(data);
    const rows = data[field];
    section.replaceChildren(heading, listing);
    if (!dialogView && rows.length) {
      lastScrollTop = 0;
      listing.addEventListener("scroll", () => {
        const direction = listing.scrollTop - lastScrollTop;
        lastScrollTop = listing.scrollTop;
        scrollPage(direction);
      });
      listing.addEventListener("wheel", event => {
        if (!event.shiftKey && Math.abs(event.deltaX || 0) <= Math.abs(event.deltaY)) scrollPage(event.deltaY);
      }, {passive: true});
      listing.addEventListener("keydown", event => {
        if (event.target !== listing) return;
        if (["ArrowDown", "PageDown", "End"].includes(event.key)) scrollPage(1);
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) scrollPage(-1);
      });
      updateScrollStatus();
      section.append(scrollStatus);
    }
    if (dialogView && BigInt(data[paginationField].pages) > 1n) section.append(pagination(data[paginationField], pageField,
      (next, label) => loadPage(next, label), scope));
    section.append(warning);
    if (!overview) section.append(activityWarning);
    updateActivities(activityState, activities, activityError, partial);
    if (focusLabel && (!dialogView || !dialogView.list.hidden)) {
      const target = [...section.querySelectorAll("nav button")].find(action => action.textContent === focusLabel)
        || (rows.length ? listing : heading);
      target.focus({ preventScroll: true });
    }
  }
  async function loadPage(next, focusLabel, direction) {
    const current = ++generation;
    controller?.abort();
    const currentController = controller = new AbortController();
    const timeout = setTimeout(() => currentController.abort(), 20000);
    const active = () => current === generation && connected();
    section.setAttribute("aria-busy", "true");
    pageLoading = true;
    updateScrollStatus();
    warning.hidden = true;
    const query = new URLSearchParams();
    for (const field of [...(overview ? [] : ["round"]), ...dateFields, pageField]) if (next.has(field)) query.set(field, next.get(field));
    try {
      const result = await readData("/api/sessions/" + encodeURIComponent(scope.get("sid")) + "/rounds", query, currentController.signal);
      if (!active()) return;
      const page = result[paginationField];
      if (!Array.isArray(result[field]) || result[field].length > 10 || result.round !== initial.round
        || result.session?.id !== scope.get("sid") || page?.size !== "10"
        || BigInt(page.page) !== BigInt(next.get(pageField) || "1") || BigInt(page.pages) < BigInt(page.page)
        || BigInt(page.total) < 0n || !result[field].every(row => overview ? row.turn_index === null || typeof row.turn_index === "string" : typeof row.id === "string")) {
        throw new Error((overview ? "Round" : "Call") + " list endpoint returned an invalid result");
      }
      if (!dialogView) history.replaceState(null, "", "/?" + next);
      const target = dialogView ? scope : params;
      for (const key of [...target.keys()]) target.delete(key);
      for (const [key, value] of next) target.append(key, value);
      data = result;
      warning.textContent = "";
      if (direction) {
        const incoming = createListing(result).querySelectorAll("tbody tr");
        const body = listing.querySelector("tbody");
        const top = listing.scrollTop, height = listing.scrollHeight;
        if (direction < 0) {
          body.prepend(...incoming);
          firstPage = BigInt(page.page);
          listing.scrollTop = top + listing.scrollHeight - height;
        } else {
          body.append(...incoming);
          lastPage = BigInt(page.page);
          listing.scrollTop = top;
        }
        lastScrollTop = listing.scrollTop;
        updateActivities(activityState, activities, activityError, partial);
      } else draw(focusLabel);
    } catch (error) {
      if (!active()) return;
      warning.replaceChildren();
      warning.textContent = "Failed to read page: " + (error.name === "AbortError" ? "Read timed out; try again." : error.message) + " Previous page data is still displayed.";
      warning.append(button("Retry", () => loadPage(next, focusLabel, direction)));
      warning.hidden = false;
    } finally {
      clearTimeout(timeout);
      if (active()) {
        pageLoading = false;
        updateScrollStatus();
        section.setAttribute("aria-busy", "false");
      }
    }
  }
  draw();
  if (!overview) queueMicrotask(loadActivities);
  return {
    element: section, dispose() {
      generation++;
      controller?.abort();
      activityController.abort();
    }
  };
}
function diagnostics(data) {
  const box = node("p", `Database-wide diagnostics: requests that cannot be date-filtered: ${integer(data.diagnostics.invalid_times)}; `
    + `orphan requests: ${integer(data.diagnostics.orphan_requests)} (excluded from Session totals). The two categories may overlap.`, "notice");
  return box;
}
function setDashboardDate(query, date) {
  const [year, month, day] = date.split("-");
  query.set("year", year);
  query.set("month", String(Number(month)));
  query.set("day", String(Number(day)));
}
function validDashboardDate(value) {
  return typeof value === "string" && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value + "T00:00:00Z"))
    && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
}
function dashboardDateValue(picker) {
  return ["year", "month", "day"].map((field, index) => {
    const value = picker.querySelector(".dashboard-date-" + field).value;
    return value ? value.padStart(index ? 2 : 4, "0") : "";
  }).join("-");
}
function updateDashboardDatePicker(picker, date) {
  const values = date.split("-"), today = serviceToday.split("-").map(Number);
  const selects = picker.querySelectorAll("select");
  for (let index = 0; index < selects.length; index++) {
    let max = today[0];
    if (index === 1) max = Number(values[0]) === today[0] ? today[1] : 12;
    if (index === 2) {
      if (!values[1]) max = 0;
      else {
        const month = new Date(`${values[0].padStart(4, "0")}-${values[1].padStart(2, "0")}-01T00:00:00Z`);
        month.setUTCMonth(Number(values[1]), 0);
        max = Number(values[0]) === today[0] && Number(values[1]) === today[1] ? today[2] : month.getUTCDate();
      }
    }
    const select = selects[index];
    if (select.getAttribute("data-max") !== String(max)) {
      const options = [];
      for (let value = 1; value <= max; value++) {
        const option = node("option", String(value));
        option.value = String(value);
        options.push(option);
      }
      if (!index) options.reverse();
      else {
        const all = node("option", "All");
        all.value = "";
        options.unshift(all);
      }
      select.replaceChildren(...options);
      select.setAttribute("data-max", String(max));
    }
    select.disabled = index === 2 && !values[1];
    values[index] = index && (!values[index] || select.disabled) ? ""
      : String(Math.min(Math.max(Number(values[index]) || 1, 1), max));
    select.value = values[index];
  }
}
function dashboardDateControls() {
  const filter = node("div", undefined, "dashboard-time-filter");
  const periods = node("div", undefined, "dashboard-periods");
  periods.setAttribute("role", "group");
  periods.setAttribute("aria-label", "Date range");
  const form = node("form", undefined, "dashboard-custom-range");
  const dialog = node("dialog", undefined, "request-dialog dashboard-range-dialog");
  const heading = node("h2", "Custom date");
  heading.id = "dashboard-range-heading";
  dialog.setAttribute("aria-labelledby", heading.id);
  const header = node("div", undefined, "dialog-header");
  header.append(heading, button("Close", () => dialog.close()));
  dialog.append(header, form);
  let customAction;
  dialog.addEventListener("close", () => customAction.focus({preventScroll: true}));
  const picker = node("fieldset", undefined, "dashboard-date-picker");
  const parts = node("div", undefined, "dashboard-date-parts");
  picker.append(parts);
  for (const [field, text] of [["year", "Year"], ["month", "Month"], ["day", "Day"]]) {
    const select = node("select", undefined, "dashboard-date-" + field);
    select.name = field;
    select.required = field === "year";
    select.setAttribute("aria-label", text);
    select.addEventListener("change", () => updateDashboardDatePicker(picker, dashboardDateValue(picker)));
    const control = node("label", text);
    control.append(select);
    parts.append(control);
  }
  form.append(picker);
  const apply = node("button", "Apply");
  apply.type = "submit";
  const error = node("p", undefined, "dashboard-range-error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  form.append(apply, button("Cancel", () => dialog.close()), error);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const date = dashboardDateValue(picker), [year, month, day] = date.split("-");
    const today = serviceToday.split("-").map(Number);
    if (!/^(?!0000)\d{4}$/.test(year) || Number(year) > today[0]
      || (month && (!/^\d{2}$/.test(month) || Number(month) < 1 || Number(month) > 12
        || (Number(year) === today[0] && Number(month) > today[1])))
      || (day && (!month || !validDashboardDate(date) || date > serviceToday))) {
      error.textContent = "Select a valid year, month, and day, no later than Today.";
      error.hidden = false;
      return;
    }
    error.hidden = true;
    const query = new URLSearchParams(params);
    for (const field of [...dateFields, "date", "page"]) query.delete(field);
    query.set("year", year);
    if (month) query.set("month", String(Number(month)));
    if (day) query.set("day", String(Number(day)));
    dialog.close();
    load(false, query);
  });
  for (const [value, label] of [["today", "Today"], ["last7", "Last 7 days"], ["custom", "Custom"]]) {
    const action = button(label, () => {
      if (value === "custom") {
        if (!dialog.open) dialog.showModal();
        picker.querySelector("select").focus();
        return;
      }
      const query = new URLSearchParams(params);
      for (const field of [...dateFields, "date", "page"]) query.delete(field);
      query.set("date", value);
      load(false, query);
    });
    if (value === "custom") {
      customAction = action;
      action.setAttribute("aria-haspopup", "dialog");
    }
    action.setAttribute("data-range", value);
    periods.append(action);
  }
  filter.append(periods, dialog);
  return filter;
}
function dashboardSessionQuery(id) {
  const list = new URLSearchParams(params);
  if (list.get("date") === "today" || !["date", ...dateFields].some(field => list.has(field))) {
    list.delete("date");
    setDashboardDate(list, serviceToday);
  }
  if (dashboardRange) {
    list.delete("date");
    for (const field of dateFields) list.delete(field);
    list.set("start", dashboardRange.start);
    list.set("end", dashboardRange.end);
  }
  const query = new URLSearchParams({ sid: id, list: list.toString() });
  for (const field of dateFields) if (list.get(field)) query.set(field, list.get(field));
  return query;
}
function sessionUsageChart(data) {
  const entries = data.session_usage;
  if (!Array.isArray(entries) || !/^\d+$/.test(data.session_count) || BigInt(entries.length) !== BigInt(data.session_count)
    || entries.some(entry => !entry || typeof entry.id !== "string" || !entry.id || typeof entry.title !== "string"
      || (entry.metrics?.total_tokens !== null && (typeof entry.metrics?.total_tokens !== "string" || !/^-?\d+$/.test(entry.metrics.total_tokens))))
    || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Invalid Session usage statistics; refresh and try again.");
  const panel = node("section", undefined, "session-usage");
  panel.setAttribute("aria-label", "All Session usage in the current filter range");
  panel.append(node("h2", "Session token usage"));
  if (!entries.length) {
    panel.append(node("p", "No Sessions match the current filters.", "top-empty"));
    return panel;
  }
  const values = entries.map(entry => entry.metrics.total_tokens === null ? null : BigInt(entry.metrics.total_tokens));
  let minimum = 0n, maximum = 0n;
  for (const value of values) if (value !== null) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  if (maximum - minimum < 4n) maximum = minimum + 4n;
  const span = maximum - minimum;
  const y = value => 190 - Number((value - minimum) * 1000000n / span) / 1000000 * 162;
  const zero = y(0n);
  const step = 48, chartWidth = entries.length * step + 110;
  const plot = node("div", undefined, "session-usage-plot");
  const axis = svgNode("svg", {viewBox:"0 0 64 320",preserveAspectRatio:"none",class:"session-usage-axis",role:"img","aria-label":"Token usage axis"});
  axis.append(svgNode("text", {x:56,y:14,"text-anchor":"end",class:"session-usage-axis-title"}, "Token"),
    svgNode("line", {x1:63,x2:63,y1:28,y2:190,class:"session-usage-grid"}));
  const scroll = node("div", undefined, "session-usage-scroll");
  scroll.tabIndex = 0;
  scroll.setAttribute("role", "region");
  scroll.setAttribute("aria-label", "All Session bars; scroll horizontally and click a Session to view details");
  const svg = svgNode("svg", {viewBox:`0 0 ${chartWidth} 320`,preserveAspectRatio:"none",role:"group","aria-label":"Session summary axis and token usage bars"});
  svg.style.width = chartWidth + "px";
  const compact = new Intl.NumberFormat("en", {notation:"compact",maximumFractionDigits:1});
  const scientific = new Intl.NumberFormat("en", {notation:"scientific",maximumFractionDigits:1});
  for (let index = 0; index <= 4; index++) {
    const value = minimum + span * BigInt(index) / 4n;
    const text = compact.format(value);
    axis.append(svgNode("text", {x:56,y:y(value)+4,"text-anchor":"end",class:"session-usage-tick"},
      text.length > 7 ? scientific.format(value) : text));
    svg.append(svgNode("line", {x1:0,x2:entries.length*step,y1:y(value),y2:y(value),class:"session-usage-grid"}));
  }
  svg.append(svgNode("line", {x1:0,x2:entries.length*step,y1:zero,y2:zero,class:"session-usage-baseline"}));
  for (const [index, entry] of entries.entries()) {
    const label = `${entry.title} · ${entry.id} · ${recorded(entry.project)} · ${integer(entry.metrics.total_tokens)} Token`;
    const action = svgNode("a", {href:"/?" + dashboardSessionQuery(entry.id),class:"session-usage-bar",tabindex:0,"aria-label":label});
    const x = index * step + 7, center = x + 17;
    action.append(svgNode("title", {}, label),
      svgNode("rect", {x:index*step,y:28,width:step,height:162,fill:"transparent",class:"session-usage-hit"}));
    const value = values[index];
    if (value !== null && value !== 0n) {
      const height = Math.max(1, Math.abs(y(value) - zero));
      action.append(svgNode("rect", {x,y:value > 0n ? zero - height : zero,width:34,height,rx:3,fill:"#246bff",class:"session-usage-column"}));
    } else if (value === null) {
      action.append(svgNode("text", {x:center,y:zero-8,"text-anchor":"middle",class:"session-usage-unknown"}, "Unknown"));
    }
    const title = Array.from(entry.title);
    action.append(svgNode("text", {x:center,y:212,transform:`rotate(45 ${center} 212)`,class:"session-usage-name"},
      title.length > 8 ? title.slice(0, 8).join("") + "…" : entry.title));
    svg.append(action);
  }
  scroll.append(svg);
  plot.append(axis, scroll);
  panel.append(plot, node("p", `Same order as the details list · ${entries.length} Sessions total`, "top-caption"));
  return panel;
}
function dashboardTrend(points) {
  if (!Array.isArray(points)) throw new Error("Invalid token usage trend data; refresh and try again.");
  const panel = node("section", undefined, "dashboard-trend");
  const heading = node("div", undefined, "analysis-heading");
  const controls = node("div", undefined, "analysis-controls");
  const series = [
    ["input_tokens", "Input", "#0891b2", ""],
    ["output_tokens", "Output", "#246bff", "6 3"],
    ["cache_read_tokens", "Cache read", "#7c3aed", "2 3"],
  ];
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Trend legend");
  for (const [key, label] of series) {
    const legend = node("span", label, "dashboard-chart-legend");
    legend.setAttribute("data-field", key);
    controls.append(legend);
  }
  heading.append(node("h2", "Token usage trend"), controls);
  const plot = node("div", undefined, "dashboard-chart");
  plot.tabIndex = 0;
  plot.setAttribute("role", "region");
  plot.setAttribute("aria-label", "Token usage trend; scroll horizontally");
  const tooltip = node("div", undefined, "dashboard-chart-tooltip");
  tooltip.hidden = true;
  tooltip.setAttribute("role", "status");
  plot.addEventListener("scroll", () => { tooltip.hidden = true; });
  panel.append(heading, plot, tooltip);
  function draw() {
    plot.replaceChildren();
    tooltip.hidden = true;
    if (!points.length) { plot.append(node("p", "No token usage data with valid timestamps in this range.", "top-empty")); return; }
    const values = points.map(point => series.map(([key]) => {
      if (typeof point.time !== "string") throw new Error("Invalid token usage trend time");
      const value = point[key];
      if (value === null) return null;
      if (typeof value !== "string" || !/^-?\d+$/.test(value)) throw new Error("Invalid token usage trend value");
      return BigInt(value);
    }));
    let minimum = 0n, maximum = 0n;
    for (const row of values) for (const value of row) if (value !== null) {
      if (value < minimum) minimum = value;
      if (value > maximum) maximum = value;
    }
    const padding = (maximum - minimum) / 10n;
    maximum += padding || 1n;
    if (minimum < 0n) minimum -= padding;
    if (maximum - minimum < 4n) maximum = minimum + 4n;
    const chartWidth = Math.max(620, 80 + (points.length - 1) * 64);
    const left = 62, right = chartWidth - 18, top = 18, bottom = 268;
    const x = index => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
    const y = value => bottom - Number((value - minimum) * 1000000n / (maximum - minimum)) / 1000000 * (bottom - top);
    const svg = svgNode("svg", {
      viewBox: `0 0 ${chartWidth} 310`, preserveAspectRatio: "none",
      role: "group", "aria-label": "Token usage trend: Input, Output, Cache read; focus a point to view its time and exact usage"
    });
    svg.style.minWidth = chartWidth + "px";
    const defs = svgNode("defs");
    const gradient = svgNode("linearGradient", { id: "dashboard-area-input_tokens", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(svgNode("stop", { offset: "0%", "stop-color": "#246bff", "stop-opacity": ".30" }),
      svgNode("stop", { offset: "100%", "stop-color": "#246bff", "stop-opacity": ".04" }));
    defs.append(gradient);
    svg.append(defs);
    const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
    for (let index = 0; index <= 4; index++) {
      const value = minimum + (maximum - minimum) * BigInt(index) / 4n;
      svg.append(svgNode("line", { x1: left, x2: right, y1: y(value), y2: y(value), class: "dashboard-grid" }),
        svgNode("text", { x: left - 14, y: y(value) + 4, "text-anchor": "end", class: "trend-label" }, compact.format(value)));
    }
    series.forEach(([key, , color, dash], column) => {
      let segment = [];
      function flush() {
        if (!segment.length) return;
        const path = smoothTrendPath(segment);
        if (segment.length > 1 && key === "input_tokens") svg.append(svgNode("path", {
          d: `${path} L${segment.at(-1).x} ${y(0n)} L${segment[0].x} ${y(0n)} Z`,
          class: "dashboard-area", fill: `url(#dashboard-area-${key})`,
        }));
        svg.append(svgNode("path", {
          d: path, class: "dashboard-line", "data-field": key,
          stroke: color, "stroke-dasharray": dash
        }));
        segment = [];
      }
      values.forEach((row, index) => {
        const value = row[column];
        if (value === null) flush();
        else segment.push({ x: x(index), y: y(value) });
      });
      flush();
    });
    const labelStep = Math.max(1, Math.ceil((points.length - 1) / Math.floor((right - left) / 90)));
    points.forEach((point, index) => {
      if (index % labelStep === 0 || index === points.length - 1) svg.append(svgNode("text",
        { x: x(index), y: bottom + 26, "text-anchor": "middle", class: "trend-label" },
        point.time.includes(" ") ? point.time.slice(11) : point.time.slice(5)));
      series.forEach(([key, name, color], column) => {
        const value = values[index][column];
        if (value === null) return;
        const label = `${point.time} · ${name} ${integer(point[key])}`;
        const circle = svgNode("circle", {
          cx: x(index), cy: y(value), r: 3.5, tabindex: "0",
          class: "dashboard-dot", stroke: color, "data-field": key, "aria-label": label
        });
        circle.append(svgNode("title", {}, label));
        const show = () => {
          tooltip.replaceChildren(node("span", point.time));
          for (const [field, title] of series) tooltip.append(node("span", title), node("strong", integer(point[field])));
          tooltip.hidden = false;
          const box = panel.getBoundingClientRect(), dot = circle.getBoundingClientRect();
          const tip = tooltip.getBoundingClientRect();
          tooltip.style.left = Math.max(8, Math.min(dot.left - box.left - tip.width / 2, box.width - tip.width - 8)) + "px";
          tooltip.style.top = Math.max(8, dot.top - box.top - tip.height - 12) + "px";
        };
        circle.addEventListener("pointerenter", show);
        circle.addEventListener("focus", show);
        circle.addEventListener("pointerleave", () => { tooltip.hidden = true; });
        circle.addEventListener("blur", () => { tooltip.hidden = true; });
        circle.addEventListener("keydown", event => { if (event.key === "Escape") tooltip.hidden = true; });
        svg.append(circle);
      });
    });
    plot.append(svg);
    if (values.some(row => row.some(value => value === null))) plot.append(node("p", "Unrecorded token values remain gaps, not zeroes.", "top-caption"));
  }
  draw();
  return panel;
}
function dashboardPagination(data) {
  const footer = node("nav", undefined, "dashboard-pagination");
  footer.setAttribute("aria-label", "Session pagination");
  footer.append(node("span", `${integer(data.total)} records total`));
  const controls = node("div", undefined, "pagination-controls");
  const size = node("select");
  size.setAttribute("aria-label", "Page size");
  for (const value of ["10", "20", "50", "100"]) {
    const option = node("option", `${value} per page`);
    option.value = value;
    size.append(option);
  }
  size.value = String(data.size);
  size.addEventListener("change", () => {
    const query = new URLSearchParams(params);
    query.set("pageSize", size.value);
    query.delete("page");
    location.search = query.toString();
  });
  controls.append(size);
  const current = BigInt(data.page), pages = BigInt(data.pages);
  const targets = [...new Set([1n, current - 1n, current, current + 1n, current + 2n, pages].filter(page => page >= 1n && page <= pages))]
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  function pageLink(label, target, aria) {
    if (target < 1n || target > pages) {
      const disabled = button(label, () => { });
      disabled.disabled = true;
      disabled.setAttribute("aria-label", aria);
      return disabled;
    }
    const query = new URLSearchParams(params);
    query.set("page", String(target));
    const action = link(label, query);
    action.setAttribute("aria-label", aria);
    if (target === current && label === String(current)) action.setAttribute("aria-current", "page");
    return action;
  }
  controls.append(pageLink("‹", current - 1n, "Previous"));
  targets.forEach((target, index) => {
    if (index && target - targets[index - 1] > 1n) controls.append(node("span", "…", "pagination-gap"));
    controls.append(pageLink(String(target), target, `Page ${target}`));
  });
  controls.append(pageLink("›", current + 1n, "Next"));
  footer.append(controls);
  return footer;
}
function renderDashboard(data, automatic = false) {
  if (!Array.isArray(data.repositories) || !Array.isArray(data.model_types)
    || [...data.repositories, ...data.model_types].some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("Invalid repository or model filter options; refresh and try again.");
  }
  if (!validDashboardDate(data.today)) {
    throw new Error("Invalid service-local date; refresh and try again.");
  }
  serviceToday = data.today;
  dashboardRange = data.range_start && data.range_end ? { start: data.range_start, end: data.range_end } : null;
  const usage = sessionUsageChart(data);
  const previousUsage = automatic ? content.querySelector(".session-usage-scroll") : null;
  const usageScrollLeft = previousUsage?.scrollLeft;
  if (!["date", ...dateFields].some(field => params.has(field))) {
    if (data.period !== data.today) throw new Error("Invalid default date statistics; refresh and try again.");
    setDashboardDate(params, data.today);
    history.replaceState(null, "", "/?" + params);
  }
  document.body.className = "dashboard-page";
  const previousList = automatic ? content.querySelector(".scroll") : null;
  const scroll = previousList ? { top: previousList.scrollTop, left: previousList.scrollLeft, x: window.scrollX, y: window.scrollY } : null;
  const overview = content.querySelector(".dashboard-overview") || node("section", undefined, "dashboard-overview");
  const title = overview.querySelector(".dashboard-title") || node("div", undefined, "dashboard-title");
  if (!title.children.length) title.append(node("h1", "Token usage"), dashboardDateControls());
  const filter = title.querySelector(".dashboard-time-filter");
  const custom = params.has("start") || params.has("end") || (params.get("date") !== "last7" && data.period !== data.today);
  for (const action of filter.querySelector(".dashboard-periods").children) {
    const value = action.getAttribute("data-range");
    action.setAttribute("aria-pressed", String(value === "custom" ? custom
      : value === "last7" ? params.get("date") === "last7" : !custom && data.period === data.today));
  }
  const picker = filter.querySelector(".dashboard-date-picker");
  const rangeKey = ["date", ...dateFields].map(field => params.get(field) || "").join("|");
  if (filter.getAttribute("data-applied-range") !== rangeKey) {
    const date = params.get("year") ? [params.get("year").padStart(4, "0"), params.get("month") || "", params.get("day") || ""].join("-")
      : params.get("start") || dashboardRange?.start || (validDashboardDate(data.period) ? data.period : serviceToday);
    updateDashboardDatePicker(picker, date);
    filter.querySelector(".dashboard-range-error").hidden = true;
    filter.setAttribute("data-applied-range", rangeKey);
  } else {
    updateDashboardDatePicker(picker, dashboardDateValue(picker));
  }
  const metrics = metricCards(data.metrics, undefined, ["total_tokens", "input_tokens", "output_tokens"]);
  metrics.className += " dashboard-metrics";
  for (const card of metrics.children) {
    const raw = data.metrics[card.getAttribute("data-field")];
    if (raw !== null && raw !== undefined) {
      const value = BigInt(raw), magnitude = value < 0n ? -value : value;
      const hundredths = (magnitude + 5000n) / 10000n;
      card.append(node("span", `≈${value < 0n ? "-" : ""}${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}M`, "metric-unit"));
    }
  }
  overview.replaceChildren(title, metrics);
  const summary = node("div", undefined, "dashboard-summary");
  const analyses = node("div", undefined, "dashboard-analyses");
  analyses.append(dashboardTrend(data.usage_trend), usage);
  const details = node("section", undefined, "dashboard-details");
  const detailHeading = node("div", undefined, "detail-heading");
  detailHeading.append(node("h2", "Session details"));
  const period = node("span", [`Current range: ${data.period}`, params.get("repository") ? `Repository: ${params.get("repository")}` : "",
  params.get("model") ? `Model: ${params.get("model")}` : ""].filter(Boolean).join(" · "), "filter-period");
  detailHeading.setAttribute("title", period.textContent);
  details.append(detailHeading);
  const rows = data.sessions.map(session => {
    const query = dashboardSessionQuery(session.id);
    const identity = node("div", undefined, "session-identity");
    const title = link(session.title, query);
    title.setAttribute("title", title.textContent);
    identity.append(title);
    const view = link("View", query);
    view.setAttribute("aria-label", `View Session ${session.title} (${session.id})`);
    return [
      identity, session.project, integer(session.metrics.total_tokens), integer(session.metrics.calls),
      session.models.join(", ") || "—", displayTime(session, "latest_request"), view,
    ].map(value => {
      const cell = value instanceof Node ? value : node("span", value);
      if (!(value instanceof Node)) cell.setAttribute("title", cell.textContent);
      return cell;
    });
  });
  const listing = table(["Session summary", "Project", "Total tokens", "Calls", "Model", "Latest request", "Action"],
    rows, undefined, data.pagination, false, false);
  listing.className += " session-list";
  if (!rows.length) listing.className += " session-list-empty";
  followTableLinks(listing);
  details.append(listing);
  if (!data.sessions.length) details.append(node("p", "No Sessions in this range; adjust the date range.", "dashboard-empty"));
  details.append(dashboardPagination(data.pagination), period);
  summary.append(analyses, details);
  const children = [overview, summary];
  if (["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) children.push(diagnostics(data));
  content.replaceChildren(...children);
  const usageScroll = usage.querySelector(".session-usage-scroll");
  if (previousUsage && usageScroll) usageScroll.scrollLeft = usageScrollLeft;
  if (scroll) {
    const listing = content.querySelector(".scroll");
    if (listing) { listing.scrollTop = scroll.top; listing.scrollLeft = scroll.left; }
    window.scrollTo(scroll.x, scroll.y);
  }
}
function detailBreadcrumb(title, round = false) {
  const navigation = node("nav", undefined, "detail-breadcrumb");
  navigation.setAttribute("aria-label", "Breadcrumbs");
  const original = new URLSearchParams(params.get("list") || "");
  navigation.append(link("Token usage", original));
  if (round) {
    const overview = new URLSearchParams(params);
    for (const field of ["round", "requestPage", "turnPage", "expandedTurn"]) overview.delete(field);
    const session = link(title, overview);
    session.setAttribute("title", title);
    navigation.append(session);
  }
  const current = node("span", round ? "Call details" : title);
  current.setAttribute("title", current.textContent);
  current.setAttribute("aria-current", "page");
  const home = link("Home", original);
  home.className = "detail-home";
  navigation.append(current, home);
  return navigation;
}
function renderRoundOverview(data) {
  if (!Array.isArray(data.round_trend)) throw new Error("Round trend endpoint returned an invalid result");
  document.body.className = "session-page";
  const info = node("section", undefined, "session-info");
  const original = new URLSearchParams(params.get("list") || "");
  const actions = node("span", undefined, "session-actions");
  const all = new URLSearchParams(params);
  for (const field of [...dateFields, "roundPage"]) all.delete(field);
  if (dateFields.some(field => params.has(field))) {
    actions.append(node("span", data.period, "muted"), link("All", all));
  } else if (dateFields.some(field => original.get(field))) {
    const restored = new URLSearchParams(all);
    for (const field of dateFields) if (original.get(field)) restored.set(field, original.get(field));
    actions.append(link("Restore original date range", restored));
  }
  const records = button("All Session records", () => requestDialog(undefined, records));
  records.className = "text-action";
  records.setAttribute("aria-haspopup", "dialog");
  actions.append(records);
  const fields = node("dl", undefined, "session-fields");
  for (const [key, label] of [["cwd", "Working directory"], ["id", "Session ID"]]) {
    const field = node("div", undefined, "session-field");
    const text = recorded(data.session[key]);
    const value = node("dd", text);
    value.setAttribute("title", text);
    field.append(node("dt", label), value);
    fields.append(field);
  }
  info.append(fields);
  const metrics = metricCards(data.metrics, undefined, ["total_tokens", "input_tokens", "output_tokens", "cache_read_tokens"]);
  metrics.className += " compact-metrics session-metrics";
  info.append(metrics);
  content.append(detailBreadcrumb(recorded(data.session.title ?? data.session.summary)), info);
  if (["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) content.append(diagnostics(data));
  const points = data.round_trend.filter(round => round.turn_index !== null).map(round => ({
    id: round.turn_index, turn_index: round.turn_index, ...round.metrics,
    created_at: round.first_request, created_at_display: round.first_request_display, model: round.models.join(", "),
    request_id: round.request_id,
    summary: round.summary, summary_status: round.summary_status, invalid_time: round.invalid_time,
  }));
  const chart = tokenChart(points, undefined, undefined, true);
  const missing = data.round_trend.length - points.length;
  if (missing) chart.append(node("p", `${missing} request groups have no recorded Round index. They remain in lists and totals; no chart position is inferred.`, "notice"));
  const calls = roundCallSection(data, true);
  calls.element.querySelector("h2").append(actions);
  const analysis = node("div", undefined, "session-analysis");
  analysis.append(chart, calls.element);
  content.append(analysis);
}
function renderSession(data) {
  if (!params.has("round") && Array.isArray(data.rounds)) { renderRoundOverview(data); return; }
  const original = new URLSearchParams(params.get("list") || "");
  const navigation = node("nav");
  const roundView = params.has("round");
  const roundCalls = roundView ? roundCallSection(data) : null;
  document.body.className = roundView ? "round-page" : "";
  if (roundView) {
    content.append(detailBreadcrumb(recorded(data.session.title ?? data.session.summary), true));
    const heading = node("h1", params.get("round") === "missing" ? "Round not recorded · Call details" : `Round ${recorded(data.round)} · Call details`, "round-title");
    heading.tabIndex = -1;
    if (data.period !== "All") heading.append(node("span", " · " + data.period, "round-period"));
    const top = node("div", undefined, "round-heading");
    const overviewQuery = new URLSearchParams(params);
    for (const field of ["round", "requestPage", "turnPage", "expandedTurn"]) overviewQuery.delete(field);
    top.append(link("Back to Session overview", overviewQuery), heading);
    content.append(top, node("p", `${integer(data.metrics.calls)} Calls total · Round Total tokens ${integer(data.metrics.total_tokens)}`, "call-overview"));
  } else {
    navigation.append(link("Back to Session list", original));
    const all = new URLSearchParams(params);
    for (const field of [...dateFields, "requestPage", "expandedTurn", "roundPage"]) all.delete(field);
    navigation.append(link("View Session across All dates", all));
    if (dateFields.some(field => original.get(field))) {
      const restored = new URLSearchParams(all);
      for (const field of dateFields) if (original.get(field)) restored.set(field, original.get(field));
      navigation.append(link("Restore original date range", restored));
    }
    content.append(navigation, node("h2", data.session.title));
    const definition = node("dl");
    for (const [key, title] of [["id", "Session ID"], ["summary", "Summary"], ["repository", "Repository"],
    ["cwd", "Working directory"], ["branch", "Branch"], ["host_type", "Host type"],
    ["created_at", "Created"], ["updated_at", "Updated"]]) {
      definition.append(node("dt", title), node("dd", key.endsWith("_at") ? displayTime(data.session, key) : recorded(data.session[key])));
    }
    content.append(definition, node("h2", (dateFields.some(field => params.has(field)) ? "Current range usage: " : "All date usage: ") + data.period), metricCards(data.metrics));
  }
  if (!roundView || ["invalid_times", "orphan_requests"].some(key => data.diagnostics[key] !== "0")) content.append(diagnostics(data));
  if (roundView) {
    content.append(roundCalls.element);
    return;
  }
  if (!roundView) {
    const viewAll = button("All Session records", () => requestDialog(undefined, viewAll));
    content.append(viewAll);
  }
  content.append(node("h2", "Model request details (newest first)"));
  if (!roundView) content.append(node("p", "Each row is one model Call. Click to view its Output and tool details. The raw Round index is source data only; duration and time to first token are in milliseconds.", "muted"));
  if (data.requests.length === 0) content.append(node("p", "No model requests in this range."));
  else {
    const headers = ["ID", "Time", "Actual model", "Input", "Output", "Total tokens", "Cache read",
      "Duration ms", "First token ms", "Raw Round index", "Agent", "Initiator", "Finish reason"];
    const rows = data.requests.map(requestValues);
    if (!roundView) content.append(node("p", "Click a request row to view details, or press Enter or Space.", "muted"));
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
  return document.hidden || content.querySelector(".dashboard-range-dialog")?.open
    || (document.activeElement && document.activeElement !== content && content.contains(document.activeElement))
    || Boolean(window.getSelection().toString());
}
async function load(automatic = false, nextParams = null) {
  if (loading && !nextParams) return;
  if (automatic && refreshPaused()) { scheduleRefresh(); return; }
  loadController?.abort();
  loadController = new AbortController();
  const revision = ++loadRevision;
  loading = true;
  const previousStatus = status.textContent;
  status.textContent = "Loading…";
  content.setAttribute("aria-busy", "true");
  if (!automatic) errorBox.hidden = true;
  try {
    const query = new URLSearchParams();
    const scope = nextParams || params;
    const sid = scope.get("sid");
    const fields = sid ? [...dateFields, ...(params.has("round") ? ["round", "requestPage"] : ["roundPage"])]
      : ["date", ...dateFields, "page", "pageSize", "sort", "repository", "model"];
    for (const field of fields) if (scope.has(field)) query.set(field, scope.get(field));
    if (!sid && !["date", ...dateFields].some(field => scope.has(field))) query.set("date", "today");
    if (!sid && !scope.has("pageSize")) query.set("pageSize", "10");
    const path = sid ? "/api/sessions/" + encodeURIComponent(sid) + "/rounds" : "/api/dashboard";
    const data = await readData(path, query, AbortSignal.any([loadController.signal, AbortSignal.timeout(20000)]));
    if (revision !== loadRevision) return;
    if (automatic && refreshPaused()) { status.textContent = previousStatus; return; }
    if (sid) { content.replaceChildren(); renderSession(data); }
    else {
      const previousParams = new URLSearchParams(params);
      if (nextParams) {
        for (const key of [...params.keys()]) params.delete(key);
        for (const [key, value] of nextParams) params.set(key, value);
      }
      try { renderDashboard(data, automatic); }
      catch (error) {
        for (const key of [...params.keys()]) params.delete(key);
        for (const [key, value] of previousParams) params.set(key, value);
        throw error;
      }
      if (nextParams) history.replaceState(null, "", "/?" + params);
    }
    lastRead = displayTime(data, "read_at");
    document.getElementById("metadata").textContent =
      `Source: ${data.source} · OS-local time zone: ${data.timezone} (restart after changing) · Last successful read: ${lastRead}`;
    const period = content.querySelector(".filter-period");
    period?.setAttribute("title", period.textContent + " · " + document.getElementById("metadata").textContent);
    errorBox.hidden = true;
    status.textContent = "Read complete";
  } catch (error) {
    if (revision !== loadRevision) return;
    errorBox.hidden = false;
    errorBox.textContent = `${lastRead ? "Data is stale (last successful read: " + lastRead + ")." : ""}`
      + `${error.message} If the service is unavailable, run tokenflow start.`;
    status.textContent = "Read failed";
    if (!content.children.length) {
      content.append(link("Back to Session list", new URLSearchParams(params.get("list") || "")),
        link("Reset to Today", new URLSearchParams()));
    }
  } finally {
    if (revision === loadRevision) {
      loading = false;
      content.setAttribute("aria-busy", "false");
      scheduleRefresh();
    }
  }
}
if (!params.has("sid")) document.addEventListener("visibilitychange", () => {
  clearTimeout(refreshTimer);
  if (!document.hidden) load(true);
});
load();
