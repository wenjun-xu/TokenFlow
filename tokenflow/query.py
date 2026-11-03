import json
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
from pathlib import Path
from zoneinfo import ZoneInfo

from .dates import system_zone
from .store import Store, StoreError


SANDBOX = "/usr/bin/sandbox-exec"
PROFILE = "(version 1)(allow default)(deny file-write*)"


class IsolationError(RuntimeError):
    pass


def command(*args):
    if getattr(sys, "frozen", False):
        return [sys.executable, *args]
    return [sys.executable, "-B", "-m", "tokenflow", *args]


def validate_source(db, state):
    original = Path(db).expanduser().absolute()
    if original.is_symlink() and original.lstat().st_uid != os.getuid():
        raise ValueError("数据库符号链接必须由当前用户拥有")
    try:
        path = original.resolve(strict=True)
        metadata = path.stat()
    except OSError as error:
        raise ValueError("数据库不存在或无法访问；请使用 --db 指定已有数据库") from error
    if not path.is_file() or metadata.st_uid != os.getuid() or not metadata.st_mode & 0o444:
        raise ValueError("数据库必须是当前用户拥有的可读普通文件")
    if path.is_relative_to(Path(state).resolve()):
        raise ValueError("源数据库不能放在 TokenFlow 状态目录中")
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.is_symlink():
            raise ValueError("数据库 sidecar 不能是符号链接")
    return path


