"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Minimal DOM records text/links; this is not a real-browser acceptance claim.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events[name] = callback; }
  querySelectorAll() { return []; }
}
const elements = new Map(["content", "status", "error", "refresh", "metadata"].map(id => [id, new Element("div")]));
const storage = new Map();
const location = {
  hash: "#key=synthetic-secret", pathname: "/",
  search: "?sid=s&year=2024&month=2&day=29&list=" + encodeURIComponent("year=2024&month=2&day=29&page=3"),
};
const history = {replaceState(_, __, url) { history.url = url; }};
const context = vm.createContext({
  document: {createElement: tag => new Element(tag), getElementById: id => elements.get(id)},
  Node: Element, URLSearchParams, location, history, AbortSignal,
  sessionStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)},
  fetch: () => new Promise(() => {}), window: {getSelection: () => ""},
});
const source = fs.readFileSync(path.join(__dirname, "../tokenflow/web/app.js"), "utf8");
vm.runInContext(source, context);
assert.equal(storage.get("tokenflow-key"), "synthetic-secret");
assert(!history.url.includes("#"));
assert.equal(vm.runInContext('integer("90071992547409931234567890")', context), "90,071,992,547,409,931,234,567,890");
assert.equal(vm.runInContext("integer(null)", context), "未知");
assert.equal(vm.runInContext('integer("0")', context), "0");

const metrics = {calls: "1", input_tokens: "100", output_tokens: "20", total_tokens: "120", cache_read_tokens: "80"};
context.data = {
  session: {id: "s", title: "<img src=x onerror=alert(1)>", summary: null},
  metrics, period: "2024-02-29", models: [{model: "actual", ...metrics}],
  diagnostics: {invalid_times: "0", orphan_requests: "0"},
  requests: [{id: "1", model: "actual", created_at: "invalid", invalid_time: true, ...metrics}],
  turns: [{id: "8", turn_index: "2", timestamp: null, user_message: "<script>alert(1)</script>\n中文",
    assistant_response: "reply", truncated: true}],
  request_pagination: {page: "1", pages: "1", total: "1"},
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
assert(rendered.some(node => node.tag === "pre" && node.textContent.includes("<script>")));
assert(!rendered.some(node => node.tag === "script" || node.tag === "img"));
assert(rendered.some(node => node.textContent === "全会话已记录对话"));
assert(rendered.some(node => node.textContent === "按需读取完整正文"));
context.bigPage = {page: "90071992547409929", pages: "90071992547409930", total: "90071992547409930"};
const bigNav = vm.runInContext('pagination(bigPage, "requestPage")', context);
assert(bigNav.children.some(node => node.href && node.href.includes("requestPage=90071992547409930")));
console.log("web checks passed: precise integers, fragment removal, safe text, lazy body, original-period navigation");
