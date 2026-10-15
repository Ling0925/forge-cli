import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
// Do not remove desktop or renderer outputs produced by another build.
await mkdir("dist", { recursive: true });
await build({
  bundle: true,
  platform: "node",
  target: "node22",
  external: ["electron", "playwright", "playwright-core", "ink", "react"],
  sourcemap: false,
  legalComments: "eof",
  logLevel: "info",
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.mjs",
  format: "esm",
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as forgeCreateRequire } from "node:module"; const require = forgeCreateRequire(import.meta.url);',
  },
});
await chmod("dist/cli.mjs", 0o755);
