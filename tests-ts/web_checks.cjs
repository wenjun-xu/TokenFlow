"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM records text/links; this is not a real-browser acceptance claim.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ""; this.style = {}; }
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  prepend(...children) { for (const child of children) child.parent = this; this.children.unshift(...children); }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll(selector) {
    if (selector === "tbody tr") return descendants(this.querySelector("tbody")).filter(node => node.tag === "tr");
    return descendants(this).filter(node => node.tag === selector);
  }
  querySelector(selector) { return descendants(this).find(node => selector.startsWith(".")
    ? (node.className || node.attributes.class)?.split(" ").includes(selector.slice(1)) : node.tag === selector) || null; }
  contains(node) { return descendants(this).includes(node); }
  get isConnected() { return this.tag === "body" || Boolean(this.parent?.isConnected); }
  focus() { focused = this; }
  getBoundingClientRect() { return {left: 100, right: 700, top: 100, bottom: 550, width: 600, height: 450}; }
  showModal() { this.open = true; descendants(this).find(child => child.autofocus)?.focus(); }
  close() { this.open = false; this.events.close?.(); }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
}
const elements = new Map(["content", "status", "error", "metadata"].map(id => [id, new Element("div")]));
const body = new Element("body");
body.append(...elements.values());
let focused, selection = "", fetchCount = 0, failNext = false, deferNext = false, deferTools = false, failTools = false, callStatus = "matched";
let holdActivities = false;
let roundAssociation = "matched", sharedToolScope = false, roundReplyRecorded = true;
const heldActivities = [];
const calls = [];
const dialogueText = "<script>synthetic user message</script>\n\u4e2d\u6587" + "x".repeat(1000);
const storage = new Map();
const location = {
  hash: "#key=synthetic-secret", pathname: "/",
  search: "?sid=s&year=2024&month=2&day=29&list=" + encodeURIComponent("year=2024&month=2&day=29&page=3"),
};
const history = {pushes: [], replaceState(_, __, url) { history.url = url; location.search = url.slice(url.indexOf("?")); },
  pushState(_, __, url) { this.pushes.push(url); location.search = url.slice(url.indexOf("?")); }};
const context = vm.createContext({
  document: {body, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), getElementById: id => elements.get(id)},
  Node: Element, URLSearchParams, location, history, AbortSignal, AbortController, setTimeout, clearTimeout, queueMicrotask,
  sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
  fetch: (url, options) => {
    fetchCount++;
    if (fetchCount === 1) return new Promise(() => {});
    calls.push({url, ...options});
    if (holdActivities && url.includes("/rounds/activities?")) return new Promise(resolve => heldActivities.push(resolve));
    if (deferNext || (deferTools && url.includes("/tools?"))) {
      deferNext = false;
      deferTools = false;
      return new Promise((_, reject) => options.signal.addEventListener("abort",
        () => reject(new DOMException("Aborted", "AbortError")), {once: true}));
    }
    const query = new URLSearchParams(url.split("?")[1]);
    const failed = failNext || (failTools && url.includes("/tools?"));
    failNext = false;
    if (url.includes("/tools?")) failTools = false;
    const id = query.get("turnPage") === "2" ? "9" : "8";
    const requestRound = url.includes("/requests/0?") ? "0" : vm.runInContext('params.get("round")', context) ?? "61";
    return Promise.resolve({
      ok: !failed,
      json: async () => failed ? {error: "synthetic query failure"} : url.includes("/rounds/activities?") ? {
        partial_tail: false, calls: [
          {request_id: "1", status: "matched", message: "matched", tools: [
            {name: "functions.skill", summary: "Load ponytail", kind: "skill", status: "success"},
            {name: "functions.view", summary: "View src/store.ts", kind: "tool", status: "pending"},
            {name: "functions.view", summary: "View src/store.ts", kind: "tool", status: "pending"},
            {name: "functions.apply_patch", summary: "Argument format cannot be summarized", kind: "tool", status: "success"}]},
          {request_id: "2", status: "matched", message: "matched", tools: []},
          {request_id: "3", status: "ambiguous", message: "This Call cannot be uniquely linked", tools: []},
        ],
      } : url.includes("/rounds?") ? {
        ...(context.roundDialogData || context.pagingData),
        round: context.roundDialogData ? query.get("round") === "missing" ? null : query.get("round") : context.pagingData.round,
        requests: [{...(context.roundDialogData || context.pagingData).requests[0],id:query.get("requestPage") || "1"}],
        request_pagination:{...(context.roundDialogData || context.pagingData).request_pagination,page:query.get("requestPage") || "1"},
      } : url.includes("/call?") ? {
        status: callStatus, message: callStatus === "matched" ? "This individual Call, not the entire Round" : "This Call cannot be uniquely linked",
        input: {status: "missing", content: null, message: "The full Input context for this Call was not recorded"},
        outputs: callStatus !== "matched" ? [] : [url.includes("/requests/2/") ? "synthetic single final 2" : "synthetic single output 1"],
        tools: callStatus !== "matched" || url.includes("/requests/2/") ? [] : [
          {id: "single-tool", name: "<script>synthetic single tool</script>", status: "success", arguments: '{"command":"only-this-call"}',
            result: "single result ".repeat(100), truncated: false, timestamp_display: "2024-11-03 16:01:02"}],
      } : url.includes("/tools?") ? {
        status: "matched", scope: sharedToolScope ? "interaction" : "round",
        message: sharedToolScope ? "This interaction contains messages added during execution; the shared tool activity below is not necessarily triggered only by this message." : "Tool activity for the same Round, not necessarily exclusive to this model request",
        tools: [{ id: "tool-" + query.get("page"), name: "<script>synthetic tool</script>", status: "success",
          timestamp_display: "2024-11-03 16:01:02", arguments: '{"command":"synthetic"}',
          result: query.get("full") === "1" ? "z".repeat(1000) : "z".repeat(400), truncated: query.get("full") !== "1" }],
        pagination: {page: query.get("page") || "1", pages: "2", total: "21"},
      } : {
        request: {...context.data.requests[0], turn_index: url.includes("/requests/") ? requestRound : "0"},
        association: url.includes("/requests/") ? roundAssociation : query.get("view") === "all" ? "all" : "matched",
        turns: [{id, turn_index: url.includes("/requests/") ? requestRound : id === "8" ? "0" : "20", timestamp: "2024-11-03T08:01:02Z",
          timestamp_display: "2024-11-03 16:01:02",
          user_message: query.get("full") === "1" ? dialogueText : dialogueText.slice(0, 400),
          assistant_response: roundReplyRecorded ? "synthetic final reply" : null, truncated: query.get("full") !== "1"}],
        turn_pagination: {page: query.get("turnPage") || "1", pages: "2", total: "21"},
      },
    });
  }, window: {getSelection: () => selection, innerWidth: 1280, innerHeight: 900, events:{}, scrollTo() {},
    addEventListener(name, callback) { this.events[name] = callback; }},
});
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/tool-summary.js"), "utf8").replaceAll("export function ", "function "), context);
const browserSummaryContext = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../web/tool-summary.js"), "utf8")
  .replace(/export\{(\w+) as safeLabel,(\w+) as toolSynopsis\};/, "globalThis.safeLabel=$1;globalThis.toolSynopsis=$2;"), browserSummaryContext);
vm.runInContext(source.replace('import { toolSynopsis } from "./tool-summary.js";', ""), context);
assert.equal(storage.get("tokenflow-key"), "synthetic-secret");
assert(!history.url.includes("#"));
const originalSetTimeout = context.setTimeout, originalClearTimeout = context.clearTimeout;
const refreshTimeouts = [], clearedRefreshTimeouts = [];
context.setTimeout = (callback, delay) => { refreshTimeouts.push({callback, delay}); return 1000000; };
context.clearTimeout = id => clearedRefreshTimeouts.push(id);
vm.runInContext('params.delete("sid"); scheduleRefresh()', context);
assert.equal(refreshTimeouts.length, 1);
assert.equal(refreshTimeouts[0].delay, 15000);
context.document.hidden = true;
vm.runInContext("scheduleRefresh()", context);
assert.equal(refreshTimeouts.length, 1, "Hidden pages must not schedule background polling");
assert(clearedRefreshTimeouts.includes(1000000));
context.document.hidden = false;
vm.runInContext('params.set("sid", "s"); scheduleRefresh(); refreshTimer = undefined', context);
assert.equal(refreshTimeouts.length, 1, "Round and session pages must not start homepage polling");
context.setTimeout = originalSetTimeout; context.clearTimeout = originalClearTimeout;
assert.equal(vm.runInContext('integer("90071992547409931234567890")', context), "90,071,992,547,409,931,234,567,890");
assert.equal(vm.runInContext("integer(null)", context), "Unknown");
assert.equal(vm.runInContext('integer("0")', context), "0");
assert.equal(vm.runInContext('displayTime({created_at: "2024-11-03T08:01:02Z", created_at_display: "2024-11-03 16:01:02"}, "created_at")', context),
  "2024-11-03 16:01:02");
assert.equal(vm.runInContext('displayTime({timestamp: "2024-02-30T00:00:00Z", timestamp_display: null}, "timestamp")', context),
  "2024-02-30T00:00:00Z (invalid time)");
assert.equal(vm.runInContext('displayTime({timestamp: null}, "timestamp")', context), "Not recorded");
function synopsis(name, args) {
  context.summaryTool = { name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  browserSummaryContext.summaryTool = context.summaryTool;
  const summary = vm.runInContext("toolSynopsis(summaryTool)", context);
  assert.equal(vm.runInContext("toolSynopsis(summaryTool)", browserSummaryContext), summary,
    "Browser and backend tool Summaries must match without building");
  return summary;
}
assert.equal(synopsis("functions.skill", {skill: "ponytail"}), "Load ponytail");
assert.equal(synopsis("functions.view", {path: "/sample/project/src/store.ts", view_range: [135, 200]}),
  "View src/store.ts · Lines 135–200");
assert.equal(synopsis("functions.view", {path: "/sample/project/src/store.ts", view_range: [135, -1]}),
  "View src/store.ts · Line 135 to end");
assert.equal(synopsis("functions.rg", {pattern: "roundIndex", paths: "src"}), "Search roundIndex");
assert.equal(synopsis("functions.glob", {pattern: "**/*.ts"}), "Find **/*.ts");
assert.equal(synopsis("functions.bash", {command: "rtk bypass /sample/bin/bun test tests-ts --token synthetic-secret"}),
  "Command bun test");
assert.equal(synopsis("functions.bash", {command: "TOKEN=synthetic-secret curl https://example.invalid?key=synthetic-secret"}), "Run command");
assert.equal(synopsis("functions.bash", {command: "curl -H 'Authorization: Bearer synthetic-secret' https://example.invalid"}), "Command curl");
assert(!synopsis("functions.rg", {pattern: "password=synthetic-secret"}).includes("synthetic-secret"));
assert(!synopsis("functions.view", {path: "https://example.invalid/a?key=synthetic-secret"}).includes("synthetic-secret"));
assert(!synopsis("functions.skill", {skill: "github_pat_synthetic-secret"}).includes("github_pat"));
assert(!synopsis("functions.skill", {skill: "https://example.invalid/value"}).includes("example.invalid"));
assert(!synopsis("functions.rg", {pattern: "AKIA" + "X".repeat(16)}).includes("AKIA"));
assert.equal(synopsis("functions.view", "{invalid"), "Argument format cannot be summarized");
assert.equal(synopsis("functions.view", null), "Arguments not recorded");
assert.equal(synopsis("functions.view", "x".repeat(65537)), "Arguments are too long; expand to view");
assert.equal(synopsis("multi_tool_use.parallel", {tool_uses: [{recipient_name: "functions.view"}, {recipient_name: "functions.rg"}]}),
  "Parallel functions.view, functions.rg · 2 tools total");
const longUnicodeSummary = synopsis("functions.glob", {pattern: "\u76ee\u5f55/".repeat(30) + "*.ts"});
assert.equal(Array.from(longUnicodeSummary).length, 61);
assert.equal(longUnicodeSummary.at(-1), "…");
context.summaryTool = {name: "functions.skill", arguments: '{"skill":"ponytail"}', status: "success"};
const titledTool = vm.runInContext("toolDetail(summaryTool)", context);
assert(titledTool.children[0].textContent.includes("functions.skill · Load ponytail"));
assert(!titledTool.children[0].textContent.includes("Success"));
context.summaryTool.status = "failed";
assert(vm.runInContext("toolDetail(summaryTool)", context).children[0].textContent.includes("Failed"));
assert(!titledTool.open);
context.trendPoints = [
  {id: "1", model: "<script>synthetic</script>", created_at_display: "2024-02-29 12:00:00",
    input_tokens: "9007199254740993", output_tokens: "0", cache_read_tokens: "50", invalid_time: false},
  {id: "2", model: "synthetic", input_tokens: null, output_tokens: "20", cache_read_tokens: "60", invalid_time: false},
  {id: "3", model: "synthetic", input_tokens: "100", output_tokens: "40", cache_read_tokens: "70", invalid_time: false},
];
const chart = vm.runInContext("tokenChart(trendPoints)", context);
const chartNodes = descendants(chart);
assert.equal(chartNodes.filter(node => node.attributes.class?.includes("trend-line")).length, 3);
assert.equal(chartNodes.filter(node => node.attributes.class?.includes("trend-area ")).length, 1);
assert.equal(chartNodes.find(node => node.attributes.class?.includes("trend-area ")).attributes.class, "trend-area trend-output");
assert(chartNodes.find(node => node.attributes.class === "trend-line trend-output").attributes.d.includes(" C"),
  "Detail trends must use the homepage's smooth curves");
const inputPath = chartNodes.find(node => node.tag === "path" && node.attributes.class.includes("trend-input"));
assert.equal((inputPath.attributes.d.match(/M/g) || []).length, 2, "Missing token values must split the line instead of becoming zero");
const sample = chartNodes.find(node => node.attributes.class === "trend-point");
sample.events.focus();
assert(sample.attributes["aria-label"].includes("9,007,199,254,740,993"), "Exact values remain available in the chart's accessible label");
assert(sample.attributes["aria-label"].includes("<script>synthetic</script>"));
assert(!chartNodes.some(node => node.tag === "script"));
assert(!chartNodes.some(node => Object.values(node.attributes).some(value => /NaN|Infinity/.test(String(value)))));
assert.deepEqual(chartNodes.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent), ["1", "2", "3"]);
assert(!chartNodes.some(node => /Round token trend|Call order/.test(node.textContent)));
const legend = chart.querySelector(".trend-legend");
assert.deepEqual(legend?.children.map(node => node.textContent), ["Input", "Output", "Cache read"]);
context.denseTrend = Array.from({length:55}, (_, index) => ({...context.trendPoints[0], id:String(index+1)}));
const denseChart = vm.runInContext("tokenChart(denseTrend)", context);
const denseNodes = descendants(denseChart);
assert.deepEqual(denseNodes.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent),
  Array.from({length:55}, (_, index) => String(index+1)));
