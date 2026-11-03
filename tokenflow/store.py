import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from .dates import Period, local_date, parse_time


class StoreError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


SESSION_FIELDS = ("id", "cwd", "repository", "host_type", "branch", "summary", "created_at", "updated_at")
USAGE_FIELDS = (
    "id", "session_id", "model", "input_tokens", "output_tokens", "cache_read_tokens",
    "created_at", "duration_ms", "time_to_first_token_ms", "turn_index", "agent_id",
    "initiator", "finish_reason",
)
TURN_FIELDS = ("id", "session_id", "turn_index", "timestamp", "user_message", "assistant_response")
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens")


def integer_strings(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return str(value)
    if isinstance(value, dict):
        return {key: integer_strings(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [integer_strings(item) for item in value]
    return value


class Metrics:
    def __init__(self):
        self.values = dict.fromkeys(TOKEN_FIELDS, 0)
        self.calls = 0

    def add(self, row):
        self.calls += 1
        for field in TOKEN_FIELDS:
            value = row[field]
            if value is not None and (type(value) is not int):
                raise StoreError("Token 字段不是整数，数据库结构或记录不兼容")
            if value is None:
                self.values[field] = None
            elif self.values[field] is not None:
                self.values[field] += value

    def result(self):
        incoming, outgoing = self.values["input_tokens"], self.values["output_tokens"]
        return {
            **self.values, "calls": self.calls,
            "total_tokens": incoming + outgoing if incoming is not None and outgoing is not None else None,
        }


def page_number(args, key):
    raw = args.get(key, "1")
    if not isinstance(raw, str) or not re.fullmatch(r"[0-9]{1,8}", raw) or int(raw) < 1:
        raise StoreError("页码必须是正整数", 400)
    return int(raw)


def paged(total, page, size):
    pages = max(1, (total + size - 1) // size)
    if page > pages:
        raise StoreError(f"页码超出范围，请返回第 1 页（共 {pages} 页）", 400)
    return {"page": page, "pages": pages, "total": total, "size": size}


class Store:
    """Synthetic tests may use this directly; production uses an isolated worker only."""

    def __init__(self, db, zone, timeout=12):
        self.db = Path(db)
        self.zone = zone
        self.timeout = timeout

    def dashboard(self, args):
        return self._read(None, args)

    def session(self, sid, args):
        return self._read(sid, args)

    def _read(self, sid, args):
        allowed = {"year", "month", "day", "page"} if sid is None else {
            "year", "month", "day", "requestPage", "turnPage", "expandedTurn",
        }
        if set(args) - allowed:
            raise StoreError("未知查询参数", 400)
        try:
            period = Period(args, self.zone)
        except ValueError as error:
            raise StoreError("日期条件无效：请选择有效的年、月、日", 400) from error
        deadline = time.monotonic() + self.timeout

        def check():
            if time.monotonic() >= deadline:
                raise StoreError("读取超时，请缩小范围后重试")

        connection = None
        try:
            connection = sqlite3.connect(self.db.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            connection.execute("PRAGMA temp_store=MEMORY")
            connection.execute("PRAGMA trusted_schema=OFF")
            connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
            connection.execute("BEGIN")
            versions = self._schema(connection)
            sessions = {}
            for record in connection.execute("SELECT " + ",".join(SESSION_FIELDS) + " FROM sessions"):
                check()
                row = dict(record)
                if not isinstance(row["id"], str) or not row["id"]:
                    raise StoreError("会话 ID 不兼容")
                if any(row[field] is not None and not isinstance(row[field], str) for field in SESSION_FIELDS):
                    raise StoreError("会话基础字段类型不兼容")
                sessions[row["id"]] = {
                    **row, "metrics_acc": Metrics(), "models_set": set(),
                    "latest_key": None, "latest_request": None,
                }
            if sid is not None and sid not in sessions:
                raise StoreError("会话不存在或已被删除，请返回会话列表", 404)
            total = Metrics()
            models = {}
            years = set()
            invalid = orphan = 0
            for row in connection.execute("SELECT " + ",".join(USAGE_FIELDS) + " FROM assistant_usage_events"):
                check()
                key = parse_time(row["created_at"])
                local = local_date(key, self.zone)
                if local is None:
                    invalid += 1
                    key = None
                else:
                    years.add(local.year)
                if row["session_id"] not in sessions:
                    orphan += 1
                    continue
                if not isinstance(row["model"], str) or not row["model"].strip():
                    raise StoreError("请求实际模型缺失或不兼容，请检查数据库结构")
                if type(row["id"]) is not int:
                    raise StoreError("请求 ID 类型不兼容")
                if any(row[field] is not None and not isinstance(row[field], str)
                       for field in ("session_id", "model", "created_at", "agent_id", "initiator", "finish_reason")):
                    raise StoreError("请求文本字段类型不兼容")
                if any(row[field] is not None and type(row[field]) is not int
                       for field in ("duration_ms", "time_to_first_token_ms", "turn_index")):
                    raise StoreError("请求性能指标或原始轮次序号不是整数")
                if not period.contains(key):
                    continue
                item = sessions[row["session_id"]]
                item["metrics_acc"].add(row)
                item["models_set"].add(row["model"])
                if key is not None and (item["latest_key"] is None or key > item["latest_key"]):
                    item["latest_key"] = key
                    item["latest_request"] = row["created_at"]
                if sid is None or row["session_id"] == sid:
                    total.add(row)
                if sid is not None and row["session_id"] == sid:
                    models.setdefault(row["model"], Metrics()).add(row)

            result = {
                "metrics": total.result(), "period": period.label, "timezone": str(self.zone),
                "years": sorted(years, reverse=True), "schema_versions": versions,
                "diagnostics": {"invalid_times": invalid, "orphan_requests": orphan},
                "diagnostics_scope": "全库（两项可能重叠；孤立请求不计入会话汇总）",
                "source": str(self.db), "read_at": datetime.now(timezone.utc).isoformat(),
            }
            if sid is None:
                rows = [
                    item for item in sessions.values()
                    if period.year is None or item["metrics_acc"].calls
                ]
                rows.sort(key=lambda item: item["id"])
                rows.sort(key=lambda item: (item["latest_key"] is not None, item["latest_key"] or (0, "")), reverse=True)
                check()
                page = page_number(args, "page")
                result["pagination"] = paged(len(rows), page, 20)
                result["session_count"] = len(rows)
                result["sessions"] = [self._session_row(item) for item in rows[(page - 1) * 20:page * 20]]
            else:
                result["session"] = self._session_row(sessions[sid])
                result["models"] = [{"model": model, **acc.result()} for model, acc in sorted(models.items())]
                self._detail(connection, sid, args, period, result, check)
            check()
            connection.rollback()
            return integer_strings(result)
        except sqlite3.Error as error:
            name = getattr(error, "sqlite_errorname", "")
            if "BUSY" in name or "LOCKED" in name:
                message = "数据库被锁定，读取超时；请稍后重试"
            elif "CORRUPT" in name or "NOTADB" in name:
                message = "数据库损坏或不是 SQLite 文件；请检查数据源"
            elif "CANTOPEN" in name or "READONLY" in name or "PERM" in name:
                message = "无法只读访问数据库或 WAL/SHM；请检查权限及上游 sidecar，工具不会创建或修复它们"
            elif "INTERRUPT" in name:
                message = "数据库读取超时，请稍后重试"
            else:
                message = "数据库读取失败或结构不兼容；请检查数据源"
            raise StoreError(message) from error
        finally:
            if connection is not None:
                connection.close()

    @staticmethod
    def _schema(connection):
        tables = {row["name"]: row["type"] for row in connection.execute(
            "SELECT name,type FROM sqlite_master WHERE name IN "
            "('sessions','assistant_usage_events','turns','schema_version')"
        )}
        for table, fields in (
            ("sessions", SESSION_FIELDS), ("assistant_usage_events", USAGE_FIELDS),
            ("turns", TURN_FIELDS), ("schema_version", ("version",)),
        ):
            if tables.get(table) != "table":
                raise StoreError(f"数据库结构不兼容：缺少普通表 {table}")
            columns = {row["name"]: row["type"].upper() for row in connection.execute(f"PRAGMA table_info({table})")}
            if not set(fields) <= columns.keys():
                raise StoreError(f"数据库结构不兼容：{table} 缺少必需字段")
            numeric = {"version", "id", "turn_index", "duration_ms", "time_to_first_token_ms", *TOKEN_FIELDS}
            for field in fields:
                expected_numeric = field in numeric and not (table == "sessions" and field == "id")
                declared = columns[field]
                if expected_numeric and "INT" not in declared:
                    raise StoreError(f"数据库结构不兼容：{table}.{field} 应为 INTEGER")
                if not expected_numeric and not any(part in declared for part in ("TEXT", "CHAR", "CLOB")):
                    raise StoreError(f"数据库结构不兼容：{table}.{field} 应为 TEXT")
        versions = [row[0] for row in connection.execute("SELECT version FROM schema_version")]
        if any(type(value) is not int for value in versions):
            raise StoreError("数据库版本字段不兼容")
        return versions

    @staticmethod
    def _session_row(item):
        result = {field: item[field] for field in SESSION_FIELDS}
        result.update(
            metrics=item["metrics_acc"].result(), models=sorted(item["models_set"]),
            latest_request=item["latest_request"],
            title=item["summary"] or (item["id"][:12] + ("…" if len(item["id"]) > 12 else "")),
            project=item["repository"] or (
                (Path(item["cwd"]).name or item["cwd"]) if item["cwd"] else "Unspecified"
            ),
        )
        return result

    def _detail(self, connection, sid, args, period, result, check):
        def seconds(value):
            key = parse_time(value)
            return key[0] if key is not None else None

        def fraction(value):
            key = parse_time(value)
            return key[1] if key is not None else ""

        connection.create_function("tf_seconds", 1, seconds, deterministic=True)
        connection.create_function("tf_fraction", 1, fraction, deterministic=True)
        connection.create_function("tf_period", 1, lambda value: int(period.contains(parse_time(value))), deterministic=True)
        page = page_number(args, "requestPage")
        result["request_pagination"] = paged(int(result["metrics"]["calls"]), page, 50)
        sql = (
            "SELECT " + ",".join(USAGE_FIELDS) + " FROM assistant_usage_events"
            " WHERE session_id=? AND tf_period(created_at)"
            " ORDER BY tf_seconds(created_at) IS NULL,tf_seconds(created_at),"
            "tf_fraction(created_at) COLLATE BINARY,id LIMIT 50 OFFSET ?"
        )
        result["requests"] = []
        for record in connection.execute(sql, (sid, (page - 1) * 50)):
            check()
            row = dict(record)
            acc = Metrics()
            acc.add(row)
            row["total_tokens"] = acc.result()["total_tokens"]
            row["invalid_time"] = parse_time(row["created_at"]) is None
            result["requests"].append(row)
        turn_page = page_number(args, "turnPage")
        count = connection.execute("SELECT count(*) FROM turns WHERE session_id=?", (sid,)).fetchone()[0]
        result["turn_pagination"] = paged(count, turn_page, 20)
        expanded = args.get("expandedTurn")
        if expanded is not None and (not isinstance(expanded, str) or not re.fullmatch(r"[0-9]{1,20}", expanded)):
            raise StoreError("展开轮次 ID 无效", 400)
        rows = list(connection.execute(
            "SELECT id,turn_index,timestamp,"
            "CASE WHEN CAST(id AS TEXT)=? THEN user_message ELSE substr(user_message,1,400) END AS user_message,"
            "CASE WHEN CAST(id AS TEXT)=? THEN assistant_response ELSE substr(assistant_response,1,400) END AS assistant_response,"
            "length(user_message)>400 OR length(assistant_response)>400 AS truncated"
            " FROM turns WHERE session_id=? ORDER BY turn_index,id LIMIT 20 OFFSET ?",
            (expanded, expanded, sid, (turn_page - 1) * 20),
        ))
        if expanded is not None and expanded not in {str(row["id"]) for row in rows}:
            raise StoreError("该轮次不在当前页或已被删除，请刷新", 404)
        result["turns"] = []
        for record in rows:
            check()
            row = dict(record)
            if type(row["id"]) is not int or type(row["turn_index"]) is not int:
                raise StoreError("对话轮次 ID 或序号类型不兼容")
            if any(row[field] is not None and not isinstance(row[field], str)
                   for field in ("timestamp", "user_message", "assistant_response")):
                raise StoreError("对话正文或时间字段类型不兼容")
            row["truncated"] = bool(row["truncated"]) and str(row["id"]) != expanded
            result["turns"].append(row)
