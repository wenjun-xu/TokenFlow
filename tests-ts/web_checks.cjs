"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM records text/links; this is not a real-browser acceptance claim.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ""; this.style = {}; }
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll() { return []; }
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
let roundAssociation = "matched";
const heldActivities = [];
const calls = [];
const dialogueText = "<script>synthetic user message</script>\n中文" + "x".repeat(1000);
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
    return Promise.resolve({
      ok: !failed,
      json: async () => failed ? {error: "synthetic query failure"} : url.includes("/rounds/activities?") ? {
        partial_tail: false, calls: [
          {request_id: "1", status: "matched", message: "matched", tools: [
            {name: "functions.skill", summary: "加载 ponytail", kind: "skill", status: "success"},
            {name: "functions.view", summary: "查看 src/store.ts", kind: "tool", status: "pending"},
            {name: "functions.view", summary: "查看 src/store.ts", kind: "tool", status: "pending"},
            {name: "functions.apply_patch", summary: "参数格式无法概述", kind: "tool", status: "success"}]},
          {request_id: "2", status: "matched", message: "matched", tools: []},
          {request_id: "3", status: "ambiguous", message: "无法唯一关联本次调用", tools: []},
        ],
      } : url.includes("/rounds?") ? {
        ...context.pagingData,
        requests: [{...context.pagingData.requests[0],id:query.get("requestPage") || "1"}],
        request_pagination:{...context.pagingData.request_pagination,page:query.get("requestPage") || "1"},
      } : url.includes("/call?") ? {
        status: callStatus, message: callStatus === "matched" ? "本次独立调用，不是整轮对话" : "无法唯一关联本次调用",
        input: {status: "missing", content: null, message: "本次完整输入上下文未记录"},
        outputs: callStatus !== "matched" ? [] : [url.includes("/requests/2/") ? "synthetic single final 2" : "synthetic single output 1"],
        tools: callStatus !== "matched" || url.includes("/requests/2/") ? [] : [
          {id: "single-tool", name: "<script>synthetic single tool</script>", status: "success", arguments: '{"command":"only-this-call"}',
            result: "single result ".repeat(100), truncated: false, timestamp_display: "2024-11-03 16:01:02"}],
      } : url.includes("/tools?") ? {
        status: "matched", message: "同轮工具过程，不代表仅属于本次模型请求",
        tools: [{ id: "tool-" + query.get("page"), name: "<script>synthetic tool</script>", status: "success",
          timestamp_display: "2024-11-03 16:01:02", arguments: '{"command":"synthetic"}',
          result: query.get("full") === "1" ? "z".repeat(1000) : "z".repeat(400), truncated: query.get("full") !== "1" }],
        pagination: {page: query.get("page") || "1", pages: "2", total: "21"},
      } : {
        request: {...context.data.requests[0], turn_index: url.includes("/requests/") ? vm.runInContext('params.get("round")', context) : "0"},
        association: url.includes("/requests/") ? roundAssociation : query.get("view") === "all" ? "all" : "matched",
        turns: [{id, turn_index: url.includes("/requests/") ? vm.runInContext('params.get("round")', context) : id === "8" ? "0" : "20", timestamp: "2024-11-03T08:01:02Z",
          timestamp_display: "2024-11-03 16:01:02",
          user_message: query.get("full") === "1" ? dialogueText : dialogueText.slice(0, 400),
          assistant_response: "synthetic final reply", truncated: query.get("full") !== "1"}],
        turn_pagination: {page: query.get("turnPage") || "1", pages: "2", total: "21"},
      },
    });
  }, window: {getSelection: () => selection, innerWidth: 1280, innerHeight: 900, events:{},
    addEventListener(name, callback) { this.events[name] = callback; }},
});
const source = fs.readFileSync(path.join(__dirname, "../web/app.js"), "utf8");
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/tool-summary.js"), "utf8").replaceAll("export function ", "function "), context);
vm.runInContext(source.replace('import { toolSynopsis, safeLabel } from "./tool-summary.js";', ""), context);
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
assert.equal(vm.runInContext("integer(null)", context), "未知");
assert.equal(vm.runInContext('integer("0")', context), "0");
assert.equal(vm.runInContext('displayTime({created_at: "2024-11-03T08:01:02Z", created_at_display: "2024-11-03 16:01:02"}, "created_at")', context),
  "2024-11-03 16:01:02");
assert.equal(vm.runInContext('displayTime({timestamp: "2024-02-30T00:00:00Z", timestamp_display: null}, "timestamp")', context),
  "2024-02-30T00:00:00Z（时间异常）");