assert(Number.parseFloat(denseChart.querySelector(".trend-scroll").querySelector("svg").style.minWidth) > 1280,
  "Every call must have a readable label; dense charts should scroll instead of overlapping or dropping labels");
assert(denseChart.querySelector(".trend-axis"), "Token labels must have a separate non-scrolling axis");
assert(!descendants(denseChart.querySelector(".trend-scroll")).some(node => node.textContent === "Token"));
for (const count of [1, 2, 3, 55]) {
  context.fixedRounds = Array.from({length: count}, (_, index) => ({
    ...context.trendPoints[0], turn_index: String(index), calls: "1",
  }));
  const roundChart = vm.runInContext("tokenChart(fixedRounds, undefined, undefined, true)", context);
  const plot = roundChart.querySelector(".trend-scroll").querySelector("svg");
  assert.equal(plot.style.width, `${count * 64}px`, "Each round must occupy a fixed 64px slot, without stretching");
  assert.equal(plot.style.minWidth, plot.style.width, "Dense round charts must scroll rather than shrink");
  assert.equal(plot.attributes.viewBox.split(" ")[2], String(count * 64));
  const points = descendants(plot).filter(node => node.attributes.class === "trend-point");
  assert.deepEqual(points.map(point => Number(point.querySelector("circle").attributes.cx)),
    Array.from({length: count}, (_, index) => index * 64 + 32),
    "Round points must stay centered in evenly spaced slots, including a single round");
  const backdrop = roundChart.querySelector(".trend-backdrop");
  assert(backdrop, "Round charts must fill the unused viewport with a separate grid");
  assert.equal(backdrop.attributes.viewBox, "0 0 1 240");
  assert.equal(backdrop.attributes["aria-hidden"], "true");
  const lines = descendants(backdrop).filter(node => node.tag === "line");
  assert(lines.length > 0 && lines.every(line => line.attributes.x1 === "0" && line.attributes.x2 === "1"));
  const ticks = descendants(roundChart.querySelector(".trend-axis")).filter(node => node.tag === "text" && node.textContent !== "Token");
  assert.deepEqual(lines.map(line => Number(line.attributes.y1)), ticks.map(tick => Number(tick.attributes.y) - 4),
    "Full-width grid lines must match the fixed Token axis");
}
assert.equal(chart.querySelector(".trend-backdrop"), null, "Single-call charts keep their existing grid");
assert(descendants(vm.runInContext("tokenChart([])", context)).some(node => node.textContent.includes("No Call")));
context.nullTrend = [{id: "1", input_tokens: null, output_tokens: null, cache_read_tokens: null, invalid_time: false}];
assert(descendants(vm.runInContext("tokenChart(nullTrend)", context)).some(node => node.textContent.includes("No token metrics were recorded")));
context.singleTrend = [{id: "1", model: "synthetic", input_tokens: "0", output_tokens: "-1", cache_read_tokens: null, invalid_time: true}];
const singleChart = descendants(vm.runInContext("tokenChart(singleTrend)", context));
assert.equal(singleChart.filter(node => node.tag === "circle").length, 2);
assert(singleChart.some(node => node.textContent.includes("invalid time")));
assert(!singleChart.some(node => Object.values(node.attributes).some(value => /NaN|Infinity/.test(String(value)))));
context.isolatedTrend = context.trendPoints.map((point, index) => ({
  ...point, input_tokens: "100", invalid_time: index === 1,
}));
const isolatedChart = descendants(vm.runInContext("tokenChart(isolatedTrend)", context));
assert(isolatedChart.filter(node => node.attributes.class?.includes("trend-line"))
  .every(node => (node.attributes.d.match(/M/g) || []).length === 3),
  "Invalid timestamps must remain isolated points instead of being connected or filled");
assert(!isolatedChart.some(node => node.attributes.class?.includes("trend-area ")));
context.invalidTrend = [{input_tokens: 1.5, output_tokens: "0", cache_read_tokens: "0"}];
assert.throws(() => vm.runInContext("tokenChart(invalidTrend)", context), /valid integer/);

const metrics = {calls: "1", input_tokens: "100", output_tokens: "20", total_tokens: "120", cache_read_tokens: "80"};
context.data = {
  session: {id: "s", title: "<img src=x onerror=alert(1)>", summary: null},
  metrics, period: "2024-02-29", models: [{model: "actual", ...metrics}],
  diagnostics: {invalid_times: "0", orphan_requests: "0"},
  requests: [{id: "1", model: "actual", created_at: "invalid", invalid_time: true, ...metrics,
    input_tokens: "90071992547409931234567890", duration_ms: "0", time_to_first_token_ms: 4423.464167,
    turn_index: "0", agent_id: "<img src=x onerror=alert(1)>", initiator: "user", finish_reason: "tool_calls"}],
  turns: [{id: "8", turn_index: "2", timestamp: null, user_message: "<script>alert(1)</script>\n\u4e2d\u6587",
    assistant_response: "reply", truncated: true}],
  request_pagination: {page: "2", pages: "2", total: "51", size: "50"},
  turn_pagination: {page: "1", pages: "2", total: "21"},
};
vm.runInContext("renderSession(data)", context);
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
const rendered = descendants(elements.get("content"));
const links = rendered.filter(node => node.tag === "a");
const returnLink = links.find(node => node.textContent === "Back to Session list");
assert.equal(new URLSearchParams(returnLink.href.slice(2)).get("page"), "3");
assert.equal(new URLSearchParams(returnLink.href.slice(2)).get("day"), "29");
const all = new URLSearchParams(links.find(node => node.textContent === "View Session across All dates").href.slice(2));
assert(!all.has("year"));
assert.equal(all.get("list"), "year=2024&month=2&day=29&page=3");
const restore = new URLSearchParams(links.find(node => node.textContent === "Restore original date range").href.slice(2));
assert.equal(restore.get("day"), "29");
assert.equal(restore.get("month"), "2");
assert(!rendered.some(node => node.tag === "script" || node.tag === "img"));
assert(!rendered.some(node => node.tag === "pre" || node.textContent === "All recorded conversations in this Session"),
  "Dialogue must be moved out of the main page into the request modal");
context.bigPage = {page: "90071992547409929", pages: "90071992547409930", total: "90071992547409930"};
const bigNav = vm.runInContext('pagination(bigPage, "requestPage")', context);
assert(bigNav.children.some(node => node.href && node.href.includes("requestPage=90071992547409930")));
let requestRow = rendered.find(node => node.tag === "tr" && node.attributes["aria-haspopup"] === "dialog");
assert(requestRow, "Each model request row must open a detail dialog");
assert.equal(requestRow.tabIndex, 0);
assert.equal(requestRow.children[0].children[0].textContent, "1");
assert.equal(requestRow.children[1].children[0].textContent, "1");
assert.equal(requestRow.attributes["aria-label"], "View request 1 details");
assert(rendered.some(node => node.tag === "th" && node.textContent === "No."));
assert(!rendered.some(node => node.tag === "h2" && node.textContent === "By actual model"));
context.dashboardData = {
  years: ["2023", "2024", "2027"], today: "2026-11-12", period: "2024-02-29", timezone: "Asia/Shanghai",
  metrics, session_count: "22", diagnostics: context.data.diagnostics,
  sessions: [1, 2].map(id => ({id: String(id), title: "synthetic", project: "project", models: ["actual"], metrics})),
  pagination: {page: "2", pages: "2", size: "20", total: "22"},
  top_sessions: [], top_total_tokens: "0", unknown_total_sessions: "0",
  session_usage:Array.from({length:22}, (_, index) => ({id:"usage-"+index,title:"synthetic usage",project:"project",metrics})),
  usage_trend: [{time: "2024-02-29 12:00", total_tokens: "120", input_tokens: "100", output_tokens: "20", cache_read_tokens:"80"}],
  repositories: ["owner/repo-a", "owner/repo-b"], model_types: ["claude-sonnet", "gpt-5"],
};
elements.get("content").replaceChildren();
const beforeSortParams = vm.runInContext("params.toString()", context);
const beforeSortLocation = location.search;
vm.runInContext('params.delete("sid"); renderDashboard(dashboardData)', context);
const home = elements.get("content");
assert.deepEqual(descendants(home).filter(node => node.tag === "th").map(node => node.textContent),
  ["Session summary", "Project", "Total tokens", "Calls", "Model", "Latest request", "Action"]);
assert.equal(home.querySelector(".dashboard-summary").children[0].className, "dashboard-analyses");
assert.equal(home.querySelector(".dashboard-summary").children[1].className, "dashboard-details");
assert(home.querySelector(".dashboard-custom-range"), "Custom date ranges must use a native date form");
assert.equal(home.querySelector(".dashboard-custom-range").querySelectorAll("fieldset").length, 1);
assert.deepEqual(home.querySelector(".dashboard-date-picker").querySelectorAll("select").map(select => select.name), ["year", "month", "day"]);
function setDatePicker(picker, date) {
  const parts = date.split("-");
  for (const [index, field] of ["year", "month", "day"].entries()) picker.querySelector(".dashboard-date-" + field).value = parts[index] ? String(Number(parts[index])) : "";
}
function datePickerValue(picker) {
  return ["year", "month", "day"].map((field, index) => {
    const value = String(picker.querySelector(".dashboard-date-" + field).value);
    return value ? value.padStart(index ? 2 : 4, "0") : "";
  }).join("-");
}
assert.deepEqual(home.querySelector(".dashboard-metrics").children.map(node => node.attributes["data-field"]),
  ["total_tokens", "input_tokens", "output_tokens"]);
const rows = descendants(home).find(node => node.tag === "tbody").children;
assert.equal(rows[0].children.length, 7);
assert.equal(rows[0].children[2].children[0].textContent, "120");
assert.equal(rows[0].children[6].children[0].textContent, "View");
const trendDot = descendants(home).find(node => node.attributes.class === "dashboard-dot");
trendDot.events.focus();
assert.equal(home.querySelector(".dashboard-chart-tooltip").querySelector("strong").textContent, "100");
assert(!home.querySelector(".dashboard-chart-tooltip").querySelector("a"), "Home tooltips must not contain session links");
trendDot.events.pointerleave();
assert(home.querySelector(".dashboard-chart-tooltip").hidden, "Leaving a point must immediately dismiss the original tooltip");
trendDot.events.focus();
trendDot.events.keydown({key: "Escape"});
assert(home.querySelector(".dashboard-chart-tooltip").hidden);
context.scrollTrend = Array.from({length:30}, (_, index) => ({
  time: `2024-02-${String(index + 1).padStart(2, "0")}`, total_tokens:"120", input_tokens:"100", output_tokens:"20", cache_read_tokens:"80",
}));
const scrollTrend = vm.runInContext("dashboardTrend(scrollTrend)", context);
const scrollPlot = scrollTrend.querySelector(".dashboard-chart");
assert.equal(scrollPlot.tabIndex, 0);
assert.equal(scrollPlot.attributes.role, "region");
assert.equal(scrollPlot.querySelector("svg").style.minWidth, "1936px");
assert.equal(scrollPlot.querySelector("svg").attributes.viewBox, "0 0 1936 310");
assert.equal(descendants(scrollPlot).filter(node => node.attributes.class === "dashboard-dot").length, 90);
assert.equal(scrollTrend.querySelector("select"), null);
assert.deepEqual(descendants(scrollTrend).filter(node => node.className === "dashboard-chart-legend").map(node => node.textContent),
  ["Input", "Output", "Cache read"]);
