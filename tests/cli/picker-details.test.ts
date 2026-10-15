import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { sessionDetail } from "../../src/cli/interactive/pickers";
import { SlashMenu } from "../../src/cli/slash-menu";
import { Editor } from "../../src/cli/terminal/editor";
import { Screen } from "../../src/cli/terminal/screen";
import { draw } from "../../src/cli/terminal/view";
import { createTheme, visibleWidth } from "../../src/cli/theme";
import type { PickerItem } from "../../src/cli/ui-contract";

function frame(
  columns: number,
  rows: number,
  items: readonly PickerItem[],
  index = 0,
  filter = "",
  menu?: SlashMenu,
) {
  const screen = new Screen(
    new PassThrough(),
    () => ({ columns, rows }),
    createTheme({ isTTY: false }),
  );
  screen.enabled = true;
  const paint = vi.spyOn(screen, "paint").mockImplementation(() => {});
  const editor = new Editor();
  editor.set(filter);
  draw({
    columns,
    rows,
    screen,
    picker: menu
      ? undefined
      : {
          spec: { title: "Resume session", items },
          editor,
          index,
          resolve: () => {},
        },
    editor: menu ? editor : new Editor(),
    prompt: "❯ ",
    fresh: false,
    menu: menu ?? new SlashMenu(),
    status: null,
    tail: [],
    filtered: () => items.filter((item) => item.label.includes(filter)),
  });
  const call = paint.mock.calls[0];
  if (!call) throw Error("No frame");
  return {
    lines: call[0],
    text: call[0].map((line) => line.map((span) => span.text).join("")),
    cursor: call[1],
  };
}

const date = new Date(2026, 0, 2, 14, 35);
const detail = sessionDetail(
  "completed",
  `${homedir()}/projects/very-long-directory/中文工作区/final-project`,
  date.toISOString(),
);
const sessions = Array.from({ length: 15 }, (_, index) => ({
  value: `exact-${index}`,
  label: index === 9 ? "中文选择" : `Session ${index}`,
  detail: index === 9 ? detail : "Other details\n/other",
}));

describe("selected picker details", () => {
  it("formats local time and human status without modifying identity", () => {
    expect(detail).toContain("Completed · 2026-01-02 14:35");
    expect(detail.split("\n")[1]).toMatch(/^~\//);
    expect(detail).not.toContain(date.toISOString());
  });
  for (const width of [40, 80, 120]) {
    it(`shows selected status/time and workspace on dedicated rows at ${width}`, () => {
      const result = frame(width, 30, sessions, 9);
      expect(result.text.join("\n")).toContain("Completed · 2026-01-02 14:35");
      expect(result.text.join("\n")).toContain("final-project");
      expect(result.text.join("\n")).not.toContain("Other details");
      expect(result.text.some((line) => line.startsWith("~/"))).toBe(true);
      expect(
        result.lines.filter((line) =>
          line.some((span) => span.tone === "muted"),
        ),
      ).toHaveLength(3);
      expect(result.lines.length).toBeLessThanOrEqual(13);
      for (const line of result.text)
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    });
  }
  it("uses filtered selection metadata for CJK titles", () => {
    const result = frame(40, 30, sessions, 0, "中文");
    expect(result.text.join("\n")).toContain("❯ 中文选择");
    expect(result.text.join("\n")).toContain("Completed");
    expect(sessions[9]?.value).toBe("exact-9");
  });
  for (const rows of [2, 3, 4, 5, 10]) {
    it(`prioritizes composer and one item over details with ${rows} rows`, () => {
      const result = frame(40, rows, sessions, 9);
      expect(result.lines.length).toBeLessThanOrEqual(rows - 1);
      expect(result.cursor).toBeGreaterThanOrEqual(0);
      expect(result.cursor).toBeLessThan(result.lines.length);
      if (rows >= 3) expect(result.text.join("\n")).toContain("❯ 中文选择");
    });
  }
  it("keeps metadata-free models as eight concise items", () => {
    const items = sessions.map((item) => ({
      value: item.value,
      label: item.label,
    }));
    const result = frame(40, 30, items, 9);
    expect(result.text.filter((line) => /^(❯| ) /.test(line))).toHaveLength(8);
    expect(result.text.join("\n")).not.toContain("Completed");
  });
});

describe("menu continuation", () => {
  const models = Array.from({ length: 20 }, (_, i) => ({
    value: `id-${i}`,
    label: `model-${i}`,
  }));
  it("reports the actual model window, updates on scroll and filtered totals", () => {
    expect(frame(40, 30, models).text.join("\n")).toContain(
      "1–8/20 · ↑↓ move · type to filter",
    );
    expect(frame(40, 30, models, 19).text.join("\n")).toContain("13–20/20");
    expect(frame(40, 30, models, 10, "model-1").text.join("\n")).toContain(
      "4–11/11",
    );
    for (const filter of ["model-19", "missing"]) {
      expect(frame(40, 30, models, 0, filter).text.join("\n")).not.toMatch(
        /\d+–\d+\/\d+/,
      );
    }
  });
  it("reports the reduced session window without losing details", () => {
    const result = frame(40, 30, sessions, 9);
    expect(result.text.join("\n")).toContain("6–13/15");
    expect(result.text.join("\n")).toContain("Completed · 2026-01-02 14:35");
    expect(result.lines).toHaveLength(13);
  });
  it("uses real slash filtered items and updates the range on navigation", () => {
    const menu = new SlashMenu();
    menu.update("/");
    const total = menu.state.items.length;
    expect(total).toBeGreaterThan(8);
    expect(frame(40, 30, [], 0, "/", menu).text.join("\n")).toContain(
      `1–8/${total}`,
    );
    menu.moveUp();
    expect(frame(40, 30, [], 0, "/", menu).text.join("\n")).toContain(
      `${total - 7}–${total}/${total}`,
    );
    menu.update("/model");
    expect(menu.state.items).toHaveLength(1);
    expect(frame(40, 30, [], 0, "/model", menu).text.join("\n")).not.toMatch(
      /\d+–\d+\/\d+/,
    );
    menu.update("/nonexistent");
    expect(
      frame(40, 30, [], 0, "/nonexistent", menu).text.join("\n"),
    ).not.toMatch(/\d+–\d+\/\d+/);
  });
  for (const rows of [2, 3, 4, 5, 10, 30]) {
    it(`keeps actual frames and cursor bounded at height ${rows}`, () => {
      const menu = new SlashMenu();
      menu.update("/");
      for (const result of [
        frame(40, rows, models),
        frame(40, rows, [], 0, "/", menu),
      ]) {
        expect(result.lines.length).toBeLessThanOrEqual(Math.min(20, Math.max(4, Math.floor(rows * 0.45)), rows - 1));
        expect(result.cursor).toBeGreaterThanOrEqual(0);
        expect(result.cursor).toBeLessThan(result.lines.length);
        const options = result.text.filter(
          (line) => /^(❯| ) /.test(line) && line !== "❯ /",
        );
        expect(options.length).toBeLessThanOrEqual(8);
        if (rows >= 3) expect(options.length).toBeGreaterThanOrEqual(1);
        for (const line of result.text)
          expect(visibleWidth(line)).toBeLessThanOrEqual(40);
        if (rows === 3) expect(result.text.join("\n")).toMatch(/1–1\/\d+/);
      }
    });
  }
});
