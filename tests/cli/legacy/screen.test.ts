import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createTheme } from "../../../src/cli/theme";
import type { RichLine } from "../../../src/cli/ui-contract";
import { Screen, plain } from "./screen";

class Output extends PassThrough {
  columns = 20;
  rows = 6;
}

function fixture() {
  const output = new Output();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  const screen = new Screen(
    output,
    () => ({ columns: output.columns, rows: output.rows }),
    createTheme({ isTTY: false }),
  );
  screen.enabled = true;
  const text = () => chunks.join("");
  const since = (index: number) => chunks.slice(index).join("");
  return { chunks, output, screen, since, text };
}

const line = (text: string): RichLine => [{ text }];
const clearCount = (text: string): number => text.split("\x1b[2K").length - 1;
const destructiveSequences = ["\x1b[2J", "\x1b[3J", "\x1b[?1049h"];
const expectNoDestructiveSequences = (text: string): void => {
  for (const sequence of destructiveSequences)
    expect(text).not.toContain(sequence);
};

describe("Screen incremental paint", () => {
  it("does not write anything for an identical frame and cursor", () => {
    const f = fixture();
    const frame = [plain("one"), plain("two")];

    f.screen.paint(frame, 1, 2);
    const afterFirstText = f.text();
    const afterFirstChunks = f.chunks.length;
    f.screen.paint(frame, 1, 2);

    expect(f.text()).toBe(afterFirstText);
    expect(f.chunks).toHaveLength(afterFirstChunks);
  });

  it("updates only changed rows when frame height is stable", () => {
    const f = fixture();
    f.screen.paint([plain("one"), plain("two"), plain("three")], 2, 0);
    const before = f.chunks.length;

    f.screen.paint([plain("one"), plain("TWO"), plain("three")], 2, 0);
    const update = f.since(before);

    expect(update).toContain("\x1b[2K");
    expect(update).toContain("TWO");
    expect(update).not.toContain("one");
    expect(update).not.toContain("three");
    expect(clearCount(update)).toBe(1);
  });

  it("moves the cursor without repainting text for cursor-only updates", () => {
    const f = fixture();
    const frame = [plain("one"), plain("two")];
    f.screen.paint(frame, 0, 1);
    const before = f.chunks.length;

    f.screen.paint(frame, 1, 3);

    expect(f.since(before)).toBe("\r\x1b[1B\x1b[4G");
  });

  it("handles height changes conservatively without display erases or scrollback rewrites", () => {
    const f = fixture();
    f.screen.append([plain("permanent scrollback")]);
    f.screen.paint([plain("draft"), plain("tail"), plain("status")], 1, 0);
    f.output.rows = 3;
    const before = f.chunks.length;

    f.screen.paint([plain("draft"), plain("tail"), plain("status")], 1, 0);
    const resize = f.since(before);

    expect(resize).toContain("draft");
    expect(resize).toContain("tail");
    expect(resize).not.toContain("status");
    expect(resize).not.toContain("permanent scrollback");
    expectNoDestructiveSequences(resize);
  });

  it("uses grapheme widths during resize invalidation for CJK and emoji rows", () => {
    const f = fixture();
    f.output.columns = 8;
    f.screen.paint([plain("中👩‍💻abcd"), plain("cursor")], 1, 0);
    f.output.columns = 4;
    const before = f.chunks.length;

    f.screen.invalidate();
    const clear = f.since(before);

    expect(clear).toContain("\r\x1b[2A");
    expect(clearCount(clear)).toBe(3);
    expectNoDestructiveSequences(clear);
  });

  it("sanitizes untrusted ANSI in full and incremental paints", () => {
    const f = fixture();

    f.screen.paint([line("safe \x1b[2J text")], 0, 0);
    expect(f.text()).toContain("safe  text");
    expect(f.text()).not.toContain("\x1b[2J");

    const before = f.chunks.length;
    f.screen.paint([line("updated \x1b[3J text")], 0, 0);
    const update = f.since(before);

    expect(update).toContain("updated  text");
    expect(update).not.toContain("\x1b[3J");
  });
});
