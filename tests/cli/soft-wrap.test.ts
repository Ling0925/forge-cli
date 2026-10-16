import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { expect, it } from "vitest";
import { InkView } from "../../src/cli/ink/view";
import { initialInput } from "../../src/cli/ink/input-state";
import type { InkViewState } from "../../src/cli/ink/types";
import { stripAnsi, stringWidth } from "../../src/cli/render/width";
import { ReadingView } from "../../src/cli/ink/transcript";
import { markdownLines, MarkdownStream } from "../../src/cli/render/markdown";
import { wrapRichLines } from "../../src/cli/render/rich";
import { Transcript } from "../../src/cli/ink/transcript";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(s => s.text).join("")).join("\n");

it("reflows the producer's 80-column rows at Ink's 79 columns without a stray one-letter row", () => {
  const source = `${"中".repeat(38)}abLRU 缓存已修复`;
  const rows = markdownLines(source, 80);
  expect(text(wrapRichLines(rows, 79))).toBe(text(markdownLines(source, 79)));
});

it("rejoins only generated wraps when a completed summary is displayed wider", () => {
  const source = "总结：采用 **LRU** 缓存，保留 `API` 输出。";
  const history = new Transcript(); history.append(markdownLines(source, 13));
  expect(text(history.recent(80))).toBe(text(markdownLines(source, 80)));
  expect(text(history.recent(80))).toContain("LRU");
});

it("preserves original newlines, blank lines and code while removing generated wraps", () => {
  for (const source of ["L\nRU", "first\n\nsecond", "```text\nL\nRU\n```", "- first LRU\n- second API"]) {
    expect(text(wrapRichLines(markdownLines(source, 6), 80))).toBe(text(markdownLines(source, 80)));
  }
});

it("does not treat stream chunk boundaries as newlines", () => {
  const stream = new MarkdownStream(() => 80);
  stream.push("总结：使用 **L"); stream.push("R"); stream.push("U** 缓存");
  expect(text(stream.finish().append)).toBe(text(markdownLines("总结：使用 **LRU** 缓存", 80)));
});

it("reflows across a frozen reading page boundary without joining separate messages", () => {
  const source = "总结：采用 LRU 缓存，保留 API 输出。";
  const view = new ReadingView(); view.open([], markdownLines(source, 7), 7);
  view.move(-2, 1); view.resize(80);
  expect(text(view.snapshot()!.lines)).toBe(source);
  const history = new Transcript(); history.append(markdownLines(source, 7)); history.append(markdownLines("next message", 7));
  expect(text(history.recent(80))).toBe(`${source}\nnext message`);
});

it("retains styling and does not mutate cached rows across repeated reflows", () => {
  const source = "总结：采用 **LRU** 缓存，保留 `API` 输出。";
  const rows = markdownLines(source, 13); const saved = JSON.stringify(rows);
  for (const width of [8, 40, 12, 80, 79]) {
    const result = wrapRichLines(rows, width);
    expect(result.every(row => stringWidth(text([row])) <= width)).toBe(true);
    expect(text(result)).toBe(text(markdownLines(source, width)));
  }
  const wide = wrapRichLines(rows, 80);
  expect(wide.flat().some(s => s.bold && s.text.includes("LRU"))).toBe(true);
  expect(wide.flat().some(s => s.tone === "warning" && s.text.includes("API"))).toBe(true);
  expect(JSON.stringify(rows)).toBe(saved);
});

it("renders a resized live summary and committed history as intact short words in Ink", () => {
  const source = "总结：采用 **LRU** 缓存，保留 `API` 输出。";
  const history = new Transcript(); const rows = markdownLines(source, 13); history.append(rows);
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true });
  let latest = ""; output.on("data", chunk => { const value = stripAnsi(chunk.toString()); if (value) latest = value; });
  const base: InkViewState = { columns: 80, rows: 24, tail: rows, status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: false, colorDepth: 24, pendingInput: [], inputHint: null, now: 0 };
  const app = render(createElement(InkView, { state: base, input: initialInput() }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    expect(latest).toContain("总结：采用 LRU 缓存，保留 API 输出。");
    app.rerender(createElement(InkView, { state: { ...base, tail: [], visibleHistory: history.recent(79) }, input: initialInput() }));
    expect(latest).toContain("总结：采用 LRU 缓存，保留 API 输出。");
  } finally { app.unmount(); app.cleanup(); }
});
