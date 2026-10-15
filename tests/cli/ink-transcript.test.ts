import { describe, expect, it } from "vitest";
import { Transcript, ReadingView, HISTORY_BYTES, HISTORY_LINES, PENDING_BYTES } from "../../src/cli/ink/transcript";
import { dockLayout } from "../../src/cli/ink/layout";
import type { RichLine } from "../../src/cli/ui-contract";
const line = (text: string): RichLine => [{ text }];

describe("bounded transcript delivery and reading", () => {
  it("delivers committed lines once without retaining them as a React Static list", () => {
    const t = new Transcript();
    t.append([line("first"), line("second")]);
    expect(t.drain(80, "system", true).join("")).toBe("first\nsecond\n");
    expect(t.drain(80, "system", true)).toEqual([]);
    t.append([line("third")]);
    expect(t.drain(80, "system", true).join("")).toBe("third\n");
    expect(t.recent(80)).toHaveLength(3);
  });
  it("bounds recent memory and caches wrapping across idle frames", () => {
    const t = new Transcript();
    for (let i = 0; i < 10000; i++) { t.append([line(`row-${i}`)]); t.drain(80, "system", true); }
    expect(t.retainedLines).toBe(HISTORY_LINES);
    expect(t.retainedBytes).toBeLessThanOrEqual(HISTORY_BYTES);
    expect(t.queuedBytes).toBe(0);
    expect(t.recent(80)).toBe(t.recent(80));
    const old = t.recent(80);
    t.append([line("new")]);
    expect(t.recent(80)).not.toBe(old);
    expect(t.recent(80).at(-1)).toEqual(line("new"));
  });
  it("keeps a bounded deferred output queue and makes overflow explicit", () => {
    const t = new Transcript();
    for (let i = 0; i < 40; i++) t.append([line(`${i} ${"x".repeat(100000)}`)], true);
    expect(t.queuedBytes).toBeLessThanOrEqual(PENDING_BYTES);
    expect(t.retainedBytes).toBeLessThanOrEqual(HISTORY_BYTES);
    expect(t.drain(80, "system", true).join("")).toContain("Reading buffer limit reached");
  });
  it("freezes unfinished output while live work continues and pages without loss", () => {
    const view = new ReadingView();
    const tail = Array.from({ length: 100 }, (_, i) => line(`unfinished-${i}`));
    view.open([line("history")], tail, 80);
    const frozen = view.snapshot()!.lines;
    view.changed(); view.open([], [line("changed")], 80);
    expect(view.snapshot()!.lines).toBe(frozen);
    expect(view.snapshot()!.end).toBe(101);
    view.move(-25, 20);
    expect(view.snapshot()!.end).toBe(76);
    view.move(-9999, 20); expect(view.snapshot()!.end).toBe(20);
    view.move(9999, 20); expect(view.snapshot()!.end).toBe(101);
    view.close(); expect(view.snapshot()).toBeNull();
  });
  it("reflows a frozen reading snapshot on narrow resize without dropping its suffix", () => {
    const view = new ReadingView();
    view.open([], [line("prefix-middle-suffix")], 80);
    view.resize(6);
    expect(view.snapshot()!.lines.flat().map(span => span.text).join("")).toBe("prefix-middle-suffix");
    expect(view.snapshot()!.end).toBe(4);
  });
  it("sanitizes control injection on committed output", () => {
    const t = new Transcript();
    t.append([line("safe\x1b]52;c;bad\x07\x1b[2J")]);
    expect(t.drain(80, "system", true).join("")).toBe("safe\n");
  });
});

it("allocates available height without a fixed 20-row ceiling or hiding all picker activity", () => {
  for (let rows = 1; rows <= 100; rows++) for (const picker of [true, false]) {
    const l = dockLayout(rows, 4, 5, true, picker, true);
    expect(l.editor + l.menu + l.extras + l.tail + l.picker).toBeLessThanOrEqual(Math.max(0, rows - 1));
    expect(Object.values(l).every(n => n >= 0)).toBe(true);
  }
  expect(dockLayout(50, 1, 3, false, false, true).tail).toBeGreaterThan(20);
  expect(dockLayout(24, 1, 0, false, true, true).tail).toBeGreaterThan(0);
});
