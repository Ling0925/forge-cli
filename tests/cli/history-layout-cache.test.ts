import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as rich from "../../src/cli/render/rich";
import { SlashMenu } from "../../src/cli/slash-menu";
import { Editor } from "./legacy/editor";
import { Screen, plain } from "./legacy/screen";
import { draw, type View } from "./legacy/view";
import { createTheme } from "../../src/cli/theme";

function fixture() {
  const output = new PassThrough();
  let bytes = "";
  output.on("data", (chunk: Buffer) => { bytes += chunk.toString(); });
  const dimensions = { columns: 80, rows: 24 };
  const screen = new Screen(output, () => dimensions, createTheme({ isTTY: false }));
  screen.enabled = true;
  screen.fixed = true;
  return { screen, dimensions, output: () => bytes, reset: () => { bytes = ""; } };
}

afterEach(() => vi.restoreAllMocks());

describe("restored history layout cache", () => {
  it("does no transcript wrapping when typing, ticking status, or scrolling a long history", () => {
    const { screen, dimensions } = fixture();
    const wrap = vi.spyOn(rich, "wrapRichLines");
    screen.append(Array.from({ length: 4000 }, (_, i) => plain(`历史 ${i} 👩‍💻 ${"text ".repeat(12)}`)));
    const view: View = {
      ...dimensions, screen, picker: undefined, editor: new Editor(),
      prompt: "❯ ", fresh: false, menu: new SlashMenu(), status: null,
      tail: [plain("streaming tail")], filtered: () => [],
    };
    draw(view);
    wrap.mockClear();
    for (let i = 0; i < 30; i++) {
      view.editor.insert("字");
      draw(view);
    }
    view.status = { label: "Working", startedAt: Date.now(), toolCount: 0, cancellable: true };
    draw(view);
    screen.scroll(3);
    screen.scroll(-3);
    expect(wrap).not.toHaveBeenCalled();

    view.tail = [plain("updated tail")];
    draw(view);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(wrap.mock.calls[0]?.[0]).toBe(view.tail);
  });

  it("invalidates history on append and width changes, but not height-only resize", () => {
    const { screen, dimensions, output, reset } = fixture();
    const wrap = vi.spyOn(rich, "wrapRichLines");
    screen.append([plain("old history")]);
    screen.paint([plain("❯ ")], 0, 2);
    wrap.mockClear();
    screen.append([plain("new history")]);
    reset();
    screen.paint([plain("❯ ")], 0, 2);
    expect(wrap).toHaveBeenCalledTimes(1);
    expect(output()).toContain("new history");
    wrap.mockClear();
    dimensions.rows = 12;
    screen.invalidate();
    screen.paint([plain("❯ ")], 0, 2);
    expect(wrap).not.toHaveBeenCalled();
    dimensions.columns = 8;
    screen.invalidate();
    reset();
    screen.paint([plain("❯ ")], 0, 2);
    expect(wrap).toHaveBeenCalledTimes(2);
    expect(output()).toContain("new his");
    expect(output()).toContain("tory");
  });

  it("drops stale wrapped rows when the retained-history limit evicts content", () => {
    const { screen, output, reset } = fixture();
    screen.append([plain("EVICTED"), ...Array.from({ length: 3999 }, () => plain("kept"))]);
    screen.paint([plain("❯ ")], 0, 2);
    screen.append([plain("latest")]);
    screen.paint([plain("❯ ")], 0, 2);
    reset();
    screen.scroll(10000);
    expect(output()).not.toContain("EVICTED");
    expect(output()).toContain("kept");
  });
});