def verify_isolation(state):
    """Prove Seatbelt denies writes and can read a synthetic, active WAL."""
    if sys.platform != "darwin" or not Path(SANDBOX).is_file():
        raise IsolationError("需要 macOS sandbox-exec 文件隔离；当前平台不支持，已拒绝读取源库")
    # This fixture is ours, not a copy of the user's database.
    probe = state / "isolation-probe.db"
    forbidden = state / "isolation-forbidden"
    if any(Path(str(probe) + suffix).exists() or Path(str(probe) + suffix).is_symlink()
           for suffix in ("", "-wal", "-shm")) or forbidden.exists() or forbidden.is_symlink():
        raise IsolationError("隔离探针状态残留，请停止服务并移除自身状态目录中的 isolation-probe 文件后重试")
    connection = sqlite3.connect(probe)
    os.chmod(probe, 0o600)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE probe(n INTEGER)")
        connection.execute("INSERT INTO probe VALUES(7)")
        connection.commit()
        script = (
            "import pathlib,sqlite3,sys;"
            "p=pathlib.Path(sys.argv[1]);"
            "c=sqlite3.connect(p.as_uri()+'?mode=ro',uri=True);"
            "assert c.execute('SELECT n FROM probe').fetchone()==(7,);c.close();"
            "\ntry:\n pathlib.Path(sys.argv[2]).write_text('denied')"
            "\nexcept PermissionError:\n print('isolated')"
            "\nelse:\n raise SystemExit(2)"
        )
        try:
            result = subprocess.run(
                [SANDBOX, "-p", PROFILE, sys.executable, "-B", "-c", script, str(probe), str(forbidden)],
                capture_output=True, timeout=8, check=False,
            ) if not getattr(sys, "frozen", False) else subprocess.run(
                [SANDBOX, "-p", PROFILE, *command("_probe", str(probe), str(forbidden))],
                capture_output=True, timeout=8, check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise IsolationError("无法验证 macOS 文件隔离；已拒绝读取，请检查 sandbox-exec 支持") from error
        if result.returncode != 0 or result.stdout.strip() != b"isolated" or forbidden.exists():
            raise IsolationError("macOS 文件隔离或只读 WAL 探针失败；已拒绝读取源库，请检查 OS 支持")
    finally:
        connection.close()
        for suffix in ("", "-wal", "-shm"):
            Path(str(probe) + suffix).unlink(missing_ok=True)
        forbidden.unlink(missing_ok=True)


def probe_main(db, forbidden):
    try:
        descriptor = os.open(forbidden, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    except PermissionError:
        pass
    else:
        os.close(descriptor)
        Path(forbidden).unlink()
        return 2
    connection = sqlite3.connect(Path(db).as_uri() + "?mode=ro", uri=True)
    try:
        if connection.execute("SELECT n FROM probe").fetchone() != (7,):
            return 2
    finally:
        connection.close()
    print("isolated")
    return 0


class QueryRunner:
    def __init__(self, db, state, zone=None, timeout=15):
        self.db = validate_source(db, state)
        try:
            metadata = self.db.stat()
        except OSError as error:
            raise StoreError("源数据库已删除或不可访问，请检查数据源后重新启动") from error
        self.file_identity = (metadata.st_dev, metadata.st_ino)
        self.state = Path(state)
        self.zone = zone or system_zone()
        self.timeout = timeout
        self._slot = threading.Semaphore(1)
        self._lock = threading.Lock()
        self._children = set()
        self._closed = False
        verify_isolation(Path(state))

    @property
    def busy(self):
        with self._lock:
            return bool(self._children)

    def run(self, operation, args, sid=None):
        if not self._slot.acquire(timeout=0.25):
            raise StoreError("读取繁忙，请稍后重试")
        process = None
        try:
            try:
                metadata = self.db.stat()
            except OSError as error:
                raise StoreError("源数据库已删除或不可访问，请检查数据源后重新启动") from error
            if (metadata.st_dev, metadata.st_ino) != self.file_identity:
                raise StoreError("源数据库已替换，请停止后重新启动服务")
            request = json.dumps({
                "db": str(self.db), "zone": str(self.zone), "operation": operation,
                "args": args, "sid": sid, "timeout": max(0.01, self.timeout - 1), "state": str(self.state),
                "file_identity": self.file_identity,
            }).encode()
            with self._lock:
                if self._closed:
                    raise StoreError("服务正在停止，请执行 tokenflow start")
                try:
                    process = subprocess.Popen(
                        [SANDBOX, "-p", PROFILE, *command("_query")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                    )
                except OSError as error:
                    raise StoreError("无法启动隔离读取进程，请检查安装") from error
                self._children.add(process)
            try:
                output, _ = process.communicate(request, timeout=self.timeout)
            except subprocess.TimeoutExpired as error:
                self._terminate(process)
                raise StoreError("完整读取任务超时（含聚合及排序），请缩小范围后重试") from error
            if process.returncode != 0:
                raise StoreError("隔离读取进程失败或已取消，请检查 macOS 隔离支持后重试")
            try:
                response = json.loads(output)
            except (json.JSONDecodeError, UnicodeDecodeError) as error:
                raise StoreError("隔离读取进程返回无效结果") from error
            if "error" in response:
                raise StoreError(response["error"], response["status"])
            return response["data"]
        finally:
            if process is not None:
                with self._lock:
                    self._children.discard(process)
                if process.stdin:
                    process.stdin.close()
                if process.stdout:
                    process.stdout.close()
            self._slot.release()

    @staticmethod
    def _terminate(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)

    def close(self):
        with self._lock:
            self._closed = True
            for process in tuple(self._children):
                self._terminate(process)


def worker_main():
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise StoreError("查询参数过长", 400)
        request = json.loads(raw)
        # An internal command called directly must also fail closed before opening a source.
        from .lifecycle import state_directory
        state = state_directory(request["state"], create=False)
        probe = state / ("worker-probe-" + secrets.token_hex(12))
        try:
            descriptor = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        except PermissionError:
            pass
        else:
            os.close(descriptor)
            probe.unlink()
            raise StoreError("内部读取未受文件写入隔离保护，已拒绝打开源库")
        db = validate_source(request["db"], state)
        metadata = db.stat()
        if [metadata.st_dev, metadata.st_ino] != request["file_identity"]:
            raise StoreError("源数据库已替换，请停止后重新启动服务")
        name = request["zone"]
        zone = system_zone() if name.startswith("OS localtime") else ZoneInfo(name)
        store = Store(db, zone, request["timeout"])
        if request["operation"] == "dashboard":
            data = store.dashboard(request["args"])
        elif request["operation"] == "session":
            data = store.session(request["sid"], request["args"])
        else:
            raise StoreError("未知读取操作", 400)
        try:
            metadata = db.stat()
        except OSError as error:
            raise StoreError("读取期间源数据库已删除，请检查数据源") from error
        if [metadata.st_dev, metadata.st_ino] != request["file_identity"]:
            raise StoreError("读取期间源数据库已替换，请停止后重新启动服务")
        result = {"data": data}
    except StoreError as error:
        result = {"error": str(error), "status": error.status}
    except OSError:
        result = {"error": "源数据库或状态目录不可访问，请检查权限和数据源后重试", "status": 503}
    except (ValueError, KeyError, TypeError) as error:
        result = {"error": "查询参数或时区配置无效", "status": 400}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    return 0
