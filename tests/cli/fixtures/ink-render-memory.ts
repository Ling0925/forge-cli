// Synthetic UI only. Run through the real CLI bootstrap; do not set NODE_ENV here.
// Static imports deliberately check that the bootstrap precedes React evaluation.
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { createElement } from "react";
import { render } from "ink";
import type { AgentEvent } from "../../../src/shared/schemas";
import { InkView } from "../../../src/cli/ink/view";
import { initialInput } from "../../../src/cli/ink/input-state";
import type { InkViewState } from "../../../src/cli/ink/types";
import { createEventRenderer } from "../../../src/cli/render/events";

assert.equal(typeof global.gc, "function", "Run with --expose-gc");
const heap = (): number => { global.gc!(); return process.memoryUsage().heapUsed; };
const batchSize = Number(process.argv[2] ?? 1000);
assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0 && batchSize <= 10000);
const unrelatedMeasure = "forge-memory-test-unrelated";
performance.measure(unrelatedMeasure, { start: 0, end: 0 });

let writes = 0;
let latest = "";
const stdout = Object.assign(new Writable({
  write(chunk, _encoding, done) {
    writes++;
    latest = chunk.toString(); // Never accumulate terminal output in the fixture.
    done();
  },
}), { isTTY: true, columns: 120, rows: 32 });
const stdin = new PassThrough();
const input = initialInput();
const producer = createEventRenderer({ width: () => 120, now: () => 0 });
const event = (value: object): AgentEvent => value as AgentEvent;
producer.push(event({ type: "run_started", turn: 4 }));
const base: InkViewState = {
  columns: 120, rows: 32, tail: [], status: null, context: null, plan: null,
  mode: "build", theme: "dark", noColor: true, pendingInput: [],
  inputHint: "synthetic-composer", now: 0,
  visibleHistory: Array.from({ length: 30 }, (_, i) => [{ text: `synthetic-history-${i}` }]),
};
const app = render(createElement(InkView, { state: base, input }), {
  stdin: stdin as unknown as NodeJS.ReadStream,
  stdout: stdout as unknown as NodeJS.WriteStream,
  stderr: stdout as unknown as NodeJS.WriteStream,
  // Synchronous painting accelerates the same React/Ink tree without timers or
  // private renderer hooks. The built CLI's incremental path is tested in a PTY.
  debug: true, patchConsole: false, exitOnCtrlC: false,
});
let frames = 0;
async function repaint(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    frames++;
    const update = producer.push(event({ type: "reasoning_delta", text: `\n思考 synthetic thought ${frames}` }));
    app.rerender(createElement(InkView, {
      state: { ...base, tail: update.tail, status: update.status ?? null, now: frames * 80 }, input,
    }));
    if (i % 20 === 0) await tick();
  }
  await tick();
}

try {
  await repaint(200);
  const before = heap();
  const measuresBefore = performance.getEntriesByType("measure").length;
  await repaint(batchSize);
  const middle = heap();
  await repaint(batchSize);
  const after = heap();
  assert.ok(writes >= frames, "The regression must paint frames, not just enqueue them");
  assert.ok(latest.includes(`synthetic thought ${frames}`), "The last thought must be rendered");
  assert.ok(latest.includes("synthetic-history-29"), "Completed history must stay visible");
  assert.ok(latest.includes("synthetic-composer"), "The input dock must stay visible");
  console.log(JSON.stringify({
    nodeEnv: process.env.NODE_ENV, frames, writes, before, middle, after,
    growth: after - before, lateGrowth: after - middle, measuresBefore,
    measuresAfter: performance.getEntriesByType("measure").length,
    unrelatedMeasures: performance.getEntriesByName(unrelatedMeasure, "measure").length,
  }));
} finally {
  app.unmount();
  app.cleanup();
  stdin.destroy();
  stdout.destroy();
}
