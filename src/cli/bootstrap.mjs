#!/usr/bin/env node
// Keep this bootstrap separate from the bundle: ESM static imports run before
// its body, so a bundled NODE_ENV assignment cannot configure external React/Ink.
// The CLI is a production executable, even when launched from a development shell.
// React's development performance tracks otherwise accumulate on every repaint.
process.env.NODE_ENV = "production";
await import("./cli-main.mjs");