assert.equal(vm.runInContext('displayTime({timestamp: null}, "timestamp")', context), "未记录");
function synopsis(name, args) {
  context.summaryTool = { name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  return vm.runInContext("toolSynopsis(summaryTool)", context);
}
assert.equal(synopsis("functions.skill", {skill: "ponytail"}), "加载 ponytail");
assert.equal(synopsis("functions.view", {path: "/sample/project/src/store.ts", view_range: [135, 200]}),
  "查看 src/store.ts · 第 135–200 行");
assert.equal(synopsis("functions.rg", {pattern: "roundIndex", paths: "src"}), "搜索 roundIndex");
assert.equal(synopsis("functions.glob", {pattern: "**/*.ts"}), "查找 **/*.ts");
assert.equal(synopsis("functions.bash", {command: "rtk bypass /sample/bin/bun test tests-ts --token synthetic-secret"}),
  "命令 bun test");
assert.equal(synopsis("functions.bash", {command: "TOKEN=synthetic-secret curl https://example.invalid?key=synthetic-secret"}), "执行命令");
assert.equal(synopsis("functions.bash", {command: "curl -H 'Authorization: Bearer synthetic-secret' https://example.invalid"}), "命令 curl");
assert(!synopsis("functions.rg", {pattern: "password=synthetic-secret"}).includes("synthetic-secret"));
assert(!synopsis("functions.view", {path: "https://example.invalid/a?key=synthetic-secret"}).includes("synthetic-secret"));
assert(!synopsis("functions.skill", {skill: "github_pat_synthetic-secret"}).includes("github_pat"));
assert(!synopsis("functions.skill", {skill: "https://example.invalid/value"}).includes("example.invalid"));
assert(!synopsis("functions.rg", {pattern: "AKIA" + "X".repeat(16)}).includes("AKIA"));
assert.equal(synopsis("functions.view", "{invalid"), "参数格式无法概述");
assert.equal(synopsis("functions.view", null), "参数未记录");
assert.equal(synopsis("functions.view", "x".repeat(65537)), "参数过长，展开查看");
assert.equal(synopsis("multi_tool_use.parallel", {tool_uses: [{recipient_name: "functions.view"}, {recipient_name: "functions.rg"}]}),
  "并行 functions.view、functions.rg · 共 2 个工具");
assert(Array.from(synopsis("functions.glob", {pattern: "目录/".repeat(30) + "*.ts"})).length <= 61);
context.summaryTool = {name: "functions.skill", arguments: '{"skill":"ponytail"}', status: "success"};
const titledTool = vm.runInContext("toolDetail(summaryTool)", context);
assert(titledTool.children[0].textContent.includes("functions.skill · 加载 ponytail"));
assert(!titledTool.children[0].textContent.includes("成功"));
context.summaryTool.status = "failed";
assert(vm.runInContext("toolDetail(summaryTool)", context).children[0].textContent.includes("失败"));
assert(!titledTool.open);
context.statTools = [
  ...Array.from({length:4}, (_, index) => ({id:"v"+index, name:"functions.view", arguments:JSON.stringify({path:"/sample/src/file"+index+".ts"}),
    status:index===3 ? "failed" : "success", truncated:false})),
  {id:"s1",name:"functions.skill",arguments:'{"skill":"ponytail"}',status:"success",truncated:false},
  {id:"s2",name:"functions.skill",arguments:'{"skill":"ponytail"}',status:"pending",truncated:false},
  {id:"b1",name:"functions.bash",arguments:'{"command":"bun test --token synthetic-secret"}',status:"success",truncated:false},
];
const statListing = vm.runInContext("roundToolStats(statTools)", context);
const statRows = descendants(statListing).filter(node => node.tag === "li");
assert.equal(statRows.length, 3, "Repeated calls must become tool-type or skill-name statistics, not individual cards");
assert.deepEqual(statRows.map(row => row.children[1].textContent), ["×4", "×2", "×1"]);
assert(!descendants(statListing).some(node => ["pre", "details", "summary"].includes(node.tag)));
const statsText = descendants(statListing).map(node => node.textContent).join(" ");
assert(statsText.includes("加载 ponytail") && statsText.includes("失败 1") && statsText.includes("结果尚未记录 1"));
assert(!statsText.includes("synthetic-secret") && !statsText.includes("成功") && !statsText.includes("file3.ts"),
  "Keep safe, bounded operation previews and exceptional states, not raw parameters or every path");
context.duplicateStats = [context.statTools[0], context.statTools[0]];
assert.throws(() => vm.runInContext("roundToolStats(duplicateStats)", context), /工具统计记录无效/);
context.incompleteStats = [{...context.statTools[0],truncated:true}];
assert.throws(() => vm.runInContext("roundToolStats(incompleteStats)", context), /工具统计记录无效/);
context.trendPoints = [
  {id: "1", model: "<script>synthetic</script>", created_at_display: "2024-02-29 12:00:00",
    input_tokens: "9007199254740993", output_tokens: "0", cache_read_tokens: "50", invalid_time: false},
  {id: "2", model: "synthetic", input_tokens: null, output_tokens: "20", cache_read_tokens: "60", invalid_time: false},
  {id: "3", model: "synthetic", input_tokens: "100", output_tokens: "40", cache_read_tokens: "70", invalid_time: false},
];
const chart = vm.runInContext("tokenChart(trendPoints)", context);
const chartNodes = descendants(chart);
assert.equal(chartNodes.filter(node => node.tag === "path").length, 3);
const inputPath = chartNodes.find(node => node.tag === "path" && node.attributes.class.includes("trend-input"));
assert.equal((inputPath.attributes.d.match(/M/g) || []).length, 2, "Missing token values must split the line instead of becoming zero");
const sample = chartNodes.find(node => node.attributes.class === "trend-point");
sample.events.focus();
assert(sample.attributes["aria-label"].includes("9,007,199,254,740,993"), "Exact values remain available in the chart's accessible label");
assert(sample.attributes["aria-label"].includes("<script>synthetic</script>"));
assert(!chartNodes.some(node => node.tag === "script"));
assert(!chartNodes.some(node => Object.values(node.attributes).some(value => /NaN|Infinity/.test(String(value)))));
assert.deepEqual(chartNodes.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent), ["1", "2", "3"]);
assert(!chartNodes.some(node => /本轮 Token 走势|调用顺序/.test(node.textContent)));
const legend = chart.querySelector(".trend-legend");
assert.deepEqual(legend?.children.map(node => node.textContent), ["输入", "输出", "缓存读取"]);
context.denseTrend = Array.from({length:55}, (_, index) => ({...context.trendPoints[0], id:String(index+1)}));
const denseChart = vm.runInContext("tokenChart(denseTrend)", context);
const denseNodes = descendants(denseChart);
assert.deepEqual(denseNodes.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent),
  Array.from({length:55}, (_, index) => String(index+1)));
