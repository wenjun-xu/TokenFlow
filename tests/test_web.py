import shutil
import subprocess
import unittest
from pathlib import Path


class WebTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "optional Node executable needed for native JS behavior checks")
    def test_native_js_rendering_and_navigation(self):
        result = subprocess.run(
            [shutil.which("node"), str(Path(__file__).with_name("web_checks.js"))],
            capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("web checks passed", result.stdout)

    def test_offline_assets_and_plain_text_rendering_contract(self):
        root = Path(__file__).parents[1] / "tokenflow/web"
        html = (root / "index.html").read_text()
        js = (root / "app.js").read_text()
        css = (root / "style.css").read_text()
        for source in (html, js, css):
            self.assertNotIn("https://", source)
            self.assertNotIn("http://", source)
        self.assertNotIn("innerHTML", js)
        self.assertNotIn("eval(", js)
        self.assertIn('role="alert"', html)
        self.assertIn('aria-live="polite"', html)
        self.assertIn("textContent", js)
        self.assertIn("数据已过期", js)
