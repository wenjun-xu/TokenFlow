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
test("offline assets, safe text and stale-data UI contract", () => {
  for (const name of ["index.html", "tool-summary.js", "app.js", "style.css"]) {
    const copied = readFileSync(join(import.meta.dir, "../web", name), "utf8");
    if (name === "index.html") expect(createHash("sha256").update(copied).digest("hex"))
      .toBe("560a98b42a4387791759f4970260d31a6eee3f6a5a0f5cd1909f035e985093dc");
    expect(copied).not.toContain("https://");
    expect(copied.replaceAll("http://www.w3.org/2000/svg", "")).not.toContain("http://");
  }
  const html = readFileSync(join(import.meta.dir, "../web/index.html"), "utf8");
  const app = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
  expect(html).toContain('role="alert"'); expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('id="refresh"');
  expect(html).not.toContain("<footer");
  expect(html).not.toContain("<h1>TokenFlow");
  expect(html).not.toContain("本地 · 只读 · 无遥测");
  expect(app).not.toContain("innerHTML"); expect(app).not.toContain("eval(");
  expect(app).toContain("textContent"); expect(app).toContain("数据已过期");
  const css = readFileSync(join(import.meta.dir, "../web/style.css"), "utf8");
  expect(css).toMatch(/\.scroll \{[^}]*max-height: min\(32rem, 65dvh\)[^}]*overflow: auto/);
  expect(css).toMatch(/\.scroll th \{[^}]*position: sticky; top: 0;[^}]*background: var\(--raised\)/);
  expect(css).toMatch(/\.request-dialog \{[^}]*font: \.875rem\/1\.6 system-ui, sans-serif/);
  expect(css).toMatch(/\.request-dialog \{[^}]*box-sizing: border-box/);
  expect(css).toMatch(/\.request-dialog \{[^}]*max-height: min\(30rem, 65dvh\)/);
  expect(css).toMatch(/\.request-dialog \{[^}]*overflow-y: auto/);
  expect(css).toContain("prefers-color-scheme: light");
  expect(css).toContain("linear-gradient");
  expect(css).toMatch(/\.round-conversation \{[^}]*display: flex[^}]*overflow: hidden/);
  expect(css).toMatch(/\.round-conversation > div \{[^}]*overflow-y: auto/);
  expect(css).toMatch(/\.round-tool-stats \{[^}]*list-style: none/);
  expect(css).toMatch(/\.session-round-list \.call-summary \{[^}]*display: block[^}]*white-space: nowrap[^}]*overflow: hidden[^}]*text-overflow: ellipsis/);
});
test("browser tool summary is generated from the same canonical formatter used by the backend", async () => {
  const result = await Bun.build({entrypoints:[join(import.meta.dir, "../src/tool-summary.js")], target:"browser", minify:true});
  expect(result.success).toBe(true);
  expect(await result.outputs[0]!.text()).toBe(readFileSync(join(import.meta.dir, "../web/tool-summary.js"), "utf8"));
});
