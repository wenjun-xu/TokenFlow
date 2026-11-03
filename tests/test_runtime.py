import contextlib
import http.client
import io
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from zoneinfo import ZoneInfo

from support import Fixture
from tokenflow.cli import main
from tokenflow.lifecycle import _control, start, stop
from tokenflow.query import QueryRunner, IsolationError
from tokenflow.server import make_server
from tokenflow.store import StoreError


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.fixture.session()
        self.fixture.usage()
        self.state = self.fixture.root / "state"
        self.state.mkdir(mode=0o700)

    def tearDown(self):
        self.fixture.close()

    def test_fail_closed_without_sandbox(self):
        with patch("tokenflow.query.SANDBOX", "/nonexistent/sandbox-exec"):
            with self.assertRaises(IsolationError):
                QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_isolated_wal_read_and_missing_sidecars_never_created(self):
        self.fixture.connection.execute("PRAGMA journal_mode=WAL")
        self.fixture.usage()
        before = {p.name: p.read_bytes() for p in self.fixture.root.iterdir() if p.is_file()}
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))
        try:
            self.assertEqual(runner.run("dashboard", {})["metrics"]["calls"], "2")
            self.assertEqual(before, {p.name: p.read_bytes() for p in self.fixture.root.iterdir() if p.is_file()})
            self.fixture.connection.close()
            files = {p.name for p in self.fixture.root.iterdir()}
            with self.assertRaises(StoreError):
                runner.run("dashboard", {})
            self.assertEqual(files, {p.name for p in self.fixture.root.iterdir()})
        finally:
            runner.close()

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_upstream_removes_shm_only_read_or_explicit_failure_without_creation(self):
        self.fixture.connection.execute("PRAGMA journal_mode=WAL")
        self.fixture.usage()
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))
        try:
            Path(str(self.fixture.db) + "-shm").unlink()
            files = {path.name: path.read_bytes() for path in self.fixture.root.iterdir() if path.is_file()}
            try:
                result = runner.run("dashboard", {})
            except StoreError as error:
                self.assertIn("WAL/SHM", str(error))
            else:
                self.assertEqual(result["metrics"]["calls"], "2")
            self.assertEqual(files, {path.name: path.read_bytes() for path in self.fixture.root.iterdir() if path.is_file()})
        finally:
            runner.close()

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_http_security_and_bundled_ui(self):
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))
        server = make_server(runner, "secret-key")
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        try:
            def request(path, headers=None):
                return urllib.request.urlopen(urllib.request.Request(origin + path, headers=headers or {}), timeout=5)

            with request("/") as response:
                body = response.read().decode()
                self.assertIn("TokenFlow", body)
                self.assertNotIn("secret-key", body)
                self.assertIn("default-src 'none'", response.headers["Content-Security-Policy"])
            for headers in ({}, {"X-TokenFlow-Key": "wrong"},
                            {"X-TokenFlow-Key": "secret-key", "Origin": "https://evil.example"},
                            {"X-TokenFlow-Key": "secret-key", "Sec-Fetch-Site": "cross-site"},
                            {"X-TokenFlow-Key": "secret-key", "Host": "evil.example"}):
                with self.assertRaises(urllib.error.HTTPError) as context:
                    request("/api/dashboard", headers)
                self.assertEqual(context.exception.code, 403)
            with request("/api/dashboard", {"X-TokenFlow-Key": "secret-key"}) as response:
                self.assertEqual(json.load(response)["metrics"]["total_tokens"], "120")
                self.assertEqual(response.headers["Cache-Control"], "no-store")
            with self.assertRaises(urllib.error.HTTPError) as context:
                request("/api/stop", {"X-TokenFlow-Key": "secret-key"})
            self.assertEqual(context.exception.code, 404)
            for path, code in (("/api/dashboard?year=2024&month=2&day=30", 400),
                               ("/api/dashboard?year=2024&year=2025", 400),
                               ("/api/sessions/missing", 404), ("/../../source.db", 404)):
                with self.assertRaises(urllib.error.HTTPError) as context:
                    request(path, {"X-TokenFlow-Key": "secret-key"})
                self.assertEqual(context.exception.code, code)
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request("POST", "/api/stop", headers={"X-TokenFlow-Key": "secret-key"})
            response = connection.getresponse()
            self.assertEqual(response.status, 405)
            response.read()
            connection.close()
            js = (Path(__file__).parents[1] / "tokenflow/web/app.js").read_text()
            self.assertNotIn("innerHTML", js)
            self.assertIn("textContent", js)
            self.assertIn("sessionStorage", js)
        finally:
            runner.close()
            server.shutdown()
            server.server_close()
            thread.join(5)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_background_reuse_different_db_stop_and_stale_pid(self):
        info, reused = start(self.fixture.db, self.state)
        try:
            self.assertFalse(reused)
            same, reused = start(self.fixture.db, self.state)
            self.assertTrue(reused)
            self.assertEqual(info["identity"], same["identity"])
            alias = self.fixture.root / "source-alias"
            alias.symlink_to(self.fixture.db)
            self.assertTrue(start(alias, self.state)[1])
            with self.assertRaises(RuntimeError):
                _control(self.state, {**info, "identity": "forged"}, "stop")
            self.assertTrue(start(self.fixture.db, self.state)[1])
            other = self.fixture.root / "other.db"
            other.write_bytes(self.fixture.db.read_bytes())
            with self.assertRaises(RuntimeError):
                start(other, self.state)
            self.assertTrue(stop(self.state))
            self.assertFalse(stop(self.state))
            with socket.socket() as sock:
                sock.settimeout(1)
                self.assertNotEqual(sock.connect_ex(("127.0.0.1", info["port"])), 0)
            (self.state / "state.json").write_text(json.dumps({"pid": os.getpid()}))
            os.chmod(self.state / "state.json", 0o600)
            self.assertFalse(stop(self.state))
            os.kill(os.getpid(), 0)
        finally:
            stop(self.state)

    def test_cli_help_version(self):
        for arg in ("--help", "--version"):
            result = subprocess.run([sys.executable, "-m", "tokenflow", arg], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertIn("0.1.0" if arg == "--version" else "start", result.stdout)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_source_deleted_after_start_returns_explicit_error(self):
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))
        server = make_server(runner, "synthetic-key")
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            self.fixture.db.unlink()
            with self.assertRaisesRegex(StoreError, "源数据库"):
                runner.run("dashboard", {})
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/dashboard",
                headers={"X-TokenFlow-Key": "synthetic-key"},
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 503)
            self.assertIn("源数据库", json.load(context.exception)["error"])
        finally:
            runner.close()
            server.shutdown()
            server.server_close()
            thread.join(5)

    def test_browser_failure_keeps_success_and_prints_manual_url(self):
        info = {"port": 12345, "token": "synthetic-token"}
        output, error = io.StringIO(), io.StringIO()
        with patch("tokenflow.lifecycle.start", return_value=(info, False)), \
                patch("tokenflow.cli.subprocess.run", return_value=subprocess.CompletedProcess([], 1)), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            self.assertEqual(main(["start", "--db", str(self.fixture.db)]), 0)
        self.assertIn("#key=synthetic-token", output.getvalue())
        self.assertIn("服务仍在运行", error.getvalue())

    def test_state_security_missing_source_and_source_inside_state(self):
        missing = self.fixture.root / "missing.db"
        with self.assertRaises(ValueError):
            start(missing, self.state)
        self.assertFalse(missing.exists())
        inside = self.state / "source.db"
        inside.write_bytes(self.fixture.db.read_bytes())
        with self.assertRaises(ValueError):
            start(inside, self.state)
        alias = self.fixture.root / "state-link"
        alias.symlink_to(self.state, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            stop(alias)
        os.chmod(self.state, 0o755)
        try:
            with self.assertRaises(RuntimeError):
                stop(self.state)
        finally:
            os.chmod(self.state, 0o700)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_simultaneous_start_single_instance(self):
        try:
            with ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(start, self.fixture.db, self.state) for _ in range(2)]
                results = [future.result(timeout=30) for future in futures]
            self.assertEqual({result[0]["identity"] for result in results}, {results[0][0]["identity"]})
            self.assertEqual(sorted(result[1] for result in results), [False, True])
            for name in ("lock", "state.json", "service.log", "c"):
                self.assertEqual((self.state / name).stat().st_mode & 0o777, 0o600)
        finally:
            stop(self.state)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_service_survives_starting_interpreter_exit(self):
        script = (
            "import json;from tokenflow.lifecycle import start;"
            f"info,reused=start({str(self.fixture.db)!r},{str(self.state)!r});"
            "print(json.dumps(info))"
        )
        try:
            result = subprocess.run(
                [sys.executable, "-B", "-c", script], capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("ResourceWarning", result.stderr)
            info = json.loads(result.stdout)
            self.assertTrue(_control(self.state, info, "status")["ok"])
            request = urllib.request.Request(
                f"http://127.0.0.1:{info['port']}/api/dashboard",
                headers={"X-TokenFlow-Key": info["token"]},
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual(json.load(response)["metrics"]["total_tokens"], "120")
            self.assertTrue(stop(self.state))
        finally:
            stop(self.state)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_start_failure_cleans_owned_resources(self):
        self.fixture.connection.close()
        self.fixture.db.write_bytes(b"corrupt")
        with self.assertRaisesRegex(RuntimeError, "损坏"):
            start(self.fixture.db, self.state)
        self.assertFalse((self.state / "state.json").exists())
        self.assertFalse((self.state / "c").exists())
        self.assertFalse(stop(self.state))

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_private_stop_remains_responsive_during_http_query(self):
        self.fixture.connection.executemany(
            "INSERT INTO assistant_usage_events(session_id,model,input_tokens,output_tokens,cache_read_tokens,created_at)"
            " VALUES('s','actual-model',100,20,80,'2024-02-29T12:00:00Z')",
            [()] * 10000,
        )
        self.fixture.connection.commit()
        before = self.fixture.db.read_bytes()
        info, _ = start(self.fixture.db, self.state)
        outcomes = []

        def request():
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{info['port']}/api/dashboard",
                    headers={"X-TokenFlow-Key": info["token"]},
                )
                with urllib.request.urlopen(req, timeout=8) as response:
                    outcomes.append(response.status)
            except (OSError, http.client.HTTPException):
                outcomes.append("stopped")

        thread = threading.Thread(target=request)
        try:
            thread.start()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if _control(self.state, info, "status")["busy"]:
                    break
                time.sleep(0.005)
            else:
                self.fail("query never became active")
            started = time.monotonic()
            self.assertTrue(stop(self.state))
            self.assertLess(time.monotonic() - started, 3)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertTrue(outcomes)
            self.assertEqual(self.fixture.db.read_bytes(), before)
        finally:
            stop(self.state)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_timeout_and_cancel_post_sql_python_task_only_owned_children(self):
        script = (
            "import sqlite3,time;"
            f"c=sqlite3.connect({(self.fixture.db.as_uri() + '?mode=ro')!r},uri=True);"
            "c.execute('BEGIN');c.execute('SELECT count(*) FROM sessions').fetchone();"
            "time.sleep(30)"
        )
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"), timeout=0.3)
        try:
            with patch("tokenflow.query.command", return_value=[sys.executable, "-B", "-c", script]):
                started = time.monotonic()
                with self.assertRaisesRegex(StoreError, "完整读取任务超时"):
                    runner.run("dashboard", {})
                self.assertLess(time.monotonic() - started, 3)
                self.assertFalse(runner._children)
        finally:
            runner.close()
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"), timeout=20)
        errors = []

        def query():
            try:
                runner.run("dashboard", {})
            except StoreError as error:
                errors.append(error)

        try:
            with patch("tokenflow.query.command", return_value=[sys.executable, "-B", "-c", script]):
                thread = threading.Thread(target=query)
                thread.start()
                deadline = time.monotonic() + 3
                while not runner._children and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(runner._children)
                handles = list(runner._children)
                time.sleep(0.1)
                with self.assertRaisesRegex(StoreError, "繁忙"):
                    runner.run("dashboard", {})
                runner.close()
                thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertTrue(errors)
                self.assertTrue(all(child.poll() is not None for child in handles))
                self.fixture.connection.execute("BEGIN EXCLUSIVE")
                self.fixture.connection.rollback()
        finally:
            runner.close()

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_source_replacement_and_sidecar_symlink_fail(self):
        runner = QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))
        try:
            replacement = self.fixture.root / "replacement"
            replacement.write_bytes(self.fixture.db.read_bytes())
            replacement.replace(self.fixture.db)
            with self.assertRaisesRegex(StoreError, "替换"):
                runner.run("dashboard", {})
        finally:
            runner.close()
        sidecar = Path(str(self.fixture.db) + "-wal")
        sidecar.symlink_to(self.fixture.root / "not-a-wal")
        with self.assertRaisesRegex(ValueError, "sidecar"):
            QueryRunner(self.fixture.db, self.state, ZoneInfo("UTC"))

    def test_internal_query_without_isolation_refuses_source(self):
        source_before = self.fixture.db.read_bytes()
        result = subprocess.run(
            [sys.executable, "-B", "-m", "tokenflow", "_query"],
            input=json.dumps({"state": str(self.state), "db": str(self.fixture.db)}),
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 0)
        self.assertIn("拒绝打开源库", json.loads(result.stdout)["error"])
        self.assertEqual(self.fixture.db.read_bytes(), source_before)
        self.assertEqual(list(self.state.iterdir()), [])
