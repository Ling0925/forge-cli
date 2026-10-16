import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("bounds retained heap under repeated Ink measurement/wrapping with the installed patch", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-ink-memory-"));
  try {
    const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=256",
      resolve("tests/cli/fixtures/ink-memory.mjs")], {
      env: { PATH: "/usr/bin:/bin", HOME: home, FORGE_HOME: home, TERM: "dumb", NO_COLOR: "1" },
      encoding: "utf8", timeout: 30000, maxBuffer: 64000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.growth).toBeLessThan(16 * 1024 * 1024);
    expect(report.lateGrowth).toBeLessThan(8 * 1024 * 1024);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 35000);