assert(Number.parseFloat(denseChart.querySelector(".trend-scroll").querySelector("svg").style.minWidth) > 1280,
  "Every call must have a readable label; dense charts should scroll instead of overlapping or dropping labels");
assert(denseChart.querySelector(".trend-axis"), "Token labels must have a separate non-scrolling axis");
assert(!descendants(denseChart.querySelector(".trend-scroll")).some(node => node.textContent === "Token"));
assert(descendants(vm.runInContext("tokenChart([])", context)).some(node => node.textContent.includes("暂无调用")));
context.nullTrend = [{id: "1", input_tokens: null, output_tokens: null, cache_read_tokens: null, invalid_time: false}];
assert(descendants(vm.runInContext("tokenChart(nullTrend)", context)).some(node => node.textContent.includes("未记录")));
context.singleTrend = [{id: "1", model: "synthetic", input_tokens: "0", output_tokens: "-1", cache_read_tokens: null, invalid_time: true}];
const singleChart = descendants(vm.runInContext("tokenChart(singleTrend)", context));
assert.equal(singleChart.filter(node => node.tag === "circle").length, 2);
assert(singleChart.some(node => node.textContent.includes("时间异常")));
assert(!singleChart.some(node => Object.values(node.attributes).some(value => /NaN|Infinity/.test(String(value)))));
context.invalidTrend = [{input_tokens: 1.5, output_tokens: "0", cache_read_tokens: "0"}];
assert.throws(() => vm.runInContext("tokenChart(invalidTrend)", context), /有效整数/);

