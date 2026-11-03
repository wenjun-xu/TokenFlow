import fcntl
import hmac
import json
import os
import secrets
import select
import socket
import stat
import subprocess
import threading
import time
from pathlib import Path

from .query import QueryRunner, command, validate_source
from .server import make_server
from .store import StoreError


DEFAULT_STATE = Path.home() / "Library/Application Support/TokenFlow"
DEFAULT_DB = Path.home() / ".copilot/session-store.db"


def state_directory(path=None, create=True):
    path = Path(path or DEFAULT_STATE).expanduser().absolute()
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise RuntimeError("状态目录及父目录不能是符号链接")
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.stat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError("TokenFlow 状态目录必须由当前用户拥有且权限为 0700")
    if len(os.fsencode(str(path / "c"))) >= 104:
        raise RuntimeError("TokenFlow 状态目录过长，无法创建私有控制 socket")
    return path


def _check_file(path, socket_file=False):
    if not path.exists() and not path.is_symlink():
        return
    metadata = path.lstat()
    expected = stat.S_ISSOCK if socket_file else stat.S_ISREG
    if (not expected(metadata.st_mode) or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600):
        raise RuntimeError("TokenFlow 状态文件权限或类型不安全；请检查自身状态目录")


def _open_private(path):
    _check_file(path)
    return os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)


def _lock(path):
    descriptor = _open_private(path / "lock")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor, True
    except BlockingIOError:
        return descriptor, False


def _read_state(path):
    filename = path / "state.json"
    _check_file(filename)
    try:
        with filename.open("rb") as stream:
            data = stream.read(8193)
        if len(data) > 8192:
            raise ValueError("state too large")
        info = json.loads(data)
        if (not isinstance(info, dict) or not isinstance(info.get("identity"), str)
                or not isinstance(info.get("token"), str) or not isinstance(info.get("db"), str)
                or type(info.get("port")) is not int or not 1 <= info["port"] <= 65535
                or not isinstance(info.get("file_identity"), list) or len(info["file_identity"]) != 2
                or any(type(value) is not int for value in info["file_identity"])):
            raise ValueError("invalid state")
        return info
    except (OSError, ValueError, UnicodeError) as error:
        raise RuntimeError("TokenFlow 状态不可用；若实例锁仍被占用，请勿按旧 PID 终止进程") from error


def _cleanup(path):
    for name in ("state.json", "c"):
        filename = path / name
        _check_file(filename, socket_file=name == "c")
        filename.unlink(missing_ok=True)


def _control(path, info, action):
    _check_file(path / "c", socket_file=True)
    try:
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(2)
            client.connect(str(path / "c"))
            client.sendall(json.dumps({"identity": info["identity"], "command": action}).encode() + b"\n")
            client.shutdown(socket.SHUT_WR)
            data = bytearray()
            while len(data) <= 8192:
                chunk = client.recv(4096)
                if not chunk:
                    break
                data.extend(chunk)
        response = json.loads(data)
        if not isinstance(response, dict) or response.get("identity") != info["identity"] or response.get("ok") is not True:
            raise ValueError("identity mismatch")
        return response
    except (OSError, ValueError, KeyError) as error:
        raise RuntimeError("实例锁已占用，但无法验证私有控制通道；未操作任何旧 PID，请稍后重试") from error


def _file_identity(path):
    metadata = path.stat()
    return [metadata.st_dev, metadata.st_ino]


def start(db=DEFAULT_DB, state=None):
    state = state_directory(state)
    db = validate_source(db, state)
    descriptor, acquired = _lock(state)
    process = None
    read_fd = write_fd = None
    try:
        if not acquired:
            deadline = time.monotonic() + 10
            last_error = None
            while time.monotonic() < deadline:
                try:
                    info = _read_state(state)
                    _control(state, info, "status")
                except RuntimeError as error:
                    last_error = error
                    time.sleep(0.1)
                    continue
                if info.get("db") != str(db) or info.get("file_identity") != _file_identity(db):
                    raise RuntimeError("已运行实例使用其他数据库或源文件已替换，请先执行 tokenflow stop")
                return info, True
            raise RuntimeError("实例尚未就绪或控制通道失效；未启动重复实例") from last_error
        _cleanup(state)
        log_fd = _open_private(state / "service.log")
        try:
            os.ftruncate(log_fd, 0)
            read_fd, write_fd = os.pipe()
            process = subprocess.Popen(
                command("_serve", str(db), str(state), str(descriptor), str(write_fd)),
                stdin=subprocess.DEVNULL, stdout=log_fd, stderr=log_fd,
                pass_fds=(descriptor, write_fd), start_new_session=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
        finally:
            os.close(log_fd)
            if write_fd is not None:
                os.close(write_fd)
                write_fd = None
        ready, _, _ = select.select([read_fd], [], [], 25)
        if not ready:
            raise RuntimeError("后台服务启动超时；请检查 macOS 隔离支持及数据源")
        raw = os.read(read_fd, 8192)
        try:
            response = json.loads(raw)
        except (ValueError, UnicodeError) as error:
            raise RuntimeError("后台服务启动失败；请检查安装及状态目录中的运行日志") from error
        if "error" in response:
            raise RuntimeError(response["error"])
        info = _read_state(state)
        _control(state, info, "status")
        # A listening HTTP socket, not only a live process, is required for readiness.
        with socket.create_connection(("127.0.0.1", info["port"]), timeout=2) as client:
            client.sendall(f"GET / HTTP/1.0\r\nHost: 127.0.0.1:{info['port']}\r\n\r\n".encode())
            if not client.recv(128).startswith(b"HTTP/1.0 200"):
                raise RuntimeError("后台 HTTP 服务未就绪")
        # Retain/reap our child without a live-Popen destructor warning. The
        # daemon waiter is not required for the detached service to survive.
        threading.Thread(target=process.wait, daemon=True).start()
        return info, False
    except (OSError, RuntimeError) as error:
        if process is not None:
            QueryRunner._terminate(process)
            _cleanup(state)
        if isinstance(error, OSError):
            raise RuntimeError("无法启动后台服务；请检查安装和状态目录权限") from error
        raise
    finally:
        if read_fd is not None:
            os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)
        # Closing, not LOCK_UN: child inherits this same open-file description.
        os.close(descriptor)


