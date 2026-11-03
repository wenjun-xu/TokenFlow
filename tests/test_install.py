import shutil
import subprocess
import sys
import unittest
import venv
from pathlib import Path

from support import Fixture
from tokenflow import __version__
from tokenflow.lifecycle import stop


ROOT = Path(__file__).resolve().parents[1]


class InstalledEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture()
        self.prefix = self.fixture.root / "installed"
        venv.EnvBuilder(with_pip=False).create(self.prefix)
        self.python = self.prefix / "bin/python3"
        result = subprocess.run(
            [str(self.python), "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
            check=True, capture_output=True, text=True,
        )
        shutil.copytree(ROOT / "tokenflow", Path(result.stdout.strip()) / "tokenflow",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.entry = self.prefix / "bin/tokenflow"
        self.entry.write_text(
            f"#!{self.python}\nfrom tokenflow.cli import main\nraise SystemExit(main())\n",
            encoding="utf-8",
        )
        self.entry.chmod(0o755)
        self.cwd = self.fixture.root / "unrelated"
        self.cwd.mkdir()

    def tearDown(self):
        self.fixture.close()

    def test_installed_entry_and_resources_without_pip_or_working_directory(self):
        result = subprocess.run([str(self.entry), "--version"], cwd=self.cwd,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), __version__)
        code = (
            "from importlib.resources import files;import importlib.util;"
            "assert importlib.util.find_spec('pip') is None;"
            "assert files('tokenflow').joinpath('web','app.js').read_text();"
            "from tokenflow.store import Metrics;"
            "m=Metrics();m.add(dict(input_tokens=100,output_tokens=20,cache_read_tokens=80));"
            "assert m.result()['total_tokens']==120"
        )
        result = subprocess.run([str(self.python), "-B", "-c", code], cwd=self.cwd,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(sys.platform == "darwin", "requires macOS Seatbelt")
    def test_installed_detached_service_and_query_from_unrelated_directory(self):
        self.fixture.session()
        self.fixture.usage()
        state = self.fixture.root / "state"
        code = f"""
import json, urllib.request
from tokenflow.lifecycle import start, stop
info, reused = start({str(self.fixture.db)!r}, {str(state)!r})
try:
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(info["port"]) + "/api/dashboard",
        headers={{"X-TokenFlow-Key": info["token"]}},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        assert json.load(response)["metrics"]["total_tokens"] == "120"
    print("installed lifecycle passed")
finally:
    assert stop({str(state)!r})
"""
        try:
            result = subprocess.run(
                [str(self.python), "-B", "-c", code], cwd=self.cwd,
                capture_output=True, text=True, timeout=40,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("installed lifecycle passed", result.stdout)
        finally:
            if state.exists():
                stop(state)


if __name__ == "__main__":
    unittest.main()
