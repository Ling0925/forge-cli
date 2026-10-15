import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SlashMenu } from "../../src/cli/slash-menu";
import { Editor } from "../../src/cli/terminal/editor";
import { pickerDetail, pickerLayout } from "../../src/cli/terminal/picker-layout";
import { Screen } from "../../src/cli/terminal/screen";
import { draw, type View } from "../../src/cli/terminal/view";
import { createTheme, graphemes, visibleWidth } from "../../src/cli/theme";
import type { PickerSpec, RichLine } from "../../src/cli/ui-contract";

const uuidTitle = "Task command 74f3d9e2-513a-4aef-82ba-f03bf373b65f · exact identity";
const items = Array.from({ length: 20 }, (_, index) => ({
  value: `exact-${index}`, label: `Choice ${index} 中文 👩‍💻 é`,
  detail: "Completed · 2026-01-02 14:35\n~/中文/" + "long-directory/".repeat(50) + "final-project",
}));
const text = (lines: readonly RichLine[]) => lines.map(line => line.map(span => span.text).join(""));
function layout(columns = 80, rows = 30, spec: PickerSpec = { title: uuidTitle, items }, query = "") {
  return pickerLayout({ spec, items: spec.items, index: Math.min(9, spec.items.length - 1), text: query, cursor: query.length,
    columns, limit: Math.max(1, Math.min(20, Math.max(4, Math.floor(rows * .45)), rows - 1)), itemLimit: rows >= 36 ? 12 : 8, frame: "⠋" });
}

describe("layered picker layout", () => {
  it("keeps a UUID title separate from filter input and selected result", () => {
    const result = layout();
    const lines = text(result.lines);
    expect(lines[0]).toBe(uuidTitle);
    expect(lines[1]).toBe("❯ Type to filter…");
    expect(result.row).toBe(1);
    expect(result.column).toBe(2);
    expect(lines.join("\n")).toContain("❯ Choice 9 中文 👩‍💻 é");
    expect(lines.at(-1)).toBe("Enter选择 · Esc返回 · ↑↓移动");
    const selected = result.lines.find(line => line.some(span => span.text.includes("Choice 9")));
    expect(selected?.[0]).toMatchObject({ tone: "accent", inverse: true });
    expect(items[9]?.value).toBe("exact-9");
    expect(text(layout(80, 30, { title: uuidTitle, items, placeholder: "Filter exact tasks…" }).lines)[1]).toBe("❯ Filter exact tasks…");
  });
  it("distinguishes confirmation hints without implying typing approves", () => {
    const lines = text(layout(80, 30, { title: "Stop exact task?", items, confirmation: true }).lines);
    expect(lines[1]).toBe("❯ Choose an action…");
    expect(lines.at(-1)).toBe("Enter确认 · Esc取消 · ↑↓移动");
  });
  it("shows empty results and operation hints with a bounded empty label", () => {
    const lines = text(layout(40, 24, { title: uuidTitle, items: [], emptyLabel: "No task matches the query" }, "missing").lines);
    expect(lines).toContain("❯ missing");
    expect(lines).toContain("No task matches the query");
    expect(lines.at(-1)).toContain("Esc返回");
  });
  for (const columns of [1, 8, 40, 80, 120]) for (const rows of [1, 2, 4, 12, 24, 30, 40]) {
    it(`bounds unicode lines and cursor at ${columns}×${rows}`, () => {
      for (const query of ["", "中文 👩‍💻 é".repeat(20)]) {
        const result = layout(columns, rows, undefined, query);
        expect(result.lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(20, Math.max(4, Math.floor(rows * .45)), rows - 1)));
        expect(result.row).toBeGreaterThanOrEqual(0);
        expect(result.row).toBeLessThan(result.lines.length);
        expect(result.column).toBeGreaterThanOrEqual(0);
        expect(result.column).toBeLessThan(columns);
        for (const line of text(result.lines)) expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
        if (rows >= 4) expect(result.lines.some(line => line.some(span => span.inverse))).toBe(true);
      }
    });
  }
  it("sanitizes external strings before layout, including SGR and cursor controls", () => {
    const unsafe = "\u001b[31mred\u001b[0m\u001b[2J\u001b]0;owned\u0007 中文";
    const result = layout(40, 30, { title: unsafe, items: [{ value: "unchanged", label: unsafe, detail: unsafe }], emptyLabel: unsafe });
    for (const line of text(result.lines)) {
      expect(line).not.toMatch(/[\u001b\u0007]/);
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
  it("truncates huge details at whole graphemes while preserving both ends", () => {
    const source = "~/" + "👩‍💻中文é/".repeat(5000) + "/final-project";
    const result = pickerDetail(source, 40);
    expect(result).toMatch(/^~\//);
    expect(result).toContain("…");
    expect(result).toMatch(/final-project$/);
    expect(visibleWidth(result)).toBeLessThanOrEqual(40);
    for (const glyph of graphemes(result)) expect(glyph).not.toBe("\u200d");
  });
  it("keeps eight/twelve result caps and reports the actual window", () => {
    const spec = { title: "Models", items: items.map(({ value, label }) => ({ value, label })) };
    for (const [rows, cap] of [[30, 8], [40, 12]]) {
      const lines = text(layout(80, rows, spec).lines);
      expect(lines.filter(line => /^(❯| ) Choice/.test(line))).toHaveLength(cap!);
      expect(lines.join("\n")).toContain(`/20 matches`);
    }
  });
});

describe("view integration without changing normal dock geometry", () => {
  function view(fresh = false): View {
    const screen = new Screen(new PassThrough(), () => ({ columns: 80, rows: 30 }), createTheme({ isTTY: false }));
    screen.enabled = true;
    screen.fixed = true;
    return { columns: 80, rows: 30, screen, editor: new Editor(), picker: undefined, prompt: fresh ? "Approve? [Y/n] " : "❯ ", fresh,
      menu: new SlashMenu(), status: null, tail: [], filtered: () => [] };
  }
  it("leaves fresh approval input free of picker chrome", () => {
    const state = view(true);
    // Defensive rendering: approval wins even if a stale picker was retained.
    state.picker = { spec: { title: uuidTitle, items }, editor: new Editor(), index: 0, resolve: () => {} };
    const paint = vi.spyOn(state.screen, "paint").mockImplementation(() => {});
    draw(state);
    const [lines, row] = paint.mock.calls[0]!;
    expect(text(lines).join("\n")).toContain("Approve? [Y/n]");
    expect(text(lines).join("\n")).not.toMatch(/Type to filter|Esc返回|Enter选择/);
    expect(text(lines)[row]).toContain("Approve?");
  });
  it("reuses animated transcript identity on typing within a frame", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const state = view();
      state.tail = [[{ text: "", animation: "spinner" }], [{ text: "stable" }]];
      vi.spyOn(state.screen, "paint").mockImplementation(() => {});
      const transcript = vi.spyOn(state.screen, "setTranscript");
      draw(state);
      state.editor.set("typing");
      draw(state);
      expect(transcript.mock.calls[0]![0]).toBe(transcript.mock.calls[1]![0]);
      now.mockReturnValue(80);
      draw(state);
      expect(transcript.mock.calls[2]![0]).not.toBe(transcript.mock.calls[1]![0]);
      expect(transcript.mock.calls[2]![0][1]).toBe(state.tail[1]);
    } finally { now.mockRestore(); }
  });
});