const metrics = {calls: "1", input_tokens: "100", output_tokens: "20", total_tokens: "120", cache_read_tokens: "80"};
context.data = {
  session: {id: "s", title: "<img src=x onerror=alert(1)>", summary: null},
  metrics, period: "2024-02-29", models: [{model: "actual", ...metrics}],
  diagnostics: {invalid_times: "0", orphan_requests: "0"},
  requests: [{id: "1", model: "actual", created_at: "invalid", invalid_time: true, ...metrics,
    input_tokens: "90071992547409931234567890", duration_ms: "0", time_to_first_token_ms: 4423.464167,
    turn_index: "0", agent_id: "<img src=x onerror=alert(1)>", initiator: "user", finish_reason: "tool_calls"}],
  turns: [{id: "8", turn_index: "2", timestamp: null, user_message: "<script>alert(1)</script>\n中文",
    assistant_response: "reply", truncated: true}],
  request_pagination: {page: "2", pages: "2", total: "51", size: "50"},
  turn_pagination: {page: "1", pages: "2", total: "21"},
};
vm.runInContext("renderSession(data)", context);
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
const rendered = descendants(elements.get("content"));
const links = rendered.filter(node => node.tag === "a");
const returnLink = links.find(node => node.textContent === "返回会话列表");
assert.equal(new URLSearchParams(returnLink.href.slice(2)).get("page"), "3");
assert.equal(new URLSearchParams(returnLink.href.slice(2)).get("day"), "29");
const all = new URLSearchParams(links.find(node => node.textContent === "查看该会话全部时间").href.slice(2));
assert(!all.has("year"));
assert.equal(all.get("list"), "year=2024&month=2&day=29&page=3");
const restore = new URLSearchParams(links.find(node => node.textContent === "恢复原日期范围").href.slice(2));
assert.equal(restore.get("day"), "29");
assert.equal(restore.get("month"), "2");
assert(!rendered.some(node => node.tag === "script" || node.tag === "img"));
assert(!rendered.some(node => node.tag === "pre" || node.textContent === "全会话已记录对话"),
  "Dialogue must be moved out of the main page into the request modal");
context.bigPage = {page: "90071992547409929", pages: "90071992547409930", total: "90071992547409930"};
const bigNav = vm.runInContext('pagination(bigPage, "requestPage")', context);
assert(bigNav.children.some(node => node.href && node.href.includes("requestPage=90071992547409930")));
let requestRow = rendered.find(node => node.tag === "tr" && node.attributes["aria-haspopup"] === "dialog");
assert(requestRow, "Each model request row must open a detail dialog");
assert.equal(requestRow.tabIndex, 0);
assert.equal(requestRow.children[0].children[0].textContent, "1");
assert.equal(requestRow.children[1].children[0].textContent, "1");
assert.equal(requestRow.attributes["aria-label"], "查看请求 1 的详情");
assert(rendered.some(node => node.tag === "th" && node.textContent === "序号"));
assert(!rendered.some(node => node.tag === "h2" && node.textContent === "按实际模型统计"));
context.dashboardData = {
  years: ["2024"], period: "全部时间", metrics, session_count: "22", diagnostics: context.data.diagnostics,
  sessions: [1, 2].map(id => ({id: String(id), title: "synthetic", project: "project", models: ["actual"], metrics})),
  pagination: {page: "2", pages: "2", size: "20", total: "22"},
};
elements.get("content").replaceChildren();
vm.runInContext("renderDashboard(dashboardData)", context);
const dashboardNodes = descendants(elements.get("content"));
const dashboardOverview = dashboardNodes.find(node => node.className === "dashboard-overview");
assert(dashboardOverview);
assert.equal(dashboardOverview.children[0].className, "dashboard-toolbar");
assert.equal(body.className, "dashboard-page");
assert.deepEqual(descendants(dashboardOverview).filter(node => node.className === "metric").map(node => node.textContent),
  ["输入 Token", "输出 Token", "缓存读取", "总 Token"]);
assert(descendants(dashboardOverview).some(node => node.tag === "form" && node.className === "date-filter"));
assert(!dashboardNodes.some(node => node.textContent.startsWith("全库诊断")));
const dashboardRows = descendants(elements.get("content")).find(node => node.tag === "tbody").children;
assert.deepEqual(dashboardRows.map(row => row.children[0].children[0].textContent), ["21", "22"]);
elements.get("content").replaceChildren();
vm.runInContext('renderDashboard({...dashboardData,sessions:[],diagnostics:{invalid_times:"1",orphan_requests:"0"}})', context);
assert(descendants(elements.get("content")).some(node => node.textContent.startsWith("全库诊断") && node.textContent.includes("1 条")));
assert(descendants(elements.get("content")).some(node => node.textContent === "此期间没有匹配会话。"));
context.numberingPage = {page: "9007199254740993", size: "50"};
const preciseTable = vm.runInContext('table(["ID"], [["real-id"]], undefined, numberingPage)', context);
assert.equal(preciseTable.tabIndex, 0);
assert.equal(preciseTable.attributes.role, "region");
assert.equal(preciseTable.attributes["aria-label"], "ID列表，可上下或左右滚动");
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
  {turn_index: "61", metrics: {...metrics, calls: "19", total_tokens: "90071992547409931234567890"},
    first_request_display: "2024-02-29 12:00:00", last_request_display: "2024-02-29 12:05:00", models: ["actual"],
    summary:"synthetic round 61 preview",summary_status:"recorded",invalid_time:false},
  {turn_index: null, metrics, models: ["actual"],summary:"未记录轮次，无法关联对话。",summary_status:"no_index",invalid_time:true},
  {turn_index: "0", metrics, models: ["actual"],summary:"本轮对话尚未记录。",summary_status:"missing",invalid_time:false},
], round_pagination: {page: "2", pages: "6", total: "53", size: "10"}};
context.groupedData.round_trend = [...context.groupedData.rounds].reverse();
elements.get("content").replaceChildren();
vm.runInContext('params.set("roundPage", "2"); renderSession(groupedData)', context);
const grouped = descendants(elements.get("content"));
const roundLink = grouped.find(node => node.tag === "a" && node.textContent === "第 61 轮");
assert(roundLink);
assert.equal(grouped.filter(node => node.tag === "a" && node.textContent === "第 61 轮").length, 1);
assert(!grouped.some(node => node.className === "request-row"), "Overview must group calls rather than open single-call dialogs");
assert.equal(body.className, "session-page");
const sessionInfo = grouped.find(node => node.className === "session-info");
assert.deepEqual(descendants(sessionInfo).filter(node => node.tag === "dt").map(node => node.textContent),
  ["工作目录", "会话 ID"]);