def stop(state=None):
    state = state_directory(state)
    descriptor, acquired = _lock(state)
    try:
        if acquired:
            _cleanup(state)
            return False
        info = _read_state(state)
        _control(state, info, "stop")
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                _cleanup(state)
                with socket.socket() as client:
                    client.settimeout(0.5)
                    if client.connect_ex(("127.0.0.1", info["port"])) == 0:
                        raise RuntimeError("实例锁已释放，但服务端口仍可访问；停止未确认")
                return True
            except BlockingIOError:
                time.sleep(0.05)
        raise RuntimeError("TokenFlow 停止超时；未按旧 PID 发送信号，请稍后重试")
    finally:
        os.close(descriptor)


def service_main(db, state_path, lock_fd, ready_fd):
    state = state_directory(state_path)
    runner = server = control = None
    published = False
    ready_fd = int(ready_fd)
    lock_fd = int(lock_fd)
    identity = secrets.token_urlsafe(32)
    try:
        runner = QueryRunner(db, state)
        runner.run("dashboard", {})
        token = secrets.token_urlsafe(32)
        server = make_server(runner, token)
        control = socket.socket(socket.AF_UNIX)
        control.bind(str(state / "c"))
        os.chmod(state / "c", 0o600)
        control.listen(4)
        control.settimeout(0.5)
        info = {
            "identity": identity, "db": str(runner.db),
            "file_identity": list(runner.file_identity),
            "port": server.server_port, "pid": os.getpid(), "token": token,
        }
        staging = state / "state.new"
        descriptor = _open_private(staging)
        try:
            os.ftruncate(descriptor, 0)
            os.write(descriptor, json.dumps(info).encode())
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _check_file(state / "state.json")
        os.replace(staging, state / "state.json")
        published = True
        stopping = threading.Event()

        def controller():
            while not stopping.is_set():
                try:
                    client, _ = control.accept()
                except socket.timeout:
                    continue
                except OSError:
                    return
                action = None
                with client:
                    client.settimeout(1)
                    try:
                        data = bytearray()
                        while len(data) <= 4096:
                            chunk = client.recv(1024)
                            if not chunk:
                                break
                            data.extend(chunk)
                        message = json.loads(data)
                        if not isinstance(message, dict):
                            continue
                        supplied = message.get("identity")
                        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, identity):
                            continue
                        action = message.get("command")
                        if action not in ("status", "stop"):
                            continue
                        client.sendall(json.dumps({"ok": True, "identity": identity, "busy": runner.busy}).encode())
                    except (OSError, ValueError, UnicodeError):
                        continue
                if action == "stop":
                    stopping.set()
                    runner.close()
                    server.shutdown()

        thread = threading.Thread(target=controller, daemon=True)
        thread.start()
        os.write(ready_fd, b'{"ok":true}')
        os.close(ready_fd)
        ready_fd = None
        server.serve_forever(poll_interval=0.1)
        stopping.set()
        thread.join(timeout=3)
        return 0
    except (RuntimeError, ValueError, OSError, StoreError) as error:
        if ready_fd is not None:
            os.write(ready_fd, json.dumps({"error": str(error)}).encode())
        return 1
    finally:
        if ready_fd is not None:
            os.close(ready_fd)
        if runner is not None:
            runner.close()
        if server is not None:
            server.server_close()
        if control is not None:
            control.close()
        if published:
            _cleanup(state)
        elif control is not None:
            (state / "c").unlink(missing_ok=True)
        os.close(lock_fd)