assert.deepEqual(descendants(scrollTrend).filter(node => node.className === "dashboard-chart-legend").map(node => node.attributes["data-field"]),
  ["input_tokens", "output_tokens", "cache_read_tokens"]);
assert(descendants(scrollTrend).filter(node => node.className === "dashboard-chart-legend" || node.attributes.class === "dashboard-dot")
  .every(node => node.attributes.style === undefined), "Chart colors must work with CSP that blocks inline style attributes");
assert.deepEqual(descendants(scrollPlot).filter(node => node.tag === "linearGradient").map(node => node.attributes.id),
  ["dashboard-area-input_tokens"]);
assert.deepEqual(descendants(scrollPlot).filter(node => node.attributes.class === "dashboard-line").map(node => node.attributes.stroke),
  ["#0891b2", "#246bff", "#7c3aed"]);
assert.deepEqual(descendants(scrollPlot).filter(node => node.attributes.class === "dashboard-area").map(node => node.attributes.fill),
  ["url(#dashboard-area-input_tokens)"]);
assert.equal(descendants(scrollPlot).find(node => node.tag === "stop").attributes["stop-color"], "#246bff");
context.zeroOutputTrend = [10000, 12000].map(value => ({
  time:"2024-02-29 06:00",total_tokens:String(value),input_tokens:String(value),output_tokens:"0",cache_read_tokens:"80",
}));
const zeroOutputChart = vm.runInContext("dashboardTrend(zeroOutputTrend)", context);
const blueArea = descendants(zeroOutputChart).find(node => node.attributes.class === "dashboard-area");
assert.equal(blueArea.attributes.fill, "url(#dashboard-area-input_tokens)");
const areaTop = Number(blueArea.attributes.d.match(/^M[\d.]+ ([\d.]+)/)[1]);
assert(areaTop < 168, "Blue fill must cover a visible height even when output is zero and its line hugs the baseline");
assert.deepEqual(descendants(scrollPlot).filter(node => node.attributes.class === "dashboard-line").map(node => node.attributes["data-field"]),
  ["input_tokens", "output_tokens", "cache_read_tokens"]);
descendants(scrollPlot).find(node => node.attributes.class === "dashboard-dot").events.focus();
assert(!scrollTrend.querySelector(".dashboard-chart-tooltip").hidden);
assert.deepEqual(descendants(scrollTrend.querySelector(".dashboard-chart-tooltip")).filter(node => node.tag === "strong").map(node => node.textContent),
  ["100", "20", "80"]);
scrollPlot.events.scroll();
assert(scrollTrend.querySelector(".dashboard-chart-tooltip").hidden, "Scrolling must hide stale tooltip positions");
context.gappedDashboardTrend = context.scrollTrend.slice(0, 3).map((point, index) => ({
  ...point, input_tokens: index === 1 ? null : "9007199254740993",
}));
const gappedHomeTrend = vm.runInContext("dashboardTrend(gappedDashboardTrend)", context);
const inputLines = descendants(gappedHomeTrend).filter(node =>
  node.attributes.class === "dashboard-line" && node.attributes["data-field"] === "input_tokens");
assert.equal(inputLines.length, 2, "Missing input values must split only the input curve");
assert.equal(descendants(gappedHomeTrend).filter(node =>
  node.attributes.class === "dashboard-line" && node.attributes["data-field"] === "cache_read_tokens").length, 1);
assert(descendants(gappedHomeTrend).some(node =>
  node.attributes["aria-label"]?.includes("Input 9,007,199,254,740,993")));
const homeChartCss = fs.readFileSync(path.join(__dirname, "../web/style.css"), "utf8").match(/\.dashboard-chart \{([^}]+)\}/)[1];
assert(homeChartCss.includes("overflow-x: auto") && homeChartCss.includes("overflow-y: hidden"));
const chartPaletteCss = fs.readFileSync(path.join(__dirname, "../web/style.css"), "utf8");
for (const [field, color] of [["input_tokens", "#0891b2"], ["output_tokens", "#246bff"], ["cache_read_tokens", "#7c3aed"]]) {
  assert(chartPaletteCss.includes(`[data-field="${field}"] { --series: ${color}; }`),
    "Legend text, line samples and chart dots must share their metric's external CSS color");
}
const periodButtons = home.querySelector(".dashboard-periods").children;
assert.deepEqual(periodButtons.map(node => node.textContent), ["Today", "Last 7 days", "Custom"]);
const actualLoad = vm.runInContext("load", context), rangeQueries = [];
context.captureRangeLoad = (_, query) => rangeQueries.push(new URLSearchParams(query));
vm.runInContext("load=captureRangeLoad", context);
const beforeDateSearch = location.search;
periodButtons[1].events.click();
let query = rangeQueries.at(-1);
assert.equal(query.get("date"), "last7");
assert(!query.has("year") && !query.has("page"));
periodButtons[2].events.click();
const rangeDialog = home.querySelector(".dashboard-range-dialog");
assert.equal(rangeDialog.open, true);
assert.equal(rangeDialog.attributes["aria-labelledby"], rangeDialog.querySelector("h2").id);
assert.equal(rangeQueries.length, 1, "Opening custom dates must not request data");
const rangeStart = home.querySelector(".dashboard-date-picker");
setDatePicker(rangeStart, "2024-02-29");
home.querySelector(".dashboard-custom-range").events.submit({preventDefault(){}});
assert.equal(rangeQueries.at(-1).get("year"), "2024");
assert.equal(rangeQueries.at(-1).get("month"), "2");
assert.equal(rangeQueries.at(-1).get("day"), "29");
assert(!rangeQueries.at(-1).has("date") && !rangeQueries.at(-1).has("start") && !rangeQueries.at(-1).has("end"));
assert.equal(rangeDialog.open, false, "Applying a valid date must dismiss the dialog");
periodButtons[2].events.click();
for (const date of ["2024-02-30", "2026-12-", "2026-11-13", "2027--", "2024--1", ""]) {
  const count = rangeQueries.length;
  setDatePicker(rangeStart, date);
  home.querySelector(".dashboard-custom-range").events.submit({preventDefault(){}});
  assert.equal(rangeQueries.length, count);
  assert.equal(home.querySelector(".dashboard-range-error").hidden, false);
  assert.equal(rangeDialog.open, true, "Invalid dates must leave the dialog open for correction");
}
setDatePicker(rangeStart, "2024--");
rangeStart.querySelector(".dashboard-date-month").events.change();
assert.equal(rangeStart.querySelector(".dashboard-date-day").disabled, true);
assert.equal(rangeStart.querySelector(".dashboard-date-day").value, "");
home.querySelector(".dashboard-custom-range").events.submit({preventDefault(){}});
assert.equal(rangeQueries.at(-1).get("year"), "2024");
assert(!rangeQueries.at(-1).has("month") && !rangeQueries.at(-1).has("day"), "All months must query the whole year");
periodButtons[2].events.click();
setDatePicker(rangeStart, "2024-02-");
rangeStart.querySelector(".dashboard-date-month").events.change();
assert.equal(rangeStart.querySelector(".dashboard-date-day").disabled, false);
home.querySelector(".dashboard-custom-range").events.submit({preventDefault(){}});
assert.equal(rangeQueries.at(-1).get("month"), "2");
assert(!rangeQueries.at(-1).has("day"), "All days must query the whole month");
periodButtons[2].events.click();
descendants(rangeDialog).find(node => node.tag === "button" && node.textContent === "Cancel").events.click();
assert.equal(rangeDialog.open, false);
assert.equal(focused, periodButtons[2]);
setDatePicker(rangeStart, "2024-02-29");
rangeStart.querySelector(".dashboard-date-year").value = "2023";
rangeStart.querySelector(".dashboard-date-year").events.change();
assert.equal(datePickerValue(rangeStart), "2023-02-28", "Changing years must clamp leap days to valid calendar dates");
setDatePicker(rangeStart, "2024-01-31");
rangeStart.querySelector(".dashboard-date-month").value = "4";
rangeStart.querySelector(".dashboard-date-month").events.change();
assert.equal(datePickerValue(rangeStart), "2024-04-30");
for (const [year, days] of [["4",29], ["1900",28], ["2000",29]]) {
  setDatePicker(rangeStart, `${year.padStart(4,"0")}-02-29`);
  rangeStart.querySelector(".dashboard-date-year").events.change();
  assert.equal(rangeStart.querySelector(".dashboard-date-day").children.length, days + 1);
}
setDatePicker(rangeStart, context.dashboardData.today);
rangeStart.querySelector(".dashboard-date-year").events.change();
assert.equal(rangeStart.querySelector(".dashboard-date-month").children.length, 12, "This year's months include All and stop at the current month");
assert.equal(rangeStart.querySelector(".dashboard-date-day").children.length, 13, "The current month's days include All and stop at today");
assert.equal(rangeStart.querySelector(".dashboard-date-month").children[0].textContent, "All");
assert.equal(rangeStart.querySelector(".dashboard-date-day").children[0].textContent, "All");
assert(!rangeStart.querySelector(".dashboard-date-year").children.some(option => Number(option.value) > 2026));
assert(chartPaletteCss.includes(".dashboard-details .session-identity > a { font-size: inherit;"),
  "Session summaries must inherit the same text size as other table cells");
periodButtons[0].events.click();
assert.equal(rangeQueries.at(-1).get("date"), "today");
assert.equal(location.search, beforeDateSearch, "Date controls must not navigate or reload the document");
context.restoreRangeLoad = actualLoad;
vm.runInContext("load=restoreRangeLoad", context);
const sizeSelect = home.querySelector(".pagination-controls").querySelector("select");
sizeSelect.value = "50"; sizeSelect.events.change();
assert.equal(new URLSearchParams(location.search).get("pageSize"), "50");
assert(!new URLSearchParams(location.search).has("page"));
for (const sort of ["latest", "latest_asc", "total_tokens", "total_tokens_asc"]) {
  context.sortState = sort;
  vm.runInContext('params.set("sort",sortState); renderDashboard(dashboardData)', context);
  const headings = descendants(home).filter(node => node.tag === "th");
  assert(headings.some(node => node.textContent === "Latest request"));
  assert(headings.some(node => node.textContent === "Total tokens"));
  assert(!headings.some(node => descendants(node).some(child => child.tag === "button")));
  assert(!headings.some(node => node.attributes["aria-sort"]));
}
context.chartData = {...context.dashboardData, metrics: {...metrics, total_tokens: "80"},
  session_count:"2", session_usage: [30,10].map((total,index) => ({
    ...context.dashboardData.sessions[index], id: "chart-" + index, title: "<script>chart session</script>",
    metrics: {...metrics, total_tokens: String(total)},
  })),
};
vm.runInContext('renderDashboard(chartData)', context);
assert.equal(home.querySelector(".session-usage").querySelector("h2").textContent, "Session token usage");
assert.equal(home.querySelector(".session-usage-scroll").querySelectorAll("a").length, 2);
assert(!home.querySelector(".session-usage-value"), "Bars must not display individual Token labels");
const usageAxis = home.querySelector(".session-usage-axis");
assert(usageAxis && descendants(usageAxis).some(node => node.textContent === "Token"));
assert.equal(descendants(usageAxis).filter(node => node.attributes.class === "session-usage-tick").length, 5);
const barLinks = home.querySelector(".session-usage-scroll").querySelectorAll("a");
assert.equal(new URLSearchParams(barLinks[0].getAttribute("href").slice(2)).get("sid"), "chart-0");
assert.equal(new URLSearchParams(barLinks[0].getAttribute("href").slice(2)).get("day"), "29");
assert(barLinks.every(link => link.querySelector(".session-usage-name").getAttribute("transform").startsWith("rotate(45 ")));
const firstBar = barLinks[0].querySelector(".session-usage-column"), nextBar = barLinks[1].querySelector(".session-usage-column");
assert.equal(Number(firstBar.attributes.width), 34);
assert.equal(Number(nextBar.attributes.x) - Number(firstBar.attributes.x), 48);
assert.equal(Number(nextBar.attributes.x) - Number(firstBar.attributes.x) - Number(firstBar.attributes.width), 14,
  "The visible gap between adjacent bars must be only 14px");
assert(Math.abs(Number(firstBar.attributes.height) / Number(nextBar.attributes.height) - 3) < 0.001,
  "Bars must share a scale proportional to their exact Token totals");