assert.deepEqual(descendants(sessionInfo).filter(node => node.className === "metric").map(node => node.textContent),
  ["输入 Token", "输出 Token", "缓存读取", "总 Token"]);
const sessionSummary = grouped.find(node => node.className === "session-summary");
assert(sessionSummary && !descendants(sessionInfo).includes(sessionSummary));
assert.equal(descendants(sessionSummary).find(node => node.tag === "h1").textContent, "未记录");
assert(!descendants(sessionSummary).some(node => node.tag === "button"));
assert(!descendants(sessionInfo).some(node => node.tag === "button"));
assert(!grouped.some(node => node.textContent === "返回会话列表"));
assert(!descendants(sessionInfo).some(node => node.tag === "a" || node.className === "session-actions"));
assert.equal(grouped.find(node => node.tag === "button" && node.textContent === "全会话记录").parent.parent.tag, "h2");
assert.deepEqual(grouped.filter(node => node.tag === "th").map(node => node.textContent),
  ["轮次","调用次数","总 Token","模型","对话摘要"]);
assert.equal(grouped.filter(node => node.attributes.class === "trend-point").length,2,
  "The overview chart must cover all known rounds without inventing an index for missing rounds");
assert.deepEqual(grouped.filter(node => node.attributes.class?.includes("trend-index")).map(node => node.textContent),["0","61"]);
const overviewPoint = grouped.find(node => node.attributes.class === "trend-point" && node.attributes["aria-label"].startsWith("第 61 轮"));
overviewPoint.events.focus();
assert(descendants(elements.get("content")).some(node => node.textContent === "synthetic round 61 preview"));
assert(descendants(elements.get("content")).some(node => node.textContent === "查看本轮详情"));
assert(!grouped.some(node => node.className === "round-conversation"));
assert(grouped.some(node => node.textContent === "90,071,992,547,409,931,234,567,890"));
assert(grouped.some(node => node.tag === "a" && node.textContent === "未记录轮次"));
assert(grouped.some(node => node.tag === "a" && node.textContent === "第 0 轮"));
const roundQuery = new URLSearchParams(roundLink.href.slice(2));
assert.equal(roundQuery.get("round"), "61");
assert.equal(roundQuery.get("roundPage"), "2");
assert.equal(roundQuery.get("day"), "29");
elements.get("content").replaceChildren();
vm.runInContext('renderSession({...groupedData, rounds:[], round_trend:[], round_pagination:{page:"1",pages:"1",total:"0",size:"10"}})', context);
const emptyOverview = descendants(elements.get("content"));
assert(emptyOverview.some(node => node.textContent === "当前范围暂无已记录序号的轮次走势。"));
assert(emptyOverview.some(node => node.textContent === "当前范围内暂无模型请求。"));
assert(emptyOverview.some(node => node.tag === "button" && node.textContent === "全会话记录"));
assert(!emptyOverview.some(node => node.attributes.class === "trend-point"));
context.selectedData = {...context.data, round: "61", token_trend: context.trendPoints,
  request_pagination:{...context.data.request_pagination,pages:"6",size:"10"}};
elements.get("content").replaceChildren();
vm.runInContext('params.set("round", "61"); params.set("requestPage", "2"); renderSession(selectedData)', context);
const selected = descendants(elements.get("content"));
assert(selected.some(node => node.tag === "h1" && node.textContent === "第 61 轮 · 模型调用"));
assert(!selected.some(node => node.className?.includes("metrics") || node.textContent === "返回轮次列表"),
  "Round page must omit top token totals and its back button");
