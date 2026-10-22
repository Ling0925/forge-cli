import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const sourceRoots = ["src", "tests"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs"]);
// These modules belong to @forge/core. A relative import that leaves the CLI's
// own src/tests tree would make the repository look independent while still
// depending on the original monorepo layout.
const escapedCoreModule = /(?:from\s*|import\s*\()\s*["'](?:\.\.\/)+(?:shared|core|host|mcp|store|provider|tools|web)\//;
const testSourceModule = /["'][^"']*src\/(?:shared|core|host|mcp|store|provider|tools|web)\//;
const failures = [];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(path);
  }
  return files;
}

for (const sourceRoot of sourceRoots) {
  for (const file of await collect(join(rootPath, sourceRoot))) {
    const contents = await readFile(file, "utf8");
    const lines = contents.split("\n");
    lines.forEach((line, index) => {
      if (escapedCoreModule.test(line) || testSourceModule.test(line)) {
        failures.push(`${relative(rootPath, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

const packageJson = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8"));
const coreDependency = packageJson.dependencies?.["@forge/core"];
if (typeof coreDependency !== "string" || !coreDependency.startsWith("file:")) {
  failures.push("package.json must depend on @forge/core through a file: dependency for local co-development");
}

const tsconfig = JSON.parse(await readFile(join(rootPath, "tsconfig.json"), "utf8"));
if (tsconfig.compilerOptions?.paths) {
  failures.push("tsconfig.json must not use path aliases to simulate the @forge/core package");
}

if (failures.length > 0) {
  console.error(`CLI/Core boundary check failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("CLI/Core boundary check passed");
}
