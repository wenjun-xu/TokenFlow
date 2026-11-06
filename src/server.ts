import index from "../web/index.html" with { type: "text" };
import app from "../web/app.js" with { type: "text" };
import style from "../web/style.css" with { type: "text" };
import summary from "../web/tool-summary.js" with { type: "text" };
import { timingSafeEqual } from "node:crypto";
import { StoreError } from "./store";
import type { QueryRunner } from "./query";

if (typeof index !== "string") throw new Error("Embedded HTML resource is unavailable");
const ASSETS = new Map<string, [string, string]>([["/", [index, "text/html; charset=utf-8"]], ["/app.js", [app, "text/javascript; charset=utf-8"]],
  ["/style.css", [style, "text/css; charset=utf-8"]], ["/tool-summary.js", [summary, "text/javascript; charset=utf-8"]]]);
const PAGE_PARAMS = new Set(["sid", "list", "year", "month", "day", "page", "requestPage", "turnPage", "expandedTurn", "round", "roundPage"]);
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function response(status: number, body: unknown, mime = "application/json; charset=utf-8"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: {
    "Content-Type": mime, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", "Content-Security-Policy": CSP,
  } });
}
export function sameSecret(supplied: string | null, expected: string): boolean {
  if (supplied === null) return false;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function makeServer(runner: QueryRunner, key: string) {
  return Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, idleTimeout: 4, maxRequestBodySize: 0,
    async fetch(req, server) {
      const origin = `http://127.0.0.1:${server.port}`, headers = req.headers;
      if (req.url.length > 8192 || [...headers].reduce((n, [k, v]) => n + k.length + v.length, 0) > 16384) return response(431, { error: "请求过长" });
      if (headers.get("host") !== origin.slice(7) || (headers.has("origin") && headers.get("origin") !== origin)
        || ![null, "same-origin", "none"].includes(headers.get("sec-fetch-site"))) return response(403, { error: "拒绝非本地或跨站请求" });
      if ((headers.get("content-length") ?? "0") !== "0" || headers.has("transfer-encoding")) return response(400, { error: "读取请求不能包含正文" });
      if (req.method !== "GET") return response(405, { error: "仅允许 GET 读取；停止服务请执行 tokenflow stop" });
      const url = new URL(req.url);
      const asset = ASSETS.get(url.pathname);
      if (asset) {
        if (url.pathname !== "/" && url.search) return response(400, { error: "静态资源不接受查询参数" });
        const names = [...url.searchParams.keys()];
        if (names.length > 12 || new Set(names).size !== names.length || names.some(name => !PAGE_PARAMS.has(name))) {
          return response(400, { error: "页面查询参数无效" });
        }
        return response(200, asset[0], asset[1]);
      }
      if (!url.pathname.startsWith("/api/")) return response(404, { error: "页面不存在" });
      if (!sameSecret(headers.get("x-tokenflow-key"), key)) return response(403, { error: "访问凭证缺失或失效，请重新执行 tokenflow start 并打开完整地址" });
      try {
        const args: Record<string, string> = {};
        if ([...url.searchParams].length > 12) return response(400, { error: "查询参数无效" });
        for (const [name, value] of url.searchParams) {
          if (Object.hasOwn(args, name)) return response(400, { error: "查询参数无效" });
          Object.defineProperty(args, name, { value, enumerable: true });
        }
        if (url.pathname === "/api/dashboard") return response(200, await runner.run("dashboard", args));
        const activityPath = /^\/api\/sessions\/([^/]+)\/rounds\/activities$/.exec(url.pathname);
        if (activityPath) {
          let sid;
          try { sid = decodeURIComponent(activityPath[1]); } catch { return response(400, { error: "会话 ID 无效" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "会话 ID 无效" });
          return response(200, await runner.run("activities", args, sid));
        }
        const roundsPath = /^\/api\/sessions\/([^/]+)\/rounds$/.exec(url.pathname);
        if (roundsPath) {
          let sid;
          try { sid = decodeURIComponent(roundsPath[1]); }
          catch { return response(400, { error: "会话 ID 无效" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "会话 ID 无效" });
          return response(200, await runner.run("rounds", args, sid));
        }
        const callPath = /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/call$/.exec(url.pathname);
        if (callPath) {
          let sid, id;
          try { sid = decodeURIComponent(callPath[1]); id = decodeURIComponent(callPath[2]); }
          catch { return response(400, { error: "会话或请求 ID 无效" }); }
          return response(200, await runner.run("call", args, sid, id));
        }
        const toolsPath = /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/tools$/.exec(url.pathname);
        if (toolsPath) {
          let sid, id;
          try { sid = decodeURIComponent(toolsPath[1]); id = decodeURIComponent(toolsPath[2]); }
          catch { return response(400, { error: "会话或轮次 ID 无效" }); }
          return response(200, await runner.run("tools", args, sid, id));
        }
        const requestPath = /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)$/.exec(url.pathname);
        if (requestPath) {
          let sid, id;
          try { sid = decodeURIComponent(requestPath[1]); id = decodeURIComponent(requestPath[2]); }
          catch { return response(400, { error: "会话或请求 ID 无效" }); }
          return response(200, await runner.run("request", args, sid, id));
        }
        if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
          let sid;
          try { sid = decodeURIComponent(url.pathname.slice("/api/sessions/".length)); }
          catch { return response(400, { error: "会话 ID 无效" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "会话 ID 无效" });
          return response(200, await runner.run("session", args, sid));
        }
        return response(404, { error: "接口不存在" });
      } catch (error) {
        if (error instanceof StoreError) return response(error.status, { error: error.message });
        console.error("HTTP_REQUEST_FAILED");
        return response(503, { error: "本地读取失败，请重新执行 tokenflow start" });
      }
    },
    error() { return response(400, { error: "HTTP 请求无效" }); },
  });
}
