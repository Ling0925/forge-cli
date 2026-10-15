import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { Controller } from "./legacy/controller";
import { Screen, plain } from "./legacy/screen";
import { resolveTheme } from "../../src/cli/theme";
import * as rich from "../../src/cli/render/rich";
import { contextFooter } from "../../src/cli/terminal/context-footer";
import { stringWidth } from "../../src/cli/render/width";
import { toolSummaryLines } from "../../src/cli/render/tools";
const text = (row: readonly { text: string }[]) => row.map(part => part.text).join("");
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
it("does not repaint identical spinner frames while preserving immediate streaming updates", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  output.resume();
  const controller = new Controller(input, output, true, () => {}, () => {}, () => {}, async () => false);
  try {
    await controller.configure({ theme: "dark" });
    controller.setStatus({ label: "thinking", startedAt: 0, toolCount: 0, cancellable: true });
    const draw = vi.spyOn(controller, "draw");
    await vi.advanceTimersByTimeAsync(66);
    expect(draw).not.toHaveBeenCalled();
    controller.setTail([plain("new streaming output")]);
    expect(draw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(22);
    expect(draw).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(draw).toHaveBeenCalledTimes(2);
  } finally { controller.dispose(); }
});
it("reuses styled static rows and invalidates styles when theme changes", () => {
  const output = new PassThrough(); output.resume();
  const theme = resolveTheme({ setting: "dark", background: "dark", colorDepth: 24, noColor: false, dumb: false });
  const screen = new Screen(output, () => ({ columns: 80, rows: 24 }), theme);
  screen.enabled = true; screen.fixed = true;
  screen.append(Array.from({ length: 30 }, (_, i) => [{ text: `history ${i}`, tone: "accent" as const }]));
  const dock = [plain("❯ draft")];
  const render = vi.spyOn(rich, "renderRichLine");
  screen.paint(dock, 0, 3); render.mockClear();
  screen.paint(dock, 0, 3);
  expect(render).not.toHaveBeenCalled();
  screen.theme = resolveTheme({ setting: "light", background: "light", colorDepth: 24, noColor: false, dumb: false });
  screen.paint(dock, 0, 3);
  expect(render).toHaveBeenCalled();
});
it("keeps distinct tool, target and result tones without overflowing tiny widths", () => {
  const call = { id: "t", type: "function" as const, function: { name: "read_file", arguments: '{"path":"a.ts"}' } };
  for (const failed of [false, true]) {
    const result = { content: JSON.stringify(failed ? { error: "failed" } : { content: "1: code", offset: 0, total_lines: 1 }), isError: failed };
    const row = toolSummaryLines(call, result, 80)[0]!;
    expect(row.find(span => span.text === "read_file")?.tone).toBe("accent");
    expect(row.find(span => span.text.includes(failed ? "failed" : "done"))?.tone).toBe(failed ? "error" : "success");
    expect(row.find(span => span.text.includes("a.ts"))?.tone).toBeUndefined();
    for (const width of [1, 4, 8, 40]) expect(stringWidth(text(toolSummaryLines(call, result, width)[0]!))).toBeLessThanOrEqual(width);
  }
});
it("preserves whole effort labels ahead of the decorative meter on narrow footers", () => {
  const context = { model: "provider/very-long-model-name", reasoningEffort: "high", usage: null };
  for (const compact of [true, false]) {
    const row = text(contextFooter(context, 40, compact)[0]!);
    expect(row).toContain("(high)"); expect(row).toContain("R—");
    expect(row).not.toContain("[··"); expect(stringWidth(row)).toBeLessThanOrEqual(40);
    const narrow = text(contextFooter(context, 18, compact)[0]!);
    expect(narrow).not.toContain("(");
  }
});
