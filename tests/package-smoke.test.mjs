import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("build preserves production bootstrap and the external core package boundary", async () => {
  assert.deepEqual(await readFile(join(root, "dist/cli.mjs")), await readFile(join(root, "src/cli/bootstrap.mjs")));
  const bundle = await readFile(join(root, "dist/cli-main.mjs"), "utf8");
  assert.match(bundle, /from "@forge\/core\/core\/harness"/);
  assert(!bundle.includes("src/core/harness.ts"));
});

test("built CLI loads Core and lists sessions using only isolated state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-cli-package-"));
  try {
    const output = execFileSync(process.execPath, [join(root, "dist/cli.mjs"), "sessions", "--json"], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, FORGE_HOME: join(directory, "state") },
      encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
    });
    assert.deepEqual(JSON.parse(output), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("built plugin commands persist Core configuration without real provider or browser state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "forge-cli-plugins-package-"));
  const env = { PATH: process.env.PATH, HOME: directory, FORGE_HOME: join(directory, "state") };
  const run = (...args) => spawnSync(process.execPath, [join(root, "dist/cli.mjs"), "plugins", ...args, "--json"], {
    cwd: directory, env, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
  });
  const success = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const list = success("list");
    assert.equal(list.length, 1);
    assert.equal(list[0].manifest.id, "browser");
    assert.equal(list[0].enabled, false);
    assert.equal(run("enable", "browser").status, 1);
    const configPath = join(directory, "browser-plugin.json");
    await writeFile(configPath, JSON.stringify({
      executablePath: join(directory, "deliberately-missing-agent-browser"),
      allowedDomains: ["example.com"],
    }));
    const configured = success("configure", "browser", "--config", configPath);
    assert.equal(configured.enabled, false);
    assert.deepEqual(configured.config.allowedDomains, ["example.com"]);
    assert.equal(success("enable", "browser").status, "configured");
    assert.equal(success("show", "browser").enabled, true);
    const health = run("check", "browser");
    assert.equal(health.status, 1, health.stderr);
    assert.equal(JSON.parse(health.stdout).status, "unavailable");
    assert.equal(success("disable", "browser").status, "disabled");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