assert(!home.querySelector("script"));
vm.runInContext('renderDashboard({...chartData,session_usage:[chartData.session_usage[0]],session_count:"1"})', context);
assert.equal(home.querySelector(".session-usage-scroll").querySelectorAll("a").length, 1);
const previousTop = home.querySelector(".session-usage");
assert.throws(() => vm.runInContext('renderDashboard({...chartData,session_count:"3"},true)', context), /Session usage/);
assert.equal(home.querySelector(".session-usage"), previousTop, "Bad refresh data must preserve the previous view");
context.allBars = {...context.chartData,session_count:"29",session_usage:Array.from({length:29}, (_, index) => ({
  ...context.chartData.session_usage[0],id:"bar-"+index,
  metrics:{...metrics,total_tokens:index === 28 ? null : index === 27 ? "-10" : index === 26 ? "0" : "90071992547409931234567890"}
}))};
vm.runInContext("renderDashboard(allBars)", context);
assert.equal(home.querySelector(".session-usage-scroll").querySelectorAll("a").length, 29, "All sessions must be displayed, not only Top 5 or the table page");
const allBarLinks = home.querySelector(".session-usage-scroll").querySelectorAll("a");
assert(allBarLinks[0].getAttribute("aria-label").includes("90,071,992,547,409,931,234,567,890"));
assert(allBarLinks[26].getAttribute("aria-label").includes("0 Token"));
assert(allBarLinks[27].getAttribute("aria-label").includes("-10 Token"));
assert.equal(allBarLinks[28].querySelector(".session-usage-unknown").textContent, "Unknown");
assert(!allBarLinks[26].querySelector(".session-usage-column") && !allBarLinks[28].querySelector(".session-usage-column"), "Zero and unknown totals must not become invented positive bars");
assert(allBarLinks[27].querySelector(".session-usage-column"), "Negative values must have a bar below the baseline");
assert(!allBarLinks.some(link => link.attributes.style), "Bar charts must work with the external-style CSP");
vm.runInContext('renderDashboard({...dashboardData,session_usage:[],session_count:"0",sessions:[]})', context);
assert(home.querySelector(".session-usage").querySelector(".top-empty"));
context.recentData = {...context.dashboardData, range_start:"2026-11-06",range_end:"2026-11-12",period:"2026-11-06 ~ 2026-11-12"};
vm.runInContext('for(const key of [...params.keys()]) params.delete(key); params.set("date","last7"); renderDashboard(recentData)', context);
const view = descendants(home).find(node => node.tag === "a" && node.textContent === "View");
const detail = new URLSearchParams(view.href.slice(2));
assert.equal(detail.get("start"), "2026-11-06");
assert.equal(detail.get("end"), "2026-11-12");
assert(!detail.has("date"));
const listing = home.querySelector(".session-list"); listing.scrollLeft = 60; listing.scrollTop = 120;
home.querySelector(".session-usage-scroll").scrollLeft = 220;
vm.runInContext('renderDashboard(recentData,true)', context);
assert.equal(home.querySelector(".session-list").scrollLeft, 60);
assert.equal(home.querySelector(".session-list").scrollTop, 120);
assert.equal(home.querySelector(".session-usage-scroll").scrollLeft, 220, "Automatic refresh must preserve horizontal bar-chart position");
vm.runInContext('renderDashboard({...recentData,sessions:[],diagnostics:{invalid_times:"1",orphan_requests:"0"}})', context);
assert(home.querySelector(".dashboard-empty") && home.querySelector(".dashboard-pagination"));
assert(descendants(home).some(node => node.textContent.startsWith("Database-wide diagnostics")));
context.beforeSortParams = beforeSortParams;
vm.runInContext('for(const key of [...params.keys()]) params.delete(key); for(const [key,value] of new URLSearchParams(beforeSortParams)) params.set(key,value)', context);
location.search = beforeSortLocation;
context.numberingPage = {page: "9007199254740993", size: "50"};
const preciseTable = vm.runInContext('table(["ID"], [["real-id"]], undefined, numberingPage)', context);
assert.equal(preciseTable.tabIndex, 0);
assert.equal(preciseTable.attributes.role, "region");
assert.equal(preciseTable.attributes["aria-label"], "ID list; scroll vertically or horizontally");
assert.equal(descendants(preciseTable).find(node => node.tag === "tbody").children[0].children[0].children[0].textContent,
  "450,359,962,737,049,601");
context.descendingRows = Array.from({length:50}, (_, index) => [String(55 - index)]);
const descendingFirst = vm.runInContext('table(["ID"], descendingRows, undefined, {page:"1",size:"50",total:"55"}, true)', context);
const firstRows = descendants(descendingFirst).find(node => node.tag === "tbody").children;
assert.equal(firstRows[0].children[0].children[0].textContent, "55");
assert.equal(firstRows.at(-1).children[0].children[0].textContent, "6");
const descendingSecond = vm.runInContext('table(["ID"], [["5"],["4"],["3"],["2"],["1"]], undefined, {page:"2",size:"50",total:"55"}, true)', context);
assert.deepEqual(descendants(descendingSecond).find(node => node.tag === "tbody").children.map(row => row.children[0].children[0].textContent),
  ["5", "4", "3", "2", "1"]);
const descendingExact = vm.runInContext('table(["ID"], [["huge"]], undefined, {page:"2",size:"50",total:"90071992547409930"}, true)', context);
assert.equal(descendants(descendingExact).find(node => node.tag === "tbody").children[0].children[0].children[0].textContent, "90,071,992,547,409,880");
context.groupedData = {...context.data, rounds: [
  {turn_index: "61", request_id:"61", metrics: {...metrics, calls: "19", total_tokens: "90071992547409931234567890"},
    first_request_display: "2024-02-29 12:00:00", last_request_display: "2024-02-29 12:05:00", models: ["actual"],
    summary:"synthetic round 61 preview",summary_status:"recorded",invalid_time:false},
  {turn_index: null, metrics, models: ["actual"],summary:"No Round index was recorded; the conversation cannot be linked.",summary_status:"no_index",invalid_time:true},
  {turn_index: "0", metrics, models: ["actual"],summary:"This Round's conversation has not been recorded yet.",summary_status:"missing",invalid_time:false},
], round_pagination: {page: "2", pages: "6", total: "53", size: "10"}};
context.groupedData.round_trend = [...context.groupedData.rounds].reverse();
elements.get("content").replaceChildren();
vm.runInContext('params.set("roundPage", "2"); renderSession(groupedData)', context);
const grouped = descendants(elements.get("content"));
const roundListing = elements.get("content").querySelector(".session-round-list");
const roundRows = descendants(roundListing).filter(node => node.tag === "tbody")[0].children;
assert(roundRows.every(row => !row.events.click && !row.events.keydown && row.tabIndex === undefined && row.className !== "linked-row"),
  "Overview rows must not act as navigation targets");
const roundLink = descendants(roundRows[0]).find(node => node.tag === "button" && node.textContent === "Call details");
assert(roundLink);
assert.equal(roundLink.type, "button");
assert.equal(roundLink.attributes["aria-haspopup"], "dialog");
assert.equal(grouped.filter(node => node.tag === "span" && node.textContent === "Round 61").length, 1);
assert.equal(descendants(roundListing).filter(node => node.tag === "button" && node.textContent === "Call details").length, 3);
assert(!descendants(roundListing).some(node => node.tag === "a" && /^Round \d+$/.test(node.textContent)),
  "Round labels must be plain text; only the explicit detail action navigates");
assert(!grouped.some(node => node.className === "request-row"), "Overview must group calls rather than open single-call dialogs");
assert.equal(body.className, "session-page");
const breadcrumb = elements.get("content").querySelector(".detail-breadcrumb");
assert.equal(breadcrumb.attributes["aria-label"], "Breadcrumbs");
assert.equal(breadcrumb.querySelector("span").attributes["aria-current"], "page");
assert.equal(breadcrumb.querySelector("span").textContent, context.data.session.title);
assert.equal(breadcrumb.querySelector(".detail-home").href, "/?year=2024&month=2&day=29&page=3");
const callBreadcrumb = vm.runInContext("detailBreadcrumb(data.session.title, true)", context);
assert.equal(callBreadcrumb.querySelector("span").textContent, "Call details");
assert.equal(descendants(callBreadcrumb).find(node => node.tag === "a" && node.textContent === context.data.session.title).href.includes("sid=s"), true);
const sessionInfo = grouped.find(node => node.className === "session-info");
assert.deepEqual(descendants(sessionInfo).filter(node => node.tag === "dt").map(node => node.textContent),
  ["Working directory", "Session ID"]);
assert.deepEqual(descendants(sessionInfo).filter(node => node.className === "metric").map(node => node.textContent),
  ["Total tokens", "Input", "Output", "Cache read"]);
assert.equal(sessionInfo.querySelector(".session-metrics").children[0].attributes["data-field"], "total_tokens");
assert(!grouped.some(node => node.className === "session-summary"), "The title must not repeat below the breadcrumb");
const sessionAnalysis = elements.get("content").querySelector(".session-analysis");
assert.equal(sessionAnalysis.querySelector(".token-chart").parent, sessionAnalysis);
assert.equal(sessionAnalysis.querySelector(".trend-heading").querySelector("h2").textContent,
  "Session Round token usage trend");
assert.equal(sessionAnalysis.querySelector(".round-call-section").parent, sessionAnalysis,
  "The chart and list must share a single module");
const filledRoundChart = vm.runInContext('tokenChart([0,1].map(index => ({id:String(index),turn_index:String(index),calls:"1",input_tokens:"10000",output_tokens:"0",cache_read_tokens:"8000"})),undefined,undefined,true)', context);
const roundArea = descendants(filledRoundChart).find(node => node.attributes.class === "trend-area trend-input");
assert(roundArea, "Round charts must fill below the prominent input curve, not the near-zero output curve");
assert.equal(roundArea.attributes.fill, "url(#trend-input-area)");
assert(Number(roundArea.attributes.d.match(/^M[\d.]+ ([\d.]+)/)[1]) < 100, "The gradient must cover visible height when output is zero");
assert.equal(descendants(filledRoundChart).find(node => node.tag === "stop").attributes["stop-color"], "#246bff");
assert.equal(descendants(filledRoundChart).filter(node => node.attributes.class?.includes("trend-area ")).length, 1);
assert(!descendants(sessionInfo).some(node => node.tag === "button"));
assert(!grouped.some(node => node.textContent === "Back to Session list"));
assert(!descendants(sessionInfo).some(node => node.tag === "a" || node.className === "session-actions"));
assert.equal(grouped.find(node => node.tag === "button" && node.textContent === "All Session records").parent.parent.tag, "h2");
assert.deepEqual(grouped.filter(node => node.tag === "th").map(node => node.textContent),
  ["Round","Calls","Total tokens","Model","Conversation summary","Action"]);
assert.equal(grouped.filter(node => node.attributes.class === "trend-point").length,2,
  "The overview chart must cover all known rounds without inventing an index for missing rounds");
assert.deepEqual(grouped.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent),["0","61"]);
const overviewPoint = grouped.find(node => node.attributes.class === "trend-point" && node.attributes["aria-label"].startsWith("Round 61"));
overviewPoint.events.focus();
assert(descendants(elements.get("content")).some(node => node.textContent === "Loading this Round's conversation…"));
assert(!descendants(elements.get("content")).some(node => node.textContent === "View Round details"));
assert(!grouped.some(node => node.className === "round-conversation"));
assert(grouped.some(node => node.textContent === "90,071,992,547,409,931,234,567,890"));
assert(grouped.some(node => node.tag === "span" && node.textContent === "Round not recorded"));
assert(grouped.some(node => node.tag === "span" && node.textContent === "Round 0"));
elements.get("content").replaceChildren();
vm.runInContext('renderSession({...groupedData, rounds:[], round_trend:[], round_pagination:{page:"1",pages:"1",total:"0",size:"10"}})', context);
const emptyOverview = descendants(elements.get("content"));
assert(emptyOverview.some(node => node.textContent === "No Rounds with recorded indexes in this range."));
assert(emptyOverview.some(node => node.textContent === "No model requests in this range."));
assert(emptyOverview.some(node => node.tag === "button" && node.textContent === "All Session records"));
assert(!emptyOverview.some(node => node.attributes.class === "trend-point"));
context.selectedData = {...context.data, round: "61", token_trend: context.trendPoints,
  request_pagination:{...context.data.request_pagination,pages:"6",size:"10"}};
elements.get("content").replaceChildren();
vm.runInContext('params.set("round", "61"); params.set("requestPage", "2"); renderSession(selectedData)', context);
const selected = descendants(elements.get("content"));
assert(selected.some(node => node.tag === "h1" && node.textContent === "Round 61 · Call details"));
assert(!selected.some(node => node.className?.includes("metrics")), "Round totals must stay compact rather than use metric cards");
const overviewBack = selected.find(node => node.tag === "a" && node.textContent === "Back to Session overview");
assert(overviewBack);
const backScope = new URLSearchParams(overviewBack.href.slice(2));
assert.equal(backScope.get("sid"), "s");
assert.equal(backScope.get("roundPage"), "2");
assert.equal(backScope.get("day"), "29");
assert.equal(backScope.get("list"), "year=2024&month=2&day=29&page=3");
assert(!backScope.has("round") && !backScope.has("requestPage"));
assert(selected.some(node => node.className === "call-overview" && node.textContent.includes(`Round Total tokens ${vm.runInContext("integer(selectedData.metrics.total_tokens)", context)}`)));
assert(!selected.some(node => node.tag === "svg" || ["round-overview", "round-conversation", "token-chart"].includes(node.className)),
  "Call detail must be a list-only page with no chart or whole-round sidebar");
