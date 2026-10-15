import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("starts the built CLI with isolated home and no credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-markdown-smoke-"));
  try {
    const result = spawnSync(process.execPath, [resolve("dist/cli.mjs"), "--help"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, FORGE_HOME: home, TERM: "dumb", NO_COLOR: "1" },
      encoding: "utf8", timeout: 10000, maxBuffer: 100000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Forge");
  } finally { await rm(home, { recursive: true, force: true }); }
});
