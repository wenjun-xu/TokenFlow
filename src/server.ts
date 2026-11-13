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
const PAGE_PARAMS = new Set(["sid", "list", "date", "start", "end", "year", "month", "day", "page", "pageSize", "sort", "repository", "model", "requestPage", "turnPage", "expandedTurn", "round", "roundPage"]);
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
      if (req.url.length > 8192 || [...headers].reduce((n, [k, v]) => n + k.length + v.length, 0) > 16384) return response(431, { error: "Request is too long" });
      if (headers.get("host") !== origin.slice(7) || (headers.has("origin") && headers.get("origin") !== origin)
        || ![null, "same-origin", "none"].includes(headers.get("sec-fetch-site"))) return response(403, { error: "Non-local or cross-site requests are refused" });
      if ((headers.get("content-length") ?? "0") !== "0" || headers.has("transfer-encoding")) return response(400, { error: "Read requests cannot contain a body" });
      if (req.method !== "GET") return response(405, { error: "Only GET reads are allowed; run tokenflow stop to stop the service" });
      const url = new URL(req.url);
      const asset = ASSETS.get(url.pathname);
      if (asset) {
        if (url.pathname !== "/" && url.search) return response(400, { error: "Static assets do not accept query parameters" });
        const names = [...url.searchParams.keys()];
        if (names.length > 12 || new Set(names).size !== names.length || names.some(name => !PAGE_PARAMS.has(name))) {
          return response(400, { error: "Invalid page query parameters" });
        }
        return response(200, asset[0], asset[1]);
      }
      if (!url.pathname.startsWith("/api/")) return response(404, { error: "Page not found" });
      if (!sameSecret(headers.get("x-tokenflow-key"), key)) return response(403, { error: "The access key is missing or invalid; run tokenflow start again and open the complete URL" });
      try {
        const args: Record<string, string> = {};
        if ([...url.searchParams].length > 12) return response(400, { error: "Invalid query parameters" });
        for (const [name, value] of url.searchParams) {
          if (Object.hasOwn(args, name)) return response(400, { error: "Invalid query parameters" });
          Object.defineProperty(args, name, { value, enumerable: true });
        }
        if (url.pathname === "/api/dashboard") return response(200, await runner.run("dashboard", args));
        const activityPath = /^\/api\/sessions\/([^/]+)\/rounds\/activities$/.exec(url.pathname);
        if (activityPath) {
          let sid;
          try { sid = decodeURIComponent(activityPath[1]); } catch { return response(400, { error: "Invalid Session ID" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "Invalid Session ID" });
          return response(200, await runner.run("activities", args, sid));
        }
        const roundsPath = /^\/api\/sessions\/([^/]+)\/rounds$/.exec(url.pathname);
        if (roundsPath) {
          let sid;
          try { sid = decodeURIComponent(roundsPath[1]); }
          catch { return response(400, { error: "Invalid Session ID" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "Invalid Session ID" });
          return response(200, await runner.run("rounds", args, sid));
        }
        const callPath = /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)\/call$/.exec(url.pathname);
        if (callPath) {
          let sid, id;
          try { sid = decodeURIComponent(callPath[1]); id = decodeURIComponent(callPath[2]); }
          catch { return response(400, { error: "Invalid Session or request ID" }); }
          return response(200, await runner.run("call", args, sid, id));
        }
        const toolsPath = /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/tools$/.exec(url.pathname);
        if (toolsPath) {
          let sid, id;
          try { sid = decodeURIComponent(toolsPath[1]); id = decodeURIComponent(toolsPath[2]); }
          catch { return response(400, { error: "Invalid Session or Round ID" }); }
          return response(200, await runner.run("tools", args, sid, id));
        }
        const requestPath = /^\/api\/sessions\/([^/]+)\/requests\/([^/]+)$/.exec(url.pathname);
        if (requestPath) {
          let sid, id;
          try { sid = decodeURIComponent(requestPath[1]); id = decodeURIComponent(requestPath[2]); }
          catch { return response(400, { error: "Invalid Session or request ID" }); }
          return response(200, await runner.run("request", args, sid, id));
        }
        if (/^\/api\/sessions\/[^/]+$/.test(url.pathname)) {
          let sid;
          try { sid = decodeURIComponent(url.pathname.slice("/api/sessions/".length)); }
          catch { return response(400, { error: "Invalid Session ID" }); }
          if (!sid || sid.length > 1024) return response(400, { error: "Invalid Session ID" });
          return response(200, await runner.run("session", args, sid));
        }
        return response(404, { error: "Endpoint not found" });
      } catch (error) {
        if (error instanceof StoreError) return response(error.status, { error: error.message });
        console.error("HTTP_REQUEST_FAILED");
        return response(503, { error: "Local read failed; run tokenflow start again" });
      }
    },
    error() { return response(400, { error: "Invalid HTTP request" }); },
  });
}