assert(!selected.some(node => ["dl", "dt", "dd"].includes(node.tag)), "Round detail must omit session metadata");
assert.equal(body.className, "round-page");
assert(!selected.some(node => (node.tag === "button" && node.className !== "call-detail-open")
  || /Database-wide diagnostics|Each row is|Click any|View Session across All dates|Restore original date range/.test(node.textContent)));
assert.deepEqual(selected.filter(node => node.tag === "th").map(node => node.textContent),
  ["No.", "Model", "Input", "Output", "Cache read", "Total tokens", "Summaries", "Action"],
  "The round table should show call summaries and tokens, not IDs, timestamps or latency metrics");
assert(!selected.some(node => node.tag === "h3" && node.textContent.includes("request")), "Chart hover titles must use call ordinals, not internal request IDs");
assert(!selected.some(node => node.tag === "h2" && /Round.*usage|By actual model/.test(node.textContent)));
assert(selected.some(node => node.className === "round-period" && node.textContent === " · " + context.selectedData.period),
  "Keep an actual filtered date scope visible");
context.allTimeRound = {...context.selectedData, period:"All"};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(allTimeRound)", context);
assert(!descendants(elements.get("content")).some(node => node.className === "round-period" || node.textContent === " · All"),
  "The default all-time suffix must be removed from the round title");
context.warningRound = {...context.selectedData, diagnostics:{invalid_times:"1", orphan_requests:"0"}};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(warningRound)", context);
assert(descendants(elements.get("content")).some(node => node.textContent.includes("Database-wide diagnostics") && node.textContent.includes("requests that cannot be date-filtered: 1")),
  "A minimal page must still surface real source anomalies");
