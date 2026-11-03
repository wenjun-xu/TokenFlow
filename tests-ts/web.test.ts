import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

test("original native JS rendering/navigation behavior checks", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "web_checks.cjs")], { stdout: "pipe", stderr: "pipe" });
  const text = await new Response(p.stdout).text();
  const errors = await new Response(p.stderr).text();
  expect(await p.exited, errors).toBe(0);
  expect(text).toContain("web checks passed");
});
test("offline verbatim assets, safe text and stale-data UI contract", () => {
  const originalHashes: Record<string, string> = {
    "index.html": "03d1c9de125b737900070361b8b9d0026f28d71a5be0512eecd1c28e04dcbda6",
    "app.js": "09a147b8ac95a7b650046af392b7205244f76e850f2ee8f86d20d60a9b710cea",
    "style.css": "137564e4634871e1e5b9f2511a74c54bb2cfa80652c4bfc7b32c6080c3e1328f",
  };
  for (const name of ["index.html", "app.js", "style.css"]) {
    const copied = readFileSync(join(import.meta.dir, "../web", name), "utf8");
    expect(createHash("sha256").update(copied).digest("hex")).toBe(originalHashes[name]);
    expect(copied).not.toContain("https://");
    expect(copied).not.toContain("http://");
  }
  const html = readFileSync(join(import.meta.dir, "../web/index.html"), "utf8");
  const app = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
  expect(html).toContain('role="alert"'); expect(html).toContain('aria-live="polite"');
  expect(app).not.toContain("innerHTML"); expect(app).not.toContain("eval(");
  expect(app).toContain("textContent"); expect(app).toContain("数据已过期");
});
