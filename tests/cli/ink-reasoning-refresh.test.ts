import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { InkView } from "../../src/cli/ink/view";
import { initialInput } from "../../src/cli/ink/input-state";
import { createEventRenderer } from "../../src/cli/render/events";
import { stripAnsi, stringWidth } from "../../src/cli/render/width";
import { wrapRichLines } from "../../src/cli/render/rich";
import { reasoningLine } from "../../src/cli/render/reasoning";
import { ReadingView, Transcript } from "../../src/cli/ink/transcript";
import type { InkViewState } from "../../src/cli/ink/types";
import type { AgentEvent } from "../../src/shared/schemas";

const event = (value: object) => value as AgentEvent;
afterEach(() => vi.unstubAllEnvs());
it("keeps completed history in place as a collapsed thought grows, starts new lines and animates", () => {
  vi.stubEnv("FORGE_SYMBOLS", "unicode");
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let latest = ""; output.on("data", chunk => { latest = stripAnsi(chunk.toString()); });
  const producer = createEventRenderer({ width: () => 80, now: () => 0 });
  producer.push(event({ type: "run_started" }));
  const base: InkViewState = { columns: 80, rows: 24, tail: [], status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: true, pendingInput: [], inputHint: null, now: 0,
    visibleHistory: Array.from({ length: 30 }, (_, i) => [{ text: `history-${i}` }]) };
  const app = render(createElement(InkView, { state: base, input: initialInput() }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    const positions: number[] = [];
    for (const [index, text] of ["short thought", "x".repeat(120), "\n", "  ", "new thought", "中".repeat(80)].entries()) {
      const update = producer.push(event({ type: "reasoning_delta", text }));
      app.rerender(createElement(InkView, { state: { ...base, tail: update.tail, status: update.status ?? null, now: index * 80 }, input: initialInput() }));
      const rows = latest.split("\n");
      positions.push(rows.findIndex(row => row.includes("history-29")));
      expect(rows.filter(row => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(row)).length).toBeLessThanOrEqual(2);
    }
    expect(new Set(positions).size, `history row positions: ${positions.join(",")}`).toBe(1);
  } finally { app.unmount(); app.cleanup(); }
});

it.each(["unicode", "ascii"])("keeps collapsed previews one row on repeated reflow in %s mode without truncating answers", symbols => {
  vi.stubEnv("FORGE_SYMBOLS", symbols);
  const thought = reasoningLine("中文 👩‍💻 ".repeat(60), 120, true)!;
  for (const width of [119, 79, 39, 8, 2, 1]) {
    const rows = wrapRichLines([thought], width);
    expect(rows).toHaveLength(1);
    expect(stringWidth(rows[0]!.map(s => s.text).join(""))).toBeLessThanOrEqual(width);
    expect(wrapRichLines(rows, Math.max(1, width - 1))).toHaveLength(1);
    const view = new ReadingView(); view.open([], [thought], 120); view.resize(width);
    expect(view.snapshot()!.lines).toHaveLength(1);
    const history = new Transcript(); history.append([reasoningLine("thought ".repeat(50), 120)!]);
    expect(history.recent(width)).toHaveLength(1);
  }
  const answer = "answer 中文 ".repeat(20);
  const rows = wrapRichLines([[{ text: answer }]], 20);
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.flat().map(s => s.text).join("")).toBe(answer);
});

it("keeps whitespace-only deltas stable but clears the preview at answer/tool/run boundaries", () => {
  const producer = createEventRenderer(); producer.push(event({ type: "run_started" }));
  expect(producer.push(event({ type: "reasoning_delta", text: " \n\t" })).tail).toEqual([]);
  const initial = producer.push(event({ type: "reasoning_delta", text: "visible thought" })).tail;
  for (const text of ["\n", "  ", "\t", "\r\n"]) {
    expect(producer.push(event({ type: "reasoning_delta", text })).tail).toEqual(initial);
  }
  const answer = producer.push(event({ type: "text_delta", text: "answer" }));
  expect(answer.tail.flat().some(s => s.preview === "reasoning")).toBe(false);
  producer.push(event({ type: "reasoning_delta", text: "second thought" }));
  const tool = producer.push(event({ type: "tool_started", call: { id: "t", type: "function", function: { name: "read_file", arguments: "{}" } } }));
  expect(tool.tail.flat().some(s => s.preview === "reasoning")).toBe(false);
  expect(producer.push(event({ type: "run_started" })).tail.flat().some(s => s.preview === "reasoning")).toBe(false);
});

it("updates only thought/status rows in real incremental Ink output, not history or composer", async () => {
  vi.stubEnv("FORGE_SYMBOLS", "unicode");
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const producer = createEventRenderer({ width: () => 80, now: () => 0 });
  producer.push(event({ type: "run_started" }));
  const first = producer.push(event({ type: "reasoning_delta", text: "short thought" }));
  const base: InkViewState = { columns: 80, rows: 24, tail: first.tail, status: first.status ?? null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: false, pendingInput: [], inputHint: "stable-composer", now: 0,
    visibleHistory: Array.from({ length: 30 }, (_, i) => [{ text: `history-${i}` }]) };
  const app = render(createElement(InkView, { state: base, input: initialInput() }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 70));
  try {
    await settle(); bytes = "";
    for (const [index, text] of ["x".repeat(120), "\n ", "new thought", "中".repeat(80)].entries()) {
      const update = producer.push(event({ type: "reasoning_delta", text }));
      app.rerender(createElement(InkView, { state: { ...base, tail: update.tail, status: update.status ?? null, now: (index + 1) * 80 }, input: initialInput() }));
      await settle();
      expect(bytes).not.toMatch(/history-|stable-composer|\u001b\[(?:2J|3J|2K)/);
      expect(stripAnsi(bytes).trim().length).toBeGreaterThan(0);
      bytes = "";
    }
  } finally { app.unmount(); app.cleanup(); }
});
