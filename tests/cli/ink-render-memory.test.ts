import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("keeps the built CLI bootstrap separate from the React/Ink bundle", async () => {
  expect(await readFile("dist/cli.mjs", "utf8")).toBe(await readFile("src/cli/bootstrap.mjs", "utf8"));
  expect(await readFile("dist/cli-main.mjs", "utf8")).toContain("forgeCreateRequire");
});

it.each([undefined, "development"])("bounds retained heap during full Ink repaints with inherited NODE_ENV=%s", async nodeEnv => {
  const home = await mkdtemp(join(tmpdir(), "forge-ink-render-memory-"));
  try {
    // Reuse the executable's exact startup boundary with a synthetic main module.
    // React/Ink remain external, as in build-core, and resolve to the installed
    // packages (including the Ink patch), not bundled development substitutes.
    const runtimeRequire = createRequire(import.meta.url);
    await copyFile("src/cli/bootstrap.mjs", join(home, "cli.mjs"));
    await build({
      entryPoints: [resolve("tests/cli/fixtures/ink-render-memory.ts")],
      outfile: join(home, "cli-main.mjs"),
      bundle: true, platform: "node", target: "node22", format: "esm", logLevel: "silent",
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      plugins: [{ name: "installed-runtime", setup(builder) {
        builder.onResolve({ filter: /^(ink|react)(\/|$)/ }, args => ({
          path: pathToFileURL(runtimeRequire.resolve(args.path)).href, external: true,
        }));
      } }],
    });
    const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=256", join(home, "cli.mjs")], {
      env: { PATH: "/usr/bin:/bin", HOME: home, FORGE_HOME: home, TERM: "xterm-256color", NO_COLOR: "1",
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) },
      encoding: "utf8", timeout: 45000, maxBuffer: 64000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.nodeEnv).toBe("production");
    expect(report.frames).toBe(2200);
    expect(report.growth).toBeLessThan(16 * 1024 * 1024);
    expect(report.lateGrowth).toBeLessThan(8 * 1024 * 1024);
    expect(report.measuresBefore).toBe(1);
    expect(report.measuresAfter).toBe(1);
    // Prevent a future fix from silently clearing all application measurements.
    expect(report.unrelatedMeasures).toBe(1);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 50000);