assert(!selected.some(node => ["dl", "dt", "dd"].includes(node.tag)), "Round detail must omit session metadata");
assert.equal(body.className, "round-page");
assert(!selected.some(node => (node.tag === "button" && node.className !== "trend-detail-open")
  || /全库诊断|每行代表|点击任意|查看该会话全部时间|恢复原日期范围/.test(node.textContent)));
assert.deepEqual(selected.filter(node => node.tag === "th").map(node => node.textContent),
  ["序号", "模型", "输入", "输出", "总 Token", "缓存读取", "调用摘要"],
  "The round table should show call summaries and tokens, not IDs, timestamps or latency metrics");
assert(!selected.some(node => node.tag === "h3" && node.textContent.includes("请求")), "Chart hover titles must use call ordinals, not internal request IDs");
assert(!selected.some(node => node.tag === "h2" && /本轮.*用量|按实际模型统计/.test(node.textContent)));
assert(selected.some(node => node.className === "round-period" && node.textContent === " · " + context.selectedData.period),
  "Keep an actual filtered date scope visible");
context.allTimeRound = {...context.selectedData, period:"全部时间"};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(allTimeRound)", context);
assert(!descendants(elements.get("content")).some(node => node.className === "round-period" || node.textContent === " · 全部时间"),
  "The default all-time suffix must be removed from the round title");
context.warningRound = {...context.selectedData, diagnostics:{invalid_times:"1", orphan_requests:"0"}};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(warningRound)", context);
assert(descendants(elements.get("content")).some(node => node.textContent.includes("全库诊断") && node.textContent.includes("1 条")),
  "A minimal page must still surface real source anomalies");
