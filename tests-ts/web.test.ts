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
      .toBe("0284abbe11b22ba7f3d9e3757465eaf57efff6631a7593c186ad7c3b9803ce8d");
    expect(copied).not.toContain("https://");
    expect(copied.replaceAll("http://www.w3.org/2000/svg", "")).not.toContain("http://");
  }
  const html = readFileSync(join(import.meta.dir, "../web/index.html"), "utf8");
  const app = readFileSync(join(import.meta.dir, "../web/app.js"), "utf8");
  expect(html).toContain('<html lang="en">');
  expect(html).toContain('role="alert"'); expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('id="refresh"');
  expect(html).not.toContain("<footer");
  expect(html).not.toContain("<h1>TokenFlow");
  expect(html).not.toContain("Local · Read-only · No telemetry");
  expect(app).not.toContain("innerHTML"); expect(app).not.toContain("eval(");
  expect(app).toContain("textContent"); expect(app).toContain("Data is stale");
  const css = readFileSync(join(import.meta.dir, "../web/style.css"), "utf8");
  expect(css).toMatch(/\.scroll \{[^}]*max-height: min\(32rem, 65dvh\)[^}]*overflow: auto/);
  expect(css).toMatch(/\.scroll th \{[^}]*position: sticky; top: 0;[^}]*background: var\(--raised\)/);
  expect(css).not.toContain(".table-sort");
  expect(css).not.toContain(".sort-caret");
  expect(css).toMatch(/\.request-dialog \{[^}]*font: \.875rem\/1\.6 system-ui, sans-serif/);
  expect(css).toMatch(/\.request-dialog \{[^}]*box-sizing: border-box/);
  expect(css).toMatch(/\.request-dialog \{[^}]*max-height: min\(30rem, 65dvh\)/);
  expect(css).toMatch(/\.request-dialog \{[^}]*overflow-y: auto/);
  expect(css).toMatch(/\.round-call-dialog \{ width: min\(72rem, calc\(100vw - 2rem\)\); \}/);
  expect(css).toMatch(/\.round-call-dialog \.round-call-list \{ height: min\(24rem, 40dvh\); \}/);
  expect(css).toMatch(/\.round-call-list \{[^}]*height: 24rem;[^}]*max-height: min\(24rem, 50dvh\)[^}]*overflow: auto/);
  expect(css).toMatch(/\.session-analysis \{[^}]*min-height: 0/);
  expect(css).toMatch(/#content \.round-call-list \{[^}]*flex: 0 1 24rem;[^}]*max-height: min\(24rem, 50dvh\)/);
  expect(css).not.toMatch(/\.session-analysis \.round-call-list \{[^}]*min-height: 24rem/);
  expect(css).toContain("prefers-color-scheme: light");
  expect(css).toMatch(/\.trend-plot \{[^}]*position: relative/);
  expect(css).toMatch(/\.trend-backdrop \{[^}]*position: absolute[^}]*left: 60px[^}]*width: calc\(100% - 60px\)[^}]*pointer-events: none/);
  expect(css).toMatch(/\.trend-scroll \{[^}]*position: relative/);
  expect(css).toMatch(/\.session-page \.trend-axis, \.session-page \.trend-scroll svg, \.session-page \.trend-backdrop \{ height: 14rem; \}/);
  expect(css).toContain("--background: #0b1018");
  expect(css).toContain("--panel: #121b27");
  expect(css).toContain("--accent: #62d9f5");
  expect(css).toMatch(/\.metric\[data-field="total_tokens"\] strong \{[^}]*color: var\(--accent\)/);
  expect(css).not.toContain(".metric:last-child strong");
  expect(css).toContain("grid-template-columns: minmax(0, 38fr) minmax(0, 62fr)");
  expect(css).toContain(".dashboard-page { color-scheme: light");
  expect(css).toContain(".dashboard-details .session-list table { min-width: 900px");
  expect(css).toContain('.pagination-controls a[aria-current="page"]');
  expect(css).toContain("@media (max-width: 1200px)");
  expect(css).toMatch(/\.round-page \.round-heading \{[^}]*display: flex[^}]*flex-wrap: wrap/);
  expect(css).toMatch(/\.round-page \.round-call-list :is\(th, td\):last-child \{[^}]*white-space: nowrap/);
  expect(css).toMatch(/\.session-round-list \.call-summary \{[^}]*display: block[^}]*white-space: nowrap[^}]*overflow: hidden[^}]*text-overflow: ellipsis/);
  expect(css).toMatch(/\.session-usage-scroll \{[^}]*overflow-x: auto[^}]*overflow-y: hidden/);
  expect(css).toMatch(/\.session-usage-axis \{[^}]*flex: 0 0 64px/);
  expect(css).not.toContain(".top-donut");
});
test("browser tool summary is generated from the same canonical formatter used by the backend", async () => {
  const result = await Bun.build({entrypoints:[join(import.meta.dir, "../src/tool-summary.js")], target:"browser", minify:true});
  expect(result.success).toBe(true);
  expect(await result.outputs[0]!.text()).toBe(readFileSync(join(import.meta.dir, "../web/tool-summary.js"), "utf8"));
});
