import { chmod, copyFile, mkdir } from "node:fs/promises";
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
  outfile: "dist/cli-main.mjs",
  format: "esm",
  banner: {
    js: 'import { createRequire as forgeCreateRequire } from "node:module"; const require = forgeCreateRequire(import.meta.url);',
  },
});
// Do not bundle this entry: it must select production before any React imports.
await copyFile("src/cli/bootstrap.mjs", "dist/cli.mjs");
await chmod("dist/cli.mjs", 0o755);
