import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveBinary, formula } from "../scripts/prepare_release";

describe("native Homebrew release", () => {
  test("selects one prebuilt archive without runtime or build dependencies", () => {
    const arm = "a".repeat(64);
    const intel = "b".repeat(64);
    const result = formula("0.2.0", arm, intel);
    expect(result).toContain("on_arm do");
    expect(result).toContain("on_intel do");
    expect(result).toContain("tokenflow-0.2.0-darwin-arm64.tar.gz");
    expect(result).toContain("tokenflow-0.2.0-darwin-x64.tar.gz");
    expect(result).toContain(`sha256 "${arm}"`);
    expect(result).toContain(`sha256 "${intel}"`);
    expect(result).toContain('bin.install "tokenflow"');
    expect(result.match(/depends_on/g)).toHaveLength(1);
    expect(result).not.toMatch(/depends_on "(?:python|node|bun|openssl)/);
    expect(result).not.toContain("pip");
    expect(result).not.toContain("venv");
    expect(result).not.toContain("brew install");
  });

  test("rejects invalid release metadata", () => {
    expect(() => formula("../latest", "a".repeat(64), "b".repeat(64))).toThrow();
    expect(() => formula("0.2.0", "not-a-checksum", "b".repeat(64))).toThrow();
  });

  test("archives identical executables reproducibly, with only the executable", () => {
    const directory = mkdtempSync(join(import.meta.dir, ".archive-"));
    try {
      const binary = join(directory, "tokenflow");
      const first = join(directory, "first.tar.gz");
      const second = join(directory, "second.tar.gz");
      writeFileSync(binary, "synthetic executable");
      const checksum = archiveBinary(binary, first);
      expect(archiveBinary(binary, second)).toBe(checksum);
      expect(readFileSync(first)).toEqual(readFileSync(second));
      const result = Bun.spawnSync(["/usr/bin/tar", "-tzf", first]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("tokenflow\n");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
});
