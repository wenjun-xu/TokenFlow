import hashlib
import importlib.util
import io
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import unittest
from pathlib import Path

from tokenflow import __version__


ROOT = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def test_metadata_and_bundled_assets(self):
        with (ROOT / "pyproject.toml").open("rb") as stream:
            project = tomllib.load(stream)
        self.assertEqual(project["project"]["version"], __version__)
        self.assertEqual(project["project"]["scripts"]["tokenflow"], "tokenflow.cli:main")
        self.assertEqual(project["project"].get("dependencies", []), [])
        self.assertIn("web/*.js", project["tool"]["setuptools"]["package-data"]["tokenflow"])

    def test_reproducible_archive_and_matching_formula(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            command = [sys.executable, "-B", str(ROOT / "scripts/prepare_release.py"),
                       "--output", str(output)]
            first = subprocess.run(command, cwd=temporary, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            archive = output / f"tokenflow-{__version__}.tar.gz"
            original = archive.read_bytes()
            second = subprocess.run(command, cwd=temporary, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(original, archive.read_bytes())
            checksum = hashlib.sha256(original).hexdigest()
            self.assertEqual((output / (archive.name + ".sha256")).read_text(),
                             f"{checksum}  {archive.name}\n")
            formula = (output / "homebrew-tap/Formula/tokenflow.rb").read_text()
            self.assertIn(f'sha256 "{checksum}"', formula)
            self.assertIn(f'https://github.com/wenjun-xu/TokenFlow/releases/download/v{__version__}/'
                          f'{archive.name}', formula)
            self.assertIn('depends_on "python@3.13"', formula)
            self.assertIn('"--without-pip"', formula)
            self.assertNotIn("PLACEHOLDER", formula)
            self.assertNotIn("PyInstaller", formula)
            with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as source:
                names = source.getnames()
                prefix = f"tokenflow-{__version__}/"
                for member in ("pyproject.toml", "README.md", "tokenflow/cli.py",
                               "tokenflow/web/app.js", "tokenflow/web/index.html",
                               "tokenflow/web/style.css"):
                    self.assertIn(prefix + member, names)
                self.assertTrue(all(name.startswith(prefix) for name in names))
                self.assertFalse(any(".joycode" in name or "state.json" in name
                                     or "__pycache__" in name or "需求文档" in name for name in names))

    def test_owner_and_repository_validation(self):
        path = ROOT / "scripts/prepare_release.py"
        spec = importlib.util.spec_from_file_location("prepare_release", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for owner, repository in (("../outside", "TokenFlow"), ("wenjun-xu", "../repo"),
                                  ("-invalid", "TokenFlow"), ("wenjun-xu", ".")):
            with self.subTest(owner=owner, repository=repository):
                with tempfile.TemporaryDirectory() as temporary:
                    with self.assertRaises(ValueError):
                        module.prepare(Path(temporary), owner, repository)


if __name__ == "__main__":
    unittest.main()
