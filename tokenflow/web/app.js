"use strict";

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
const status = document.getElementById("status");
const errorBox = document.getElementById("error");
let lastRead = null;
let loading = false;

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
function metricCards(metrics, count) {
  const cards = node("section", undefined, "metrics");
  const fields = [["calls", "模型调用次数"], ["input_tokens", "输入 Token"], ["output_tokens", "输出 Token"],
    ["total_tokens", "总 Token"], ["cache_read_tokens", "缓存读取"]];
  if (count !== undefined) fields.unshift(["session_count", "会话数"]);
  for (const [field, label] of fields) {
    const card = node("div", label, "metric");
    card.append(node("strong", integer(field === "session_count" ? count : metrics[field])));
    cards.append(card);
  }
  return cards;
}
function table(headers, rows) {
  const wrapper = node("div", undefined, "scroll");
  const element = node("table");
  const head = node("thead");
  const heading = node("tr");
  for (const title of headers) {
    const cell = node("th", title);
    cell.scope = "col";
    heading.append(cell);
  }
  head.append(heading);
  element.append(head);
  const body = node("tbody");
  for (const row of rows) {
    const tr = node("tr");
    for (const value of row) {
      const td = node("td");
      td.append(value instanceof Node ? value : node("span", value));
      tr.append(td);
    }
    body.append(tr);
  }
  element.append(body);
  wrapper.append(element);
  return wrapper;
}
function pagination(data, field) {
  const nav = node("nav");
  nav.setAttribute("aria-label", field === "page" ? "会话分页" : field === "requestPage" ? "请求分页" : "轮次分页");
  nav.append(node("span", `共 ${integer(data.total)} 条，第 ${integer(data.page)} / ${integer(data.pages)} 页`));
  const current = BigInt(data.page);
  for (const [label, target] of [["上一页", current - 1n], ["下一页", current + 1n]]) {
    if (target >= 1n && target <= BigInt(data.pages)) {
      const next = new URLSearchParams(params);
      next.set(field, target.toString());
      next.delete("expandedTurn");
      nav.append(link(label, next));
    }
  }
  return nav;
}
function diagnostics(data) {
  const box = node("p", `全库诊断：无法参与日期筛选的请求 ${integer(data.diagnostics.invalid_times)} 条；`
    + `孤立请求 ${integer(data.diagnostics.orphan_requests)} 条（不纳入会话汇总）。两项可能重叠。`, "notice");
  return box;
}
function dateForm(years) {
  const form = node("form");
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
  form.append(submit, link("重置", new URLSearchParams()));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const query = new URLSearchParams();
    for (const field of [year, month, day]) if (!field.disabled && field.value) query.set(field.name, field.value);
    location.search = query.toString();
  });
  return form;
}
function renderDashboard(data) {
  content.append(dateForm(data.years), node("h2", "当前统计范围：" + data.period),
    metricCards(data.metrics, data.session_count), diagnostics(data));
  if (data.sessions.length === 0) {
    content.append(node("p", "此期间没有匹配会话。"), link("重置日期条件", new URLSearchParams()));
  } else {
    const rows = data.sessions.map(session => {
      const query = new URLSearchParams();
      query.set("sid", session.id);
      query.set("list", params.toString());
      for (const field of ["year", "month", "day"]) if (params.get(field)) query.set(field, params.get(field));
      return [
        link(session.title, query), session.project, recorded(session.created_at), session.latest_request || "—",
        session.models.join("\n") || "—", integer(session.metrics.calls), integer(session.metrics.input_tokens),
        integer(session.metrics.output_tokens), integer(session.metrics.total_tokens), integer(session.metrics.cache_read_tokens),
      ];
    });
    const listing = table(["会话摘要", "项目", "创建时间", "范围内最近请求", "实际模型", "调用次数",
      "输入", "输出", "总 Token", "缓存读取"], rows);
    for (const row of listing.querySelectorAll("tbody tr")) {
      row.addEventListener("click", event => {
        if (!event.target.closest("a") && !window.getSelection().toString()) row.querySelector("a").click();
      });
    }
    content.append(listing);
  }
  content.append(pagination(data.pagination, "page"));
}
function renderSession(data) {
  const original = new URLSearchParams(params.get("list") || "");
  const navigation = node("nav");
  navigation.append(link("返回会话列表", original));
  const all = new URLSearchParams(params);
  for (const field of ["year", "month", "day", "requestPage", "expandedTurn"]) all.delete(field);
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
    ["created_at", "创建时间"], ["updated_at", "更新时间（数据库原值）"]]) {
    definition.append(node("dt", title), node("dd", recorded(data.session[key])));
  }
  content.append(definition, node("h2", (params.get("year") ? "当前期间用量：" : "全部时间用量：") + data.period),
    metricCards(data.metrics), diagnostics(data), node("h2", "按实际模型统计"));
  content.append(table(["模型", "调用次数", "输入", "输出", "总 Token", "缓存读取"], data.models.map(model =>
    [model.model, ...["calls", "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens"].map(k => integer(model[k]))])));
  content.append(node("h2", "模型请求明细"),
    node("p", "原始轮次序号仅是源数据，不代表已验证对话归属。耗时及首 Token 延迟单位为毫秒。", "muted"));
  if (data.requests.length === 0) content.append(node("p", "当前范围内暂无模型请求。"));
  else content.append(table(["ID", "发生时间", "实际模型", "输入", "输出", "总 Token", "缓存读取",
    "耗时 ms", "首 Token ms", "原始轮次序号", "Agent", "发起方", "结束原因"], data.requests.map(request => [
    request.id, recorded(request.created_at) + (request.invalid_time ? "（时间异常）" : ""), request.model,
    ...["input_tokens", "output_tokens", "total_tokens", "cache_read_tokens"].map(k => integer(request[k])),
    ...["duration_ms", "time_to_first_token_ms", "turn_index", "agent_id", "initiator", "finish_reason"].map(k => recorded(request[k])),
  ])));
  content.append(pagination(data.request_pagination, "requestPage"),
    node("h2", "全会话已记录对话"),
    node("p", "此区域不受用量日期条件过滤；数据库记录可能不完整，不推测每轮 Token。", "notice"));
  if (data.turns.length === 0) content.append(node("p", "数据库中暂无对话记录"));
  for (const turn of data.turns) {
    const article = node("article");
    article.append(node("h3", `轮次 ${recorded(turn.turn_index)} · ${recorded(turn.timestamp)}`));
    const expanded = params.get("expandedTurn") === turn.id;
    const details = node("details");
    details.open = expanded;
    details.append(node("summary", "用户消息与助手回复（展开查看）"));
    details.append(node("h4", "用户消息"), node("pre", recorded(turn.user_message)),
      node("h4", "助手回复"), node("pre", recorded(turn.assistant_response)));
    if (turn.truncated) {
      details.append(node("p", "以上仅为预览。"));
      details.append(button("按需读取完整正文", () => {
        params.set("expandedTurn", turn.id);
        history.replaceState(null, "", "/?" + params.toString());
        load();
      }));
    }
    article.append(details);
    content.append(article);
  }
  content.append(pagination(data.turn_pagination, "turnPage"));
}
async function load() {
  if (loading) return;
  loading = true;
  status.textContent = "正在读取…";
  content.setAttribute("aria-busy", "true");
  errorBox.hidden = true;
  document.getElementById("refresh").disabled = true;
  try {
    if (initializationError) throw new Error(initializationError);
    const key = sessionStorage.getItem("tokenflow-key");
    if (!key) throw new Error("缺少访问凭证，请重新执行 tokenflow start 并打开输出的完整地址。");
    const query = new URLSearchParams();
    const sid = params.get("sid");
    const fields = sid ? ["year", "month", "day", "requestPage", "turnPage", "expandedTurn"] : ["year", "month", "day", "page"];
    for (const field of fields) if (params.has(field)) query.set(field, params.get(field));
    const path = sid ? "/api/sessions/" + encodeURIComponent(sid) : "/api/dashboard";
    const response = await fetch(path + "?" + query, {
      headers: {"X-TokenFlow-Key": key}, cache: "no-store", credentials: "omit",
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "读取失败");
    content.replaceChildren();
    lastRead = data.read_at;
    document.getElementById("metadata").textContent =
      `数据源：${data.source} · OS 本地时区：${data.timezone}（修改后需重启） · 最近成功读取：${lastRead}`;
    if (sid) renderSession(data); else renderDashboard(data);
    status.textContent = "读取完成";
  } catch (error) {
    errorBox.hidden = false;
    errorBox.textContent = `${lastRead ? "数据已过期（最近成功读取：" + lastRead + "）。" : ""}`
      + `${error.message} 如服务不可用，请执行 tokenflow start。`;
    status.textContent = "读取失败";
    if (!content.childNodes.length) {
      content.append(link("返回会话列表", new URLSearchParams(params.get("list") || "")),
        link("重置并返回全部时间", new URLSearchParams()));
    }
  } finally {
    loading = false;
    document.getElementById("refresh").disabled = false;
    content.setAttribute("aria-busy", "false");
  }
}
document.getElementById("refresh").addEventListener("click", load);
load();