context.singlePageRound = {...context.selectedData, request_pagination:{page:"1",pages:"1",size:"10",total:"1"}};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(singlePageRound)", context);
assert(!descendants(elements.get("content")).some(node => node.attributes["aria-label"] === "Request pagination"));
vm.runInContext('params.delete("round"); params.delete("requestPage"); params.delete("roundPage")', context);
elements.get("content").replaceChildren();
vm.runInContext("renderSession(data)", context);
async function overviewHoverChecks() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  vm.runInContext('params.delete("round"); params.delete("requestPage")', context);
  calls.length = 0;
  elements.get("content").replaceChildren();
  context.hoverData = {...context.groupedData, round_trend: context.groupedData.round_trend.map(point =>
    point.turn_index === "0" ? {...point, request_id:"0"} : point)};
  vm.runInContext("renderSession(hoverData)", context);
  const chart = elements.get("content").querySelector(".token-chart");
  const tooltip = chart.querySelector(".trend-tooltip");
  const point = descendants(chart).find(node => node.attributes["aria-label"]?.startsWith("Round 61"));
  assert.equal(calls.length, 0, "Overview must not preload full dialogue or tools");
  point.events.pointerenter({clientX:620,clientY:700});
  const position = {...tooltip.style};
  await tick();
  const text = () => descendants(tooltip).map(node => node.textContent).join(" ");
  assert(text().includes(dialogueText) && text().includes("synthetic final reply"));
  assert(text().includes("Model: actual") && text().includes("19 model Calls"));
  assert(text().includes("Main Session tools") && text().includes("internal subagent Calls are excluded"));
  assert(!descendants(tooltip).some(node => node.className === "trend-detail-open"));
  assert(!calls.some(call => /\/call\?/.test(call.url)));
  assert.equal(calls.length, 1, "Collapsed tools must not load until explicitly expanded");
  assert(calls[0].url.includes("/requests/61?view=matched&full=1"));
  assert.deepEqual(tooltip.style, position, "Async dialogue must not reposition an active hover");
  const message = descendants(tooltip).find(node => node.tag === "details" && node.children[0].textContent === "User message");
  assert(descendants(tooltip).filter(node => node.tag === "details").every(node => !node.open),
    "Every hover disclosure must start collapsed");
  message.open = true;
  tooltip.scrollTop = 120;
  point.events.focus();
  assert(message.open && tooltip.scrollTop === 120);
  assert.equal(calls.length, 1, "The same active hover must retain its cached DOM and expanded content");
  let prevented = false;
  point.events.keydown({key:"Enter",preventDefault(){prevented=true;}});
  assert(prevented && tooltip.contains(focused), "Keyboard activation must enter inline details, not navigate");
  assert.equal(point.querySelector("rect").attributes["pointer-events"], "none",
    "The entire round column must not act as a hover target");
  point.events.pointerleave();
  tooltip.events.pointerenter();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tooltip.hidden, false, "Moving from the round point into its card must allow reading and interaction");
  tooltip.events.pointerleave();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tooltip.hidden, true, "Leaving both the point and its card must dismiss it, even inside the chart");
  assert.equal(chart.events.pointerenter, undefined, "Entering blank chart space must not reopen the card");
  point.events.focus();
  point.events.keydown({key:"Enter",preventDefault(){}});
  assert(!tooltip.hidden && tooltip.contains(focused), "Keyboard users must still be able to enter the card");
  point.events.pointerleave();
  point.events.pointerenter();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tooltip.hidden, false, "Returning to a point must cancel its pending dismissal");
  const tools = descendants(tooltip).find(node => node.tag === "details" && node.children[0].textContent === "Main Session tools");
  assert(!tools.open, "Tools require explicit expansion");
  tools.open = true;
  tools.events.toggle();
  await tick();
  assert.equal(calls.filter(call => call.url.includes("/tools?")).length, 2, "Read all tool pages only on expansion");
  assert.equal(descendants(tools).filter(node => node !== tools && node.tag === "details").length, 2,
    "Keep every tool execution rather than merge away its parameters and result");
  assert(descendants(tools).some(node => node.tag === "pre" && node.textContent === "z".repeat(1000)));
  assert(!descendants(tools).some(node => node.tag === "script"));
  tools.events.toggle();
  point.events.pointerenter();
  await tick();
  assert.equal(calls.length, 3);
  const execution = descendants(tools).find(node => node !== tools && node.tag === "details");
  execution.open = true;
  const otherPoint = descendants(chart).find(node => node.attributes["aria-label"]?.startsWith("Round 0"));
  otherPoint.events.pointerenter();
  assert.equal(tooltip.hidden, false, "Entering another round point must display its card");
  await tick();
  assert(descendants(tooltip).filter(node => node.tag === "details").every(node => !node.open),
    "Switching rounds must not inherit expanded disclosures");
  point.events.pointerenter();
  assert.equal(tooltip.querySelector("details"), message, "Revisiting a round should reuse loaded content");
  assert(descendants(tooltip).filter(node => node.tag === "details").every(node => !node.open),
    "Revisiting a round must collapse messages, tools and nested executions");
  assert.equal(tooltip.scrollTop, 0);
  message.open = true;
  tools.open = true;
  tools.events.toggle();
  assert.equal(calls.length, 4, "Revisiting must not reload cached dialogue or tools");
  chart.events.keydown({key:"Escape"});
  assert.equal(tooltip.hidden, true);
  point.events.focus();
  assert(descendants(tooltip).filter(node => node.tag === "details").every(node => !node.open),
    "Reopening the same round after dismissal must start collapsed");
  for (const association of ["missing", "ambiguous"]) {
    roundAssociation = association;
    elements.get("content").replaceChildren();
    vm.runInContext("renderSession(groupedData)", context);
    const next = elements.get("content").querySelector(".token-chart");
    descendants(next).find(node => node.attributes["aria-label"]?.startsWith("Round 61")).events.focus();
    await tick();
    assert(!descendants(next.querySelector(".trend-tooltip")).some(node => node.tag === "pre"));
    assert(descendants(next.querySelector(".trend-tooltip")).some(node => node.className === "notice"));
  }
  roundAssociation = "matched";
  sharedToolScope = true;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(groupedData)", context);
  const sharedChart = elements.get("content").querySelector(".token-chart");
  descendants(sharedChart).find(node => node.attributes["aria-label"]?.startsWith("Round 61")).events.focus();
  await tick();
  const sharedTools = descendants(sharedChart).find(node => node.tag === "details" && node.children[0].textContent === "Main Session tools");
  sharedTools.open = true;
  sharedTools.events.toggle();
  await tick();
  assert(descendants(sharedChart).some(node => node.className === "notice" && node.textContent.includes("messages added during execution")),
    "Shared interaction tools must be visibly scoped, not silently presented as exclusive to one message");
  assert(descendants(sharedChart).some(node => node.tag === "pre" && node.textContent === dialogueText));
  sharedToolScope = false;
  roundReplyRecorded = false;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(groupedData)", context);
  const missingReplyChart = elements.get("content").querySelector(".token-chart");
  descendants(missingReplyChart).find(node => node.attributes["aria-label"]?.startsWith("Round 61")).events.focus();
  await tick();
  assert(descendants(missingReplyChart).some(node => node.tag === "pre" && node.textContent.includes("assistant reply for this message has not been recorded")));
  assert(descendants(missingReplyChart).some(node => node.tag === "pre" && node.textContent === dialogueText));
  const missingReplyTools = descendants(missingReplyChart).find(node => node.tag === "details" && node.children[0].textContent === "Main Session tools");
  missingReplyTools.open = true;
  missingReplyTools.events.toggle();
  await tick();
  assert(descendants(missingReplyChart).some(node => node.textContent === "Call arguments"),
    "A missing reply must not suppress recorded user messages and tool executions");
  roundReplyRecorded = true;
  failNext = true;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(groupedData)", context);
  const retryChart = elements.get("content").querySelector(".token-chart");
  descendants(retryChart).find(node => node.attributes["aria-label"]?.startsWith("Round 61")).events.focus();
  await tick();
  assert(descendants(retryChart).some(node => node.attributes.role === "alert"));
  descendants(retryChart).find(node => node.textContent === "Retry").events.click();
  await tick();
  assert(descendants(retryChart).some(node => node.tag === "pre" && node.textContent === dialogueText));
}
async function chartChecks() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  calls.length = 0;
  context.openedChart = [];
  const liveChart = vm.runInContext('params.set("round", "61"); tokenChart(trendPoints, (point, trigger) => openedChart.push({id:point.id,trigger}))', context);
  elements.get("content").replaceChildren(liveChart);
  const tooltip = descendants(liveChart).find(node => node.className === "trend-tooltip");
  assert(tooltip?.hidden, "Call details must be hidden until hover or keyboard focus, not a permanent sidebar");
  const detailAction = tooltip.querySelector(".trend-detail-open");
  assert.equal(detailAction?.tag, "button", "The tooltip must have one native detail button");
  assert.equal(descendants(liveChart).filter(node => node.tag === "button").length, 1, "No legend or peak controls should accompany the sole detail action");
  assert.equal(tooltip.children[0].className, "trend-tooltip-header");
  assert.equal(detailAction.parent, tooltip.children[0], "The action belongs beside the title, not below the tool summaries");
  assert(descendants(liveChart).some(node => node.textContent.includes("Loading tool and skill Summaries for the entire Round")));
  descendants(liveChart).filter(node => node.attributes.class === "trend-point")[1].events.pointerenter();
  detailAction.focus();
  await tick();
  assert.equal(tooltip.querySelector(".trend-detail-open"), detailAction, "Late summaries must preserve the focused action instead of recreating it");
  assert.equal(focused, detailAction);
  assert.equal(calls.length, 1);
  assert.equal(new URLSearchParams(calls[0].url.split("?")[1]).get("day"), "29");
  const text = () => descendants(liveChart).map(node => node.textContent).join(" ");
  const points = () => descendants(liveChart).filter(node => node.attributes.class === "trend-point");
  assert(text().includes("No tool Calls for this Call"), "A late batch must update the currently hovered call, not the initially selected one");
  points()[0].events.focus();
  assert(text().includes("Load ponytail") && text().includes("×2 (same summary)"));
  assert(!/Total tokens for this Call|Compared with the previous Call|Input |Output |Cache read|Model |Model Output for this Call|3 total|Skill:|No skill invoked|Totals only|No double counting/.test(descendants(tooltip).map(node => node.textContent).join(" ")),
    "Hover should show only the call identity, action and tool activity, without repeated metrics or explanations");
  assert.equal(descendants(tooltip).filter(node => node.tag === "li" && node.textContent.includes("Load ponytail")).length, 1,
    "Skills should appear once in the activity list, not in a second summary paragraph");
  assert(descendants(tooltip).some(node => node.tag === "li" && node.textContent === "apply_patch"),
    "Successful tools need no repeated success suffix");
  points()[0].events.pointerenter({clientX:620,clientY:700});
  assert.equal(tooltip.style.left, "320px");
  assert.equal(tooltip.style.top, "238px", "A roomy hover position must place the tooltip above the pointer, not below the whole column");
  points()[0].events.pointermove({clientX:620,clientY:100});
  assert.equal(tooltip.style.top, "238px", "Keep the tooltip stable within a call so its links and disclosures remain reachable");
  points()[0].events.pointerenter({clientX:620,clientY:100});
  assert.equal(tooltip.style.top, "112px", "Near the top edge the tooltip should flip below the pointer");
  points()[0].events.pointerenter({clientX:1270,clientY:450});
  assert.equal(tooltip.style.left, "658px");
  assert.equal(tooltip.style.top, "225px", "When neither vertical side fits, use the available side without covering the pointer");
  points()[0].events.pointerenter({clientX:10,clientY:890});
  assert.equal(tooltip.style.left, "8px");
  assert.equal(tooltip.style.top, "428px");
  assert.equal(calls.length, 1, "Moving the tooltip must never refetch activity");
  points()[1].events.pointerenter();
  assert(text().includes("No tool Calls for this Call") && !text().includes("Load ponytail"));
  assert(!text().includes("Total tokens for this Call") && !text().includes("Compared with the previous Call"));
  points()[2].events.focus();
  assert(text().includes("This Call cannot be uniquely linked") && !text().includes("No tool Calls for this Call"));
  assert.equal(calls.length, 1, "Hover and focus must reuse the one batch instead of fetching per-call bodies");
  points()[2].events.click?.();
  assert.equal(context.openedChart.length, 0, "Clicking a chart point must not open single-call details");
  assert.equal(points()[2].attributes.role, "img");
  assert.equal(points()[2].attributes["aria-haspopup"], undefined);
  for (const key of ["Enter", " "]) {
    let prevented = false;
    points()[1].events.keydown({key, preventDefault(){prevented=true;}});
    assert(prevented && focused === detailAction && context.openedChart.length === 0,
      "Keyboard activation of a chart point should focus the sole action, not open a modal");
  }
  detailAction.events.click();
  assert.equal(context.openedChart.at(-1).id, "2");
  assert.equal(context.openedChart.at(-1).trigger, points()[1]);
  points()[0].events.focus();
  detailAction.events.click();
  assert.equal(context.openedChart.at(-1).id, "1", "The persistent button must use the current call, not a stale closure");
  assert.equal(tooltip.hidden, false);
  liveChart.events.pointerleave();
  assert.equal(tooltip.hidden, true);
  points()[0].events.focus();
  assert.equal(tooltip.hidden, false);
  liveChart.events.focusout({relatedTarget: tooltip});
  assert.equal(tooltip.hidden, false, "Moving focus into the hover details must keep them usable");
  liveChart.events.focusout({relatedTarget: body});
  assert.equal(tooltip.hidden, true);
  points()[0].events.focus();
  liveChart.events.keydown({key:"Escape"});
  assert.equal(tooltip.hidden, true);
  points()[0].events.pointerenter();
  liveChart.querySelector(".trend-scroll").events.scroll();
  assert.equal(tooltip.hidden, true, "Pointer summaries must not stay pinned to an old position when the chart scrolls");
  assert.equal(descendants(liveChart).filter(node => node.attributes.class?.includes("trend-line")).length, 3);
  assert.equal(calls.length, 1);
  failNext = true;
  const failedChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(failedChart);
  await tick();
  assert(descendants(failedChart).some(node => node.attributes.role === "alert" && node.textContent.includes("Failed to read tool Summaries")));
  assert.equal(descendants(failedChart).filter(node => node.attributes.class?.includes("trend-line")).length, 3);
  descendants(failedChart).find(node => node.textContent === "Reload Summaries").events.click({preventDefault(){}});
  await tick();
  assert(descendants(failedChart).some(node => node.textContent.includes("Load ponytail")));
  holdActivities = true;
  const staleChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(staleChart);
  holdActivities = false;
  const freshChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(freshChart);
  await tick();
  heldActivities.shift()({ok:true, json:async()=>({calls:[], partial_tail:false})});
  await tick();
  assert(descendants(staleChart).some(node => node.textContent.includes("Loading tool and skill Summaries for the entire Round")), "Detached charts must ignore late responses");
  assert(descendants(freshChart).some(node => node.textContent.includes("Load ponytail")));
  context.mappingRound = {...context.selectedData, requests:[
    {...context.data.requests[0],id:"42"}, {...context.data.requests[0],id:"43"}],
    request_pagination:{page:"1",pages:"1",size:"10",total:"2"}};
  elements.get("content").replaceChildren();
  calls.length = 0;
  vm.runInContext("renderSession(mappingRound)", context);
  await tick();
  assert.equal(elements.get("content").querySelector(".round-conversation"), null);
  assert.equal(elements.get("content").querySelector(".token-chart"), null);
  assert.equal(calls.length, 1, "List-only details must load summaries once without reading full round dialogue");
  assert(calls[0].url.includes("/rounds/activities?"));
  assert(!calls.some(call => call.url.includes("/turns/8/tools?")), "Closed tool groups must not fetch full parameters or results");
  const mappedRows = elements.get("content").querySelector(".round-call-list").querySelectorAll("tbody tr");
  assert(mappedRows.every(row => !row.events.click && row.tabIndex === undefined), "Call rows must not open detail dialogs implicitly");
  const rowAction = mappedRows[1].querySelector(".call-detail-open");
  assert.equal(rowAction.textContent, "View");
  assert.equal(rowAction.type, "button");
  assert.equal(rowAction.attributes["aria-haspopup"], "dialog");
  assert.equal(rowAction.attributes["aria-label"], "View Call 1 details");
  rowAction.events.click();
  await tick();
  assert(calls.at(-1).url.startsWith("/api/sessions/s/requests/43/call?"),
    "A summary row must retain its exact hidden request ID, even when model names repeat");
  body.children.find(node => node.tag === "dialog").close();
  failNext = true;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(selectedData)", context);
  await tick();
  assert(descendants(elements.get("content")).some(node => node.className === "call-summary" && node.textContent.includes("Read failed")),
    "The shared batch failure must remain explicit in list summaries");
  const retrySummary = descendants(elements.get("content")).find(node => node.textContent === "Reload Summaries");
  assert(retrySummary && retrySummary.parent.attributes.role === "alert");
  retrySummary.events.click();
  await tick();
  assert(descendants(elements.get("content")).some(node => node.className === "call-summary" && node.textContent.includes("Load ponytail")),
    "List summaries must support retry without a chart");
  holdActivities = true;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(selectedData)", context);
  const staleSection = elements.get("content").querySelector(".round-call-section");
  await tick();
  holdActivities = false;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(selectedData)", context);
  await tick();
  heldActivities.shift()({ok:true, json:async()=>({calls:[], partial_tail:false})});
  await tick();
  assert(descendants(staleSection).some(node => node.className === "call-summary" && node.textContent.includes("Loading")),
    "Detached call lists must ignore late summaries");
  assert(descendants(elements.get("content")).some(node => node.className === "call-summary" && node.textContent.includes("Load ponytail")));
  vm.runInContext('params.delete("round")', context);
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(data)", context);
  requestRow = descendants(elements.get("content")).find(node => node.tag === "tr" && node.attributes["aria-haspopup"] === "dialog");
}
async function dialogChecks() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  calls.length = 0;
  const currentDialog = () => body.children.find(node => node.tag === "dialog");
  requestRow.events.click();
  let dialog = currentDialog();
  assert(dialog?.open);
  assert.equal(dialog.attributes["aria-labelledby"], "request-detail-title");
  await tick();
  const fields = descendants(dialog);
  assert(!fields.some(node => node.tag === "dl" || node.tag === "dd"), "Request metrics must not be duplicated in the dialogue modal");
  assert(descendants(requestRow).some(node => node.textContent === "90,071,992,547,409,931,234,567,890"));
  assert(descendants(requestRow).some(node => node.textContent === "4423.464167"));
  assert(fields.some(node => node.tag === "pre" && node.textContent === "synthetic single output 1"));
  assert(!fields.some(node => node.textContent === "synthetic final reply" || node.textContent === dialogueText),
    "A row detail must not substitute the full-round user message/final response");
  assert(!fields.some(node => node.tag === "img" || node.tag === "script"));
  assert(calls[0].url.startsWith("/api/sessions/s/requests/1/call?"));
  assert.equal(calls[0].headers["X-TokenFlow-Key"], "synthetic-secret");
  assert.equal(focused, dialog);
  assert(!fields.some(node => node.tag === "button"), "The row popup must not contain buttons");
  assert.equal(new URLSearchParams(calls[0].url.split("?")[1]).size, 0);
  assert(!calls.some(call => call.url.includes("/turns/8/tools?")), "Request rows must not read same-round tools");
  assert(fields.some(node => node.tag === "summary" && node.textContent.includes("<script>synthetic single tool</script>")));
  assert(fields.some(node => node.tag === "pre" && node.textContent === '{"command":"only-this-call"}'));
  assert(!fields.some(node => node.tag === "script"));
  assert(fields.some(node => node.textContent === "The full Input context for this Call was not recorded"));
  assert(fields.some(node => node.tag === "pre" && node.textContent.length > 1000));
  assert(descendants(dialog).filter(node => node.tag === "details").length >= 3);
  assert(descendants(dialog).filter(node => node.tag === "details").every(node => !node.open),
    "Single-call input, output and tools must start collapsed");
  assert.equal(calls.length, 1, "Each request detail should load its own complete call once");
  assert.equal(location.search, "?sid=s&year=2024&month=2&day=29&list=" + encodeURIComponent("year=2024&month=2&day=29&page=3"));
  const inside = {target: dialog, clientX: 150, clientY: 150};
  const outside = {target: dialog, clientX: 50, clientY: 50};
  dialog.events.pointerdown(inside);
  dialog.events.click(inside);
  assert(dialog.open, "Clicking whitespace inside the popup must not close it");
  dialog.events.pointerdown(inside);
  dialog.events.click(outside);
  assert(dialog.open, "Dragging from popup to backdrop must not close it");
  dialog.events.pointerdown(outside);
  dialog.events.click({...outside, target: fields.find(node => node.tag === "pre")});
  assert(dialog.open, "Bubbled content clicks must not close the popup");
  dialog.events.pointerdown(outside);
  dialog.events.click(outside);
  assert(!currentDialog());
  assert.equal(focused, requestRow);
  selection = "selected table text";
  requestRow.events.click();
  assert(!currentDialog());
  selection = "";
  for (const key of ["Enter", " "]) {
    let prevented = false;
    requestRow.events.keydown({key, preventDefault() { prevented = true; }});
    assert(prevented);
    await tick();
    dialog = currentDialog();
    assert(dialog?.open);
    dialog.close();
    assert.equal(focused, requestRow);
  }
  failNext = true;
  requestRow.events.click();
  await tick();
  dialog = currentDialog();
  assert(descendants(dialog).some(node => node.attributes.role === "alert"));
  descendants(dialog).find(node => node.textContent === "Retry").events.click({preventDefault() {}});
  await tick();
  assert(descendants(dialog).some(node => node.tag === "pre"));
  dialog.close();
  deferNext = true;
  requestRow.events.click();
  const pending = calls.at(-1).signal;
  currentDialog().close();
  await tick();
  assert(pending.aborted);
  assert(!currentDialog());
  callStatus = "ambiguous";
  requestRow.events.click();
  await tick();
  assert(!descendants(currentDialog()).some(node => node.tag === "pre"), "Ambiguous calls must not fall back to whole-round data");
  currentDialog().close();
  callStatus = "matched";
  context.data.requests.push({...context.data.requests[0], id: "2"});
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(data)", context);
  const second = descendants(elements.get("content")).find(node => node.tag === "tr" && node.attributes["aria-label"] === "View request 2 details");
  second.events.click();
  await tick();
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === "synthetic single final 2"));
  assert.equal(descendants(currentDialog()).filter(node => node.tag === "details").length, 2);
  assert(!descendants(currentDialog()).some(node => node.textContent === "synthetic single output 1"),
    "Another row in the same turn must show only that call's output and tools");
  vm.runInContext('params.set("round", "61")', context);
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(selectedData)", context);
  const roundHeading = elements.get("content").querySelector(".round-title");
  currentDialog().close();
  assert.equal(focused, roundHeading, "If the original row is detached, restore focus to the visible round heading, not the hidden refresh button");
  assert.equal(roundHeading.tabIndex, -1);
  vm.runInContext('params.delete("round")', context);
  context.data.requests = [];
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(data)", context);
  descendants(elements.get("content")).find(node => node.tag === "button" && node.textContent === "All Session records").events.click();
  await tick();
  assert(currentDialog()?.open, "Sessions with no model requests must retain access to conversation records");
  assert(descendants(currentDialog()).filter(node => node.tag === "details").every(node => !node.open),
    "Whole-session turns and tools must start collapsed");
  assert(!descendants(currentDialog()).some(node => node.textContent.includes("duration and time to first token")));
  const sessionCall = calls.findLast(call => call.url.startsWith("/api/sessions/s?"));
  assert(sessionCall);
  assert(!new URLSearchParams(sessionCall.url.split("?")[1]).has("view"));
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === dialogueText));
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === "synthetic final reply"));
  descendants(currentDialog()).find(node => node.tag === "a" && node.textContent === "Next").events.click({preventDefault() {}});
  await tick();
  assert(calls.some(call => call.url.startsWith("/api/sessions/s?") && new URLSearchParams(call.url.split("?")[1]).get("turnPage") === "2"));
  currentDialog().close();
  const viewAll = descendants(elements.get("content")).find(node => node.tag === "button" && node.textContent === "All Session records");
  deferTools = true;
  viewAll.events.click();
  await tick();
  const toolPending = calls.at(-1).signal;
  currentDialog().close();
  await tick();
  assert(toolPending.aborted);
  failTools = true;
  viewAll.events.click();
  await tick();
  assert(descendants(currentDialog()).some(node => node.attributes.role === "alert"));
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === dialogueText));
  const warning = descendants(currentDialog()).find(node => node.attributes.role === "alert");
  assert.equal(warning.parent.tag, "section", "Tool errors must remain outside the collapsed turn");
  assert.equal(warning.parent.parent.tag, "dialog");
  currentDialog().close();
}
async function paginationChecks() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  context.pagingData = {...context.selectedData, session:{id:"s"}, round:"61",
    request_pagination:{page:"1",pages:"3",size:"10",total:"21"}};
  vm.runInContext('params.set("round","61"); params.delete("requestPage")', context);
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(pagingData)", context);
  await tick();
  const heading = elements.get("content").querySelector(".round-heading");
  const totals = elements.get("content").querySelector(".call-overview");
  const section = elements.get("content").querySelector(".round-call-section");
  const listing = section.querySelector(".round-call-list");
  const originalRows = listing.querySelectorAll("tbody tr");
  listing.scrollTop = 100; listing.scrollHeight = 500; listing.clientHeight = 400;
  assert(!section.querySelector("nav"), "Detail lists must not expose previous/next pagination controls");
  const click = () => listing.events.wheel({deltaY:100});
  calls.length = 0;
  click();
  await tick();
  assert.equal(calls.length, 1, "Paging should request only the list, not reload activities or conversation");
  assert(calls[0].url.includes("/rounds?"));
  assert.equal(elements.get("content").querySelector(".round-heading"), heading);
  assert.equal(elements.get("content").querySelector(".call-overview"), totals);
  assert.equal(elements.get("content").querySelector(".token-chart"), null);
  assert.equal(elements.get("content").querySelector(".round-conversation"), null);
  assert(descendants(section).some(node => node.className === "call-summary" && node.textContent === "No tool Calls for this Call."),
    "Pagination must use already-loaded summaries without fetching them again");
  assert.equal(vm.runInContext('params.get("requestPage")', context), "2");
  assert.equal(history.pushes.length, 0, "List pagination must never create a browser history entry");
  assert(history.url.includes("requestPage=2"));
  assert.equal(section.querySelector(".round-call-list"), listing, "Scrolling must keep the same list and existing rows");
  assert.equal(listing.querySelectorAll("tbody tr").length, originalRows.length + 1, "The next page must append to the list");
  assert.equal(listing.querySelectorAll("tbody tr")[0], originalRows[0]);
  const row = listing.querySelectorAll("tbody tr").at(-1);
  row.querySelector(".call-detail-open").events.click();
  await tick();
  assert(calls.at(-1).url.includes("/requests/2/call?"), "New rows must keep exact request IDs after partial paging");
  body.children.find(node => node.tag === "dialog").close();
  const previousURL = history.url;
  failNext = true;
  click();
  await tick();
  assert.equal(history.url, previousURL, "Failed pagination must not advance the URL");
  assert.equal(listing.querySelectorAll("tbody tr").at(-1), row, "Keep existing rows on read failure");
  assert(descendants(section).some(node => node.attributes.role === "alert" && node.textContent.includes("Failed to read page")));
  descendants(section).find(node => node.tag === "button" && node.textContent === "Retry").events.click();
  await tick();
  assert.equal(vm.runInContext('params.get("requestPage")', context), "3");
  const completedCount = calls.length;
  click();
  assert.equal(calls.length, completedCount, "Scrolling beyond the last page must not request nonexistent pages");
  assert.equal(elements.get("content").querySelector(".call-overview"), totals);

  context.pagingData = {...context.pagingData, request_pagination:{page:"2",pages:"3",size:"10",total:"21"}};
  elements.get("content").replaceChildren();
  vm.runInContext('params.set("requestPage","2"); renderSession(pagingData)', context);
  await tick();
  const middleSection = elements.get("content").querySelector(".round-call-section");
  const middleList = middleSection.querySelector(".round-call-list");
  middleList.scrollTop = 0; middleList.scrollHeight = 500; middleList.clientHeight = 400;
  const retainedRow = middleList.querySelectorAll("tbody tr")[0];
  middleList.events.wheel({deltaY:-100});
  await tick();
  assert.equal(vm.runInContext('params.get("requestPage")', context), "1");
  assert.equal(middleList.querySelectorAll("tbody tr")[1], retainedRow, "Loading a previous page must prepend without deleting visible rows");
  middleList.scrollTop = 100;
  const fetch = context.fetch;
  let release;
  context.fetch = (url, options) => {
    calls.push({url, ...options});
    return new Promise(resolve => { release = () => resolve({ok:true,json:async () => ({
      ...context.pagingData, request_pagination:{...context.pagingData.request_pagination,page:"3"}})}); });
  };
  try {
    middleList.events.wheel({deltaY:100});
    await tick();
    const inFlightCount = calls.length;
    middleList.events.wheel({deltaY:100});
    assert.equal(calls.length, inFlightCount, "Repeated boundary scrolling must not duplicate an in-flight page");
    elements.get("content").replaceChildren();
    middleList.events.wheel({deltaY:100});
    assert.equal(calls.length, inFlightCount, "Detached lists must not request more pages");
    release();
    await tick();
    assert.equal(vm.runInContext('params.get("requestPage")', context), "1", "A detached list response must not update the URL");
  } finally { context.fetch = fetch; }
  assert.equal(history.pushes.length, 0);
}
async function roundDialogChecks() {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  context.roundDialogData = {...context.selectedData, session:{id:"s"}, round:"61",
    metrics:{...metrics, calls:"21"}, request_pagination:{page:"1",pages:"3",size:"10",total:"21"}};
  vm.runInContext('params.delete("round"); params.delete("requestPage"); params.set("roundPage", "2")', context);
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(groupedData)", context);
  const pageChart = elements.get("content").querySelector(".token-chart");
  const pageListing = elements.get("content").querySelector(".session-round-list");
  pageListing.scrollTop = 180;
  const beforeURL = history.url, beforeParams = vm.runInContext("params.toString()", context);
  const triggers = pageListing.querySelectorAll("tbody tr").map(row => row.querySelector("button"));
  const currentDialog = () => body.children.find(node => node.tag === "dialog");
  calls.length = 0;
  triggers[0].events.click();
  const dialog = currentDialog();
  assert(dialog?.open && dialog.className.includes("round-call-dialog"));
  await tick();
  const list = dialog.querySelector(".round-dialog-list");
  const detail = dialog.querySelector(".round-dialog-detail");
  assert(!list.hidden && detail.hidden);
  assert.equal(body.children.filter(node => node.tag === "dialog").length, 1);
  assert.equal(calls.length, 2, "Opening round details must read only its call list and safe summaries");
  const query = new URLSearchParams(calls[0].url.split("?")[1]);
  assert.equal(query.get("round"), "61");
  assert.equal(query.get("day"), "29");
  assert(!query.has("roundPage") && !query.has("list"));
  assert(descendants(list).some(node => node.className === "call-overview" && node.textContent === "21 Calls total · Round Total tokens 120"));
  assert(!descendants(list).some(node => node.tag === "svg"));
  const section = list.querySelector(".round-call-section");
  assert(descendants(section).some(node => node.className === "call-summary" && node.textContent.includes("Load ponytail")));
  const next = () => descendants(section).find(node => node.tag === "button" && node.textContent === "Next");
  next().events.click();
  await tick();
  assert.equal(calls.length, 3, "Dialog pagination must reuse already-loaded summaries");
  assert.equal(new URLSearchParams(calls.at(-1).url.split("?")[1]).get("round"), "61");
  assert.equal(new URLSearchParams(calls.at(-1).url.split("?")[1]).get("requestPage"), "2");
  assert.equal(vm.runInContext("params.toString()", context), beforeParams);
  assert.equal(history.url, beforeURL, "Dialog pagination must not modify the page URL or history");
  const callListing = section.querySelector(".round-call-list");
  callListing.scrollTop = 90;
  dialog.scrollTop = 60;
  const view = callListing.querySelector(".call-detail-open");
  view.events.click();
  await tick();
  assert(list.hidden && !detail.hidden);
  assert.equal(currentDialog(), dialog, "Single-call details must use the same dialog, not create a nested dialog");
  assert.equal(body.children.filter(node => node.tag === "dialog").length, 1);
  assert(calls.at(-1).url.includes("/requests/2/call?"), "Details must use the exact ID from the current list page");
  assert(descendants(detail).some(node => node.tag === "pre" && node.textContent === "synthetic single final 2"));
  assert(descendants(detail).filter(node => node.tag === "details").every(node => !node.open));
  const back = descendants(dialog).find(node => node.tag === "button" && node.textContent === "Back to Call list");
  const readCount = calls.length;
  back.events.click();
  assert(!list.hidden && detail.hidden);
  assert.equal(section.querySelector(".round-call-list"), callListing);
  assert.equal(callListing.scrollTop, 90);
  assert.equal(dialog.scrollTop, 60);
  assert.equal(focused, view, "Returning to the list must restore focus to the selected call");
  assert.equal(calls.length, readCount, "Returning to a list must retain its page and avoid reloading");
  deferNext = true;
  view.events.click();
  await tick();
  const pendingDetail = calls.at(-1).signal;
  back.events.click();
  await tick();
  assert(pendingDetail.aborted, "Returning to the list must cancel an unfinished single-call read");
  assert(!list.hidden && detail.hidden);
  failNext = true;
  view.events.click();
  await tick();
  assert(descendants(detail).some(node => node.attributes.role === "alert"));
  descendants(detail).find(node => node.textContent === "Retry").events.click({preventDefault(){}});
  await tick();
  assert(descendants(detail).some(node => node.tag === "pre" && node.textContent === "synthetic single final 2"));
  back.events.click();
  failNext = true;
  next().events.click();
  await tick();
  assert.equal(section.querySelector(".round-call-list"), callListing);
  descendants(section).find(node => node.tag === "button" && node.textContent === "Retry").events.click();
  await tick();
  assert.equal(new URLSearchParams(calls.at(-1).url.split("?")[1]).get("requestPage"), "3");
  descendants(dialog).find(node => node.tag === "button" && node.textContent === "Close").events.click();
  assert(!currentDialog());
  assert.equal(focused, triggers[0]);
  assert.equal(elements.get("content").querySelector(".token-chart"), pageChart);
  assert.equal(elements.get("content").querySelector(".session-round-list"), pageListing);
  assert.equal(pageListing.scrollTop, 180);
  assert.equal(vm.runInContext("params.toString()", context), beforeParams);
  assert.equal(history.url, beforeURL);
  for (const [index, expected] of [[1, "missing"], [2, "0"]]) {
    calls.length = 0;
    triggers[index].events.click();
    await tick();
    assert.equal(new URLSearchParams(calls[0].url.split("?")[1]).get("round"), expected);
    assert(currentDialog().querySelector(".round-call-list"), "Zero and missing rounds must remain distinct and readable");
    currentDialog().close();
  }
  failNext = true;
  triggers[0].events.click();
  await tick();
  const failedList = currentDialog().querySelector(".round-dialog-list");
  assert(descendants(failedList).some(node => node.attributes.role === "alert"));
  descendants(failedList).find(node => node.tag === "button" && node.textContent === "Retry").events.click();
  await tick();
  assert(failedList.querySelector(".round-call-list"));
  currentDialog().close();
  deferNext = true;
  triggers[0].events.click();
  await tick();
  const pendingList = calls.at(-1).signal;
  currentDialog().close();
  await tick();
  assert(pendingList.aborted, "Closing the dialog must cancel its pending initial list read");
  assert(!currentDialog());
  triggers[0].events.click();
  await tick();
  const pagingSection = currentDialog().querySelector(".round-call-section");
  deferNext = true;
  descendants(pagingSection).find(node => node.tag === "button" && node.textContent === "Next").events.click();
  await tick();
  const pendingPage = calls.at(-1).signal;
  currentDialog().close();
  await tick();
  assert(pendingPage.aborted, "Closing must cancel unfinished dialog pagination");
  holdActivities = true;
  triggers[0].events.click();
  await tick();
  const pendingSummary = calls.at(-1).signal;
  currentDialog().close();
  holdActivities = false;
  assert(pendingSummary.aborted, "Closing must cancel unfinished operation summaries");
  heldActivities.shift()({ok:true,json:async () => ({calls:[],partial_tail:false})});
  await tick();
  assert(!currentDialog(), "Late summaries must not reopen a closed dialog");
  const fetch = context.fetch;
  context.fetch = async (url, options) => url.includes("/rounds?")
    ? {ok:true,json:async () => ({...context.roundDialogData, round:"999"})} : fetch(url, options);
  triggers[0].events.click();
  await tick();
  const invalidList = currentDialog().querySelector(".round-dialog-list");
  assert(descendants(invalidList).some(node => node.attributes.role === "alert" && node.textContent.includes("invalid result")));
  assert(!invalidList.querySelector(".round-call-list"), "A different round's data must never be displayed");
  context.fetch = fetch;
  descendants(invalidList).find(node => node.tag === "button" && node.textContent === "Retry").events.click();
  await tick();
  assert(invalidList.querySelector(".round-call-list"));
  currentDialog().close();
  assert.equal(history.url, beforeURL);
  assert.equal(vm.runInContext("params.toString()", context), beforeParams);
  delete context.roundDialogData;
}
async function overviewScrollChecks() {
  const fetch = context.fetch, requests = [];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const pageData = page => ({...context.groupedData,
    rounds:Array.from({length:page === 3 ? 5 : 10}, (_, index) => ({
      ...context.groupedData.rounds[0],turn_index:String(24 - (page - 1) * 10 - index)
    })),
    round_pagination:{page:String(page),pages:"3",size:"10",total:"25"}
  });
  context.scrollingOverview = pageData(2);
  context.fetch = (url, options) => {
    requests.push({url, ...options});
    const query = new URLSearchParams(url.split("?")[1]);
    return Promise.resolve({ok:true,json:async () => pageData(Number(query.get("roundPage")))});
  };
  try {
    elements.get("content").replaceChildren();
    vm.runInContext('params.delete("round"); params.delete("requestPage"); params.set("roundPage","2"); renderSession(scrollingOverview)', context);
    const section = home.querySelector(".round-call-section"), listing = section.querySelector(".session-round-list");
    const chart = home.querySelector(".token-chart"), info = home.querySelector(".session-info");
    const originalRows = listing.querySelectorAll("tbody tr");
    assert(!section.querySelector("nav"));
    Object.defineProperty(listing, "scrollHeight", {get:() => listing.querySelectorAll("tbody tr").length * 70 + 40});
    listing.clientHeight = 400;
    listing.scrollTop = 340;
    listing.events.wheel({deltaY:100,deltaX:200});
    listing.events.wheel({deltaY:100,shiftKey:true});
    assert.equal(requests.length, 0, "Horizontal scrolling must not load vertical pages");
    listing.events.scroll();
    listing.events.wheel({deltaY:100});
    await tick();
    assert.equal(requests.length, 1, "Touch/scrollbar scrolling must load only one adjacent page");
    assert.equal(new URLSearchParams(requests[0].url.split("?")[1]).get("roundPage"), "3");
    assert.equal(new URLSearchParams(requests[0].url.split("?")[1]).get("day"), "29", "Scrolling must preserve the active date range");
    assert.equal(listing.querySelectorAll("tbody tr").length, 15);
    assert.equal(listing.scrollTop, 340, "Appending must preserve the visible position");
    listing.scrollTop = 0;
    listing.events.scroll();
    await tick();
    assert.equal(requests.length, 2);
    assert.equal(new URLSearchParams(requests[1].url.split("?")[1]).get("roundPage"), "1");
    assert.equal(listing.scrollTop, 700, "Prepending must offset the added height to preserve the same visible rows");
    assert.equal(listing.querySelectorAll("tbody tr")[10], originalRows[0]);
    assert.deepEqual(listing.querySelectorAll("tbody tr").map(row => row.children[0].children[0].textContent),
      Array.from({length:25}, (_, index) => `Round ${24 - index}`));
    assert.equal(home.querySelector(".token-chart"), chart);
    assert.equal(home.querySelector(".session-info"), info);
    listing.scrollTop = 0; listing.events.wheel({deltaY:-100});
    listing.scrollTop = listing.scrollHeight - listing.clientHeight; listing.events.wheel({deltaY:100});
    assert.equal(requests.length, 2, "Loaded pages must remain available without repeat reads");
    assert.equal(section.attributes["aria-busy"], "false");
    assert.equal(section.querySelector(".round-scroll-status").textContent, "All records shown");
  } finally { context.fetch = fetch; }
}
async function dashboardSortLoadChecks() {
  const fetch = context.fetch, requested = [];
  context.fetch = async url => {
    requested.push(url);
    const query = new URLSearchParams(url.split("?")[1]);
    const period = query.get("date") === "today" ? context.dashboardData.today
      : query.get("year") ? [query.get("year"),query.get("month").padStart(2,"0"),query.get("day").padStart(2,"0")].join("-")
      : "2026-11-06 ~ 2026-11-12";
    return {ok:true,json:async () => ({...context.dashboardData,period})};
  };
  try {
    vm.runInContext('for(const key of [...params.keys()]) params.delete(key); params.set("sort","total_tokens_asc"); loading=false', context);
    await vm.runInContext("load()", context);
    assert.equal(new URLSearchParams(requested[0].split("?")[1]).get("date"), "today");
    assert.equal(new URLSearchParams(requested[0].split("?")[1]).get("pageSize"), "10");
    assert.equal(elements.get("content").querySelector(".dashboard-periods").children[0].attributes["aria-pressed"], "true");
    await vm.runInContext("load(true)", context);
    assert.equal(new URLSearchParams(requested[1].split("?")[1]).get("day"), "12");
    vm.runInContext('for(const key of ["year","month","day"]) params.delete(key); params.set("date","last7")', context);
    await vm.runInContext("load()", context);
    const query = new URLSearchParams(requested.at(-1).split("?")[1]);
    assert.equal(query.get("date"), "last7");
    assert.equal(query.get("sort"), "total_tokens_asc");
  } finally {
    vm.runInContext("clearTimeout(refreshTimer); refreshTimer=undefined", context);
    context.fetch = fetch;
  }
}
async function dashboardDateLoadChecks() {
  const fetch = context.fetch, pending = [];
  context.fetch = (url, options) => new Promise((resolve, reject) => {
    pending.push({url, signal:options.signal, resolve});
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {once:true});
  });
  const complete = (request, extra = {}) => {
    const query = new URLSearchParams(request.url.split("?")[1]);
    const start = query.get("start") || (query.get("date") === "last7" ? "2026-11-06" : null);
    const end = query.get("end") || (start ? "2026-11-12" : null);
    const selected = query.has("year") ? ["year", "month", "day"].map((field, index) =>
      query.get(field)?.padStart(index ? 2 : 4, "0")).filter(Boolean).join("-") : context.dashboardData.today;
    request.resolve({ok:true,json:async () => ({...context.dashboardData,
      period:start ? `${start} ~ ${end}` : selected,
      range_start:start,range_end:end,...extra})});
  };
  try {
    vm.runInContext('for(const key of [...params.keys()]) params.delete(key); params.set("date","today"); params.set("sort","total_tokens_asc"); params.set("repository","owner/repo-a"); params.set("model","gpt-5"); params.set("pageSize","50"); loading=false; renderDashboard({...dashboardData,period:dashboardData.today})', context);
    const todayLink = descendants(home).find(node => node.tag === "a" && node.textContent === "View");
    const todayQuery = new URLSearchParams(todayLink.href.slice(2));
    assert.equal(todayQuery.get("year"), "2026");
    assert.equal(todayQuery.get("month"), "11");
    assert.equal(todayQuery.get("day"), "12", "Today links must use the applied service date rather than all-time details");
    const overview = home.querySelector(".dashboard-overview"), filter = home.querySelector(".dashboard-time-filter");
    const oldSummary = home.querySelector(".dashboard-summary"), previousSearch = location.search;
    const last7 = vm.runInContext('load(false,new URLSearchParams("date=last7&sort=total_tokens_asc&repository=owner%2Frepo-a&model=gpt-5&pageSize=50"))', context);
    assert.equal(home.querySelector(".dashboard-summary"), oldSummary, "Keep old data visible while fetching");
    assert.equal(location.search, previousSearch, "Do not navigate before data succeeds");
    complete(pending.at(-1));
    await last7;
    assert.equal(home.querySelector(".dashboard-overview"), overview);
    assert.equal(home.querySelector(".dashboard-time-filter"), filter, "Refresh must preserve the date controls rather than recreate the page");
    assert.equal(new URLSearchParams(location.search).get("date"), "last7");
    assert.equal(filter.querySelector(".dashboard-periods").children[1].attributes["aria-pressed"], "true");
    const start = filter.querySelector(".dashboard-date-picker");
    setDatePicker(start, "2024-02-");
    const custom = vm.runInContext('load(false,new URLSearchParams("year=2024&month=2&sort=total_tokens_asc&repository=owner%2Frepo-a&model=gpt-5&pageSize=50"))', context);
    complete(pending.at(-1));
    await custom;
    assert.equal(filter.querySelector(".dashboard-periods").children[2].attributes["aria-pressed"], "true");
    assert(!filter.querySelector(".dashboard-range-dialog").open, "An applied custom range must not automatically open its dialog");
    assert(!start.querySelector(".dashboard-date-year").children.some(option => Number(option.value) > 2026));
    const sessionLink = descendants(home).find(node => node.tag === "a" && node.textContent === "View");
    const detailQuery = new URLSearchParams(sessionLink.href.slice(2));
    assert.equal(detailQuery.get("year"), "2024");
    assert.equal(detailQuery.get("month"), "2");
    assert(!detailQuery.has("day") && !detailQuery.has("start") && !detailQuery.has("end"));
    assert.equal(datePickerValue(start), "2024-02-", "Applied All days must remain selected after data refresh");
    assert.equal(new URLSearchParams(detailQuery.get("list")).get("repository"), "owner/repo-a");
    setDatePicker(start, "2024-02-27");
    vm.runInContext('renderDashboard({...dashboardData,period:"2024-02"},true)', context);
    assert.equal(datePickerValue(start), "2024-02-27", "Automatic refresh must preserve unapplied custom date edits");
    const wholeYear = vm.runInContext('load(false,new URLSearchParams("year=2024&sort=total_tokens_asc&repository=owner%2Frepo-a&model=gpt-5&pageSize=50"))', context);
    complete(pending.at(-1));
    await wholeYear;
    assert.equal(datePickerValue(start), "2024--", "Applied All months must remain selected after data refresh");
    assert.equal(start.querySelector(".dashboard-date-day").disabled, true);
    setDatePicker(start, "2023--");
    vm.runInContext('renderDashboard({...dashboardData,period:"2024"},true)', context);
    assert.equal(datePickerValue(start), "2023--", "Automatic refresh must preserve an unapplied whole-year selection");
    const first = vm.runInContext('load(false,new URLSearchParams("date=last7"))', context);
    const stale = pending.at(-1);
    const latest = vm.runInContext('load(false,new URLSearchParams("date=today"))', context);
    assert.equal(stale.signal.aborted, true);
    complete(stale);
    complete(pending.at(-1));
    await Promise.all([first, latest]);
    assert.equal(new URLSearchParams(location.search).get("date"), "today", "An older response must not overwrite the latest selection");
    assert.equal(elements.get("error").hidden, true, "Cancelled obsolete requests must not display errors");
    const currentSummary = home.querySelector(".dashboard-summary"), beforeFailure = location.search;
    const failed = vm.runInContext('load(false,new URLSearchParams("date=last7"))', context);
    pending.at(-1).resolve({ok:false,json:async () => ({error:"synthetic range failure"})});
    await failed;
    assert.equal(home.querySelector(".dashboard-summary"), currentSummary);
    assert.equal(location.search, beforeFailure);
    assert.equal(vm.runInContext('params.get("date")', context), "today");
    assert(elements.get("error").textContent.includes("synthetic range failure"));
    assert.equal(elements.get("error").hidden, false);
  } finally {
    vm.runInContext("clearTimeout(refreshTimer); refreshTimer=undefined", context);
    context.fetch = fetch;
  }
}
overviewHoverChecks().then(chartChecks).then(dialogChecks).then(paginationChecks).then(roundDialogChecks).then(overviewScrollChecks).then(dashboardSortLoadChecks).then(dashboardDateLoadChecks).then(() => console.log("web checks passed: precise integers, dashboard layout, date dialogs, scroll-loaded detail pages, exact trends, pie shares, pagination, sorting and refresh, descending request numbers, chart-only layout, hover-only call details, batch skills/tools, hover caching, fragment removal, safe text, modal dialogue, lazy body, paging, cancellation and original-period navigation"))
  .catch(error => { console.error(error); process.exitCode = 1; });
