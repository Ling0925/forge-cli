import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
