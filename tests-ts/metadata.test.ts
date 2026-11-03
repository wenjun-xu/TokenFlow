import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/cli";

test("release metadata pins dev tooling and has no production dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
  expect(manifest.version).toBe(VERSION);
  expect(VERSION).toBe("0.2.1");
  expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  expect(manifest.devDependencies).toEqual({ "@types/bun": "1.4.4", typescript: "5.9.3" });
  expect(manifest.bin.tokenflow).toBe("./src/cli.ts");
  expect(readFileSync(join(import.meta.dir, "../bun.lock"), "utf8")).toContain("typescript");
});