context.singlePageRound = {...context.selectedData, request_pagination:{page:"1",pages:"1",size:"10",total:"1"}};
elements.get("content").replaceChildren();
vm.runInContext("renderSession(singlePageRound)", context);
assert(!descendants(elements.get("content")).some(node => node.attributes["aria-label"] === "请求分页"));
vm.runInContext('params.delete("round"); params.delete("requestPage"); params.delete("roundPage")', context);
elements.get("content").replaceChildren();
vm.runInContext("renderSession(data)", context);
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
  assert(descendants(liveChart).some(node => node.textContent.includes("正在整轮读取")));
  descendants(liveChart).filter(node => node.attributes.class === "trend-point")[1].events.pointerenter();
  detailAction.focus();
  await tick();
  assert.equal(tooltip.querySelector(".trend-detail-open"), detailAction, "Late summaries must preserve the focused action instead of recreating it");
  assert.equal(focused, detailAction);
  assert.equal(calls.length, 1);
  assert.equal(new URLSearchParams(calls[0].url.split("?")[1]).get("day"), "29");
  const text = () => descendants(liveChart).map(node => node.textContent).join(" ");
  const points = () => descendants(liveChart).filter(node => node.attributes.class === "trend-point");
  assert(text().includes("本次没有工具调用"), "A late batch must update the currently hovered call, not the initially selected one");
  points()[0].events.focus();
  assert(text().includes("加载 ponytail") && text().includes("×2（同摘要）"));
  assert(!/本次总 Token|相比上次|输入 |输出 |缓存读取|模型 |本次模型输出|共 3|Skill：|未发起 skill|总量仅|不重复计数/.test(descendants(tooltip).map(node => node.textContent).join(" ")),
    "Hover should show only the call identity, action and tool activity, without repeated metrics or explanations");
  assert.equal(descendants(tooltip).filter(node => node.tag === "li" && node.textContent.includes("加载 ponytail")).length, 1,
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
  assert(text().includes("本次没有工具调用") && !text().includes("加载 ponytail"));
  assert(!text().includes("本次总 Token") && !text().includes("相比上次"));
  points()[2].events.focus();
  assert(text().includes("无法唯一关联本次调用") && !text().includes("本次没有工具调用"));
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
  assert.equal(descendants(liveChart).filter(node => node.tag === "path").length, 3);
  assert.equal(calls.length, 1);
  failNext = true;
  const failedChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(failedChart);
  await tick();
  assert(descendants(failedChart).some(node => node.attributes.role === "alert" && node.textContent.includes("读取失败")));
  assert.equal(descendants(failedChart).filter(node => node.tag === "path").length, 3);
  descendants(failedChart).find(node => node.textContent === "重新读取摘要").events.click({preventDefault(){}});
  await tick();
  assert(descendants(failedChart).some(node => node.textContent.includes("加载 ponytail")));
  holdActivities = true;
  const staleChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(staleChart);
  holdActivities = false;
  const freshChart = vm.runInContext("tokenChart(trendPoints)", context);
  elements.get("content").replaceChildren(freshChart);
  await tick();
  heldActivities.shift()({ok:true, json:async()=>({calls:[], partial_tail:false})});
  await tick();
  assert(descendants(staleChart).some(node => node.textContent.includes("正在整轮读取")), "Detached charts must ignore late responses");
  assert(descendants(freshChart).some(node => node.textContent.includes("加载 ponytail")));
  context.mappingRound = {...context.selectedData, requests:[
    {...context.data.requests[0],id:"42"}, {...context.data.requests[0],id:"43"}],
    request_pagination:{page:"1",pages:"1",size:"10",total:"2"}};
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(mappingRound)", context);
  await tick();
  const roundPanel = elements.get("content").querySelector(".round-conversation");
  assert(roundPanel && descendants(roundPanel).some(node => node.tag === "pre" && node.textContent === dialogueText),
    "The side panel must show the complete uniquely matched round, not the paginated call's output");
  assert(descendants(roundPanel).filter(node => node.tag === "details").every(node => !node.open));
  assert(!calls.some(call => call.url.includes("/turns/8/tools?")), "Closed tool groups must not fetch full parameters or results");
  const roundTools = descendants(roundPanel).find(node => node.tag === "details" && node.children[0].textContent === "工具调用");
  roundTools.open = true;
  roundTools.events.toggle();
  await tick();
  assert.equal(descendants(roundTools).filter(node => node !== roundTools && node.tag === "details").length, 0);
  assert.equal(descendants(roundTools).filter(node => node.tag === "li").length, 1, "Statistics must merge repeated tools across pages");
  assert.equal(roundTools.children[0].textContent, "工具调用 · 2 次");
  assert(!descendants(roundTools).some(node => node.tag === "pre" || node.textContent.includes("z".repeat(100))));
  assert(!descendants(roundTools).some(node => node.textContent.includes("次数不等于 Token")));
  const toolReads = calls.filter(call => call.url.includes("/turns/8/tools?")).length;
  roundTools.events.toggle();
  await tick();
  assert.equal(calls.filter(call => call.url.includes("/turns/8/tools?")).length, toolReads, "Reopening tools must reuse the completed read");
  assert(!descendants(roundTools).some(node => node.tag === "summary" && node.textContent.includes("成功")));
  const mappedRows = descendants(elements.get("content")).filter(node => node.className === "request-row");
  mappedRows[1].events.click();
  await tick();
  assert(calls.at(-1).url.startsWith("/api/sessions/s/requests/43/call?"),
    "A summary row must retain its exact hidden request ID, even when model names repeat");
  body.children.find(node => node.tag === "dialog").close();
  for (const association of ["missing", "ambiguous", "no_index"]) {
    roundAssociation = association;
    const panel = vm.runInContext("roundConversation(trendPoints)", context);
    elements.get("content").replaceChildren(panel);
    await tick();
    assert(!descendants(panel).some(node => node.tag === "pre" || node.tag === "details"),
      "Unmatched rounds must never substitute a nearby conversation or show its tools");
    assert(descendants(panel).some(node => node.className === "notice"));
  }
  roundAssociation = "matched";
  failNext = true;
  const retryPanel = vm.runInContext("roundConversation(trendPoints)", context);
  elements.get("content").replaceChildren(retryPanel);
  await tick();
  assert(descendants(retryPanel).some(node => node.attributes.role === "alert"));
  descendants(retryPanel).find(node => node.textContent === "重试").events.click();
  await tick();
  const retryTools = descendants(retryPanel).find(node => node.tag === "details" && node.children[0].textContent === "工具调用");
  failTools = true;
  retryTools.open = true;
  retryTools.events.toggle();
  await tick();
  assert(descendants(retryTools).some(node => node.attributes.role === "alert"));
  descendants(retryTools).find(node => node.textContent === "重试").events.click();
  await tick();
  assert.equal(retryTools.children[0].textContent, "工具调用 · 2 次");
  assert.equal(descendants(retryTools).filter(node => node.tag === "li").length, 1);
  assert(!descendants(retryTools).some(node => node.attributes.role === "alert"));
  failNext = true;
  elements.get("content").replaceChildren();
  vm.runInContext("renderSession(selectedData)", context);
  await tick();
  assert(descendants(elements.get("content")).some(node => node.className === "call-summary" && node.textContent.includes("读取失败")),
    "The shared batch failure must remain explicit in list summaries");
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
  assert(fields.some(node => node.textContent === "本次完整输入上下文未记录"));
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
  descendants(dialog).find(node => node.textContent === "重试").events.click({preventDefault() {}});
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
  const second = descendants(elements.get("content")).find(node => node.tag === "tr" && node.attributes["aria-label"] === "查看请求 2 的详情");
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
  descendants(elements.get("content")).find(node => node.tag === "button" && node.textContent === "全会话记录").events.click();
  await tick();
  assert(currentDialog()?.open, "Sessions with no model requests must retain access to conversation records");
  assert(descendants(currentDialog()).filter(node => node.tag === "details").every(node => !node.open),
    "Whole-session turns and tools must start collapsed");
  assert(!descendants(currentDialog()).some(node => node.textContent.includes("耗时及首 Token")));
  const sessionCall = calls.findLast(call => call.url.startsWith("/api/sessions/s?"));
  assert(sessionCall);
  assert(!new URLSearchParams(sessionCall.url.split("?")[1]).has("view"));
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === dialogueText));
  assert(descendants(currentDialog()).some(node => node.tag === "pre" && node.textContent === "synthetic final reply"));
  descendants(currentDialog()).find(node => node.tag === "a" && node.textContent === "下一页").events.click({preventDefault() {}});
  await tick();
  assert(calls.some(call => call.url.startsWith("/api/sessions/s?") && new URLSearchParams(call.url.split("?")[1]).get("turnPage") === "2"));
  currentDialog().close();
  const viewAll = descendants(elements.get("content")).find(node => node.tag === "button" && node.textContent === "全会话记录");
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
  const chart = elements.get("content").querySelector(".token-chart"), panel = elements.get("content").querySelector(".round-conversation");
  const section = elements.get("content").querySelector(".round-call-section");
  panel.querySelector("details").open = true;
  const next = () => descendants(section).find(node => node.tag === "a" && node.textContent === "下一页");
  const click = event => next().events.click({preventDefault(){}, ...event});
  calls.length = 0;
  let modifiedPrevented = false;
  click({ctrlKey:true,preventDefault(){modifiedPrevented=true;}});
  assert(!modifiedPrevented && !calls.length, "Modified clicks must keep native new-tab navigation");
  click();
  await tick();
  assert.equal(calls.length, 1, "Paging should request only the list, not reload activities or conversation");
  assert(calls[0].url.includes("/rounds?"));
  assert.equal(elements.get("content").querySelector(".token-chart"), chart);
  assert.equal(elements.get("content").querySelector(".round-conversation"), panel);
  assert(panel.querySelector("details").open);
  assert.equal(vm.runInContext('params.get("requestPage")', context), "2");
  assert.equal(history.pushes.length, 0, "List pagination must never create a browser history entry");
  assert(history.url.includes("requestPage=2"));
  const row = descendants(section).find(node => node.className === "request-row");
  row.events.click();
  await tick();
  assert(calls.at(-1).url.includes("/requests/2/call?"), "New rows must keep exact request IDs after partial paging");
  body.children.find(node => node.tag === "dialog").close();
  const previousURL = history.url;
  failNext = true;
  click();
  await tick();
  assert.equal(history.url, previousURL, "Failed pagination must not advance the URL");
  assert.equal(descendants(section).find(node => node.className === "request-row"), row, "Keep existing rows on read failure");
  assert(descendants(section).some(node => node.attributes.role === "alert" && node.textContent.includes("翻页读取失败")));
  descendants(section).find(node => node.tag === "button" && node.textContent === "重试").events.click();
  await tick();
  assert.equal(vm.runInContext('params.get("requestPage")', context), "3");
  const previous = () => descendants(section).find(node => node.tag === "a" && node.textContent === "上一页");
  previous().events.click({preventDefault(){}});
  await tick();
  assert.equal(vm.runInContext('params.get("requestPage")', context), "2");
  assert.equal(elements.get("content").querySelector(".token-chart"), chart);
  deferNext = true;
  click();
  await tick();
  const signal = calls.at(-1).signal;
  previous().events.click({preventDefault(){}});
  await tick();
  assert(signal.aborted, "Changing page direction must cancel the older pending list read");
  assert.equal(vm.runInContext('params.get("requestPage")', context), "1");
  assert.equal(history.pushes.length, 0);
}
chartChecks().then(dialogChecks).then(paginationChecks).then(() => console.log("web checks passed: precise integers, descending request numbers, chart-only layout, hover-only call details, batch skills/tools, hover caching, fragment removal, safe text, modal dialogue, lazy body, paging, cancellation and original-period navigation"))
  .catch(error => { console.error(error); process.exitCode = 1; });
