import hmac
import json
import logging
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import files
from urllib.parse import parse_qs, unquote, urlsplit

from .store import StoreError


ASSETS = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    "img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 16

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(4)
        return connection, address

    def handle_error(self, request, client_address):
        # No request URLs, headers, source records or credentials in logs.
        logging.error("HTTP_REQUEST_FAILED")


def make_server(runner, key):
    class Handler(BaseHTTPRequestHandler):
        server_version = "TokenFlow"
        sys_version = ""

        def log_message(self, format, *args):
            return

        def send_error(self, code, message=None, explain=None):
            self._send(code, {"error": "HTTP 请求无效或方法不支持"})

        def _send(self, status, value, content_type="application/json; charset=utf-8"):
            body = json.dumps(value, ensure_ascii=True).encode() if isinstance(value, dict) else value
            self.send_response(status)
            for name, value in (
                ("Content-Type", content_type), ("Content-Length", str(len(body))),
                ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                ("X-Frame-Options", "DENY"), ("Referrer-Policy", "no-referrer"),
                ("Content-Security-Policy", CSP), ("Connection", "close"),
            ):
                self.send_header(name, value)
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                pass
            self.close_connection = True

        def _safe(self):
            origin = f"http://127.0.0.1:{self.server.server_port}"
            if len(self.path) > 8192 or sum(len(k) + len(v) for k, v in self.headers.items()) > 16384:
                self._send(431, {"error": "请求过长"})
                return False
            host = self.headers.get_all("Host") or []
            origins = self.headers.get_all("Origin") or []
            if (host != [origin[7:]] or (origins and origins != [origin])
                    or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")):
                self._send(403, {"error": "拒绝非本地或跨站请求"})
                return False
            if self.headers.get("Content-Length", "0") != "0" or self.headers.get("Transfer-Encoding"):
                self._send(400, {"error": "读取请求不能包含正文"})
                return False
            return True

        def do_GET(self):
            if not self._safe():
                return
            try:
                target = urlsplit(self.path)
            except ValueError:
                self._send(400, {"error": "请求路径无效"})
                return
            if target.scheme or target.netloc or target.fragment:
                self._send(400, {"error": "请求路径无效"})
                return
            path = target.path
            if path in ASSETS:
                if target.query:
                    self._send(400, {"error": "静态资源不接受查询参数"})
                    return
                name, mime = ASSETS[path]
                self._send(200, files("tokenflow").joinpath("web", name).read_bytes(), mime)
                return
            if path.startswith("/api/"):
                supplied = self.headers.get_all("X-TokenFlow-Key") or []
                if len(supplied) != 1 or not hmac.compare_digest(supplied[0].encode(), key.encode()):
                    self._send(403, {"error": "访问凭证缺失或失效，请重新执行 tokenflow start 并打开完整地址"})
                    return
                try:
                    multi = parse_qs(target.query, keep_blank_values=True, max_num_fields=12)
                    if any(len(values) != 1 for values in multi.values()):
                        raise ValueError("duplicate")
                    args = {name: values[0] for name, values in multi.items()}
                    if path == "/api/dashboard":
                        result = runner.run("dashboard", args)
                    elif path.startswith("/api/sessions/") and path.count("/") == 3:
                        sid = unquote(path[len("/api/sessions/"):], errors="strict")
                        if not sid or len(sid) > 1024:
                            raise ValueError("session id")
                        result = runner.run("session", args, sid)
                    else:
                        self._send(404, {"error": "接口不存在"})
                        return
                    self._send(200, result)
                except (ValueError, UnicodeError):
                    self._send(400, {"error": "查询参数无效"})
                except StoreError as error:
                    self._send(error.status, {"error": str(error)})
                return
            self._send(404, {"error": "页面不存在"})

        def _reject(self):
            if self._safe():
                self._send(405, {"error": "仅允许 GET 读取；停止服务请执行 tokenflow stop"})

        do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = _reject

    return LocalServer(("127.0.0.1", 0), Handler)
