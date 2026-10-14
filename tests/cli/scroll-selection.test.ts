import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import { InputDecoder, type InputEvent } from "../../src/cli/terminal/decoder";
import { Screen, plain } from "../../src/cli/terminal/screen";
import { ScreenSelection } from "../../src/cli/terminal/selection";
import { createTheme } from "../../src/cli/theme";

function fixture() {
  const output = new PassThrough();
  let bytes = "";
  output.on("data", (chunk) => { bytes += chunk.toString(); });
  const dimensions = { columns: 40, rows: 8 };
  const screen = new Screen(output, () => dimensions, createTheme({ isTTY: true }));
  screen.enabled = screen.fixed = true;
  return { screen, dimensions, output: () => bytes, reset: () => { bytes = ""; } };
}
const mouse = (action: Extract<InputEvent, { kind: "mouse" }>["action"], row: number, column: number): Extract<InputEvent, { kind: "mouse" }> =>
  ({ kind: "mouse", action, row, column, shift: false });

describe("scrollable transcript and durable selection", () => {
  it("decodes fragmented SGR drag, release and wheel without inserting protocol text", () => {
    const events: InputEvent[] = [];
    const decoder = new InputDecoder((event) => events.push(event));
    try {
      for (const fragment of ["\x1b[<0;", "3;7M", "\x1b[<32;6;7M", "\x1b[<0;6;7m", "\x1b[<64;1;1M", "\x1b[<65;1;1M"])
        decoder.feed(fragment);
      expect(events).toEqual([mouse("press", 6, 2), mouse("drag", 6, 5), mouse("release", 6, 5), mouse("wheel-up", 0, 0), mouse("wheel-down", 0, 0)]);
      events.length = 0;
      decoder.feed("\x1b[200~\x1b[<0;1;1M\x1b[201~");
      expect(events).toEqual([]);
    } finally { decoder.dispose(); }
  });

  it("scrolls live output, anchors history through growth and tail commit, without repainting the dock", () => {
    const { screen, output, reset } = fixture();
    screen.append(Array.from({ length: 12 }, (_, i) => plain(`history ${i}`)));
    screen.setTranscript([plain("live 0"), plain("live 1")]);
    screen.paint([plain("❯ draft"), plain("status")], 0, 2);
    reset();
    screen.mouse(mouse("wheel-up", 0, 0));
    expect(output()).toContain("history 10");
    expect(output()).not.toContain("❯ draft");
    reset();
    screen.setTranscript([plain("live 0"), plain("live 1"), plain("live 2")]);
    screen.paint([plain("❯ draft"), plain("status")], 0, 2);
    expect(output()).toBe("");
    screen.append([plain("live 0"), plain("live 1"), plain("live 2")]);
    screen.setTranscript([]);
    screen.paint([plain("❯ draft"), plain("status")], 0, 2);
    expect(output()).toBe("");
    screen.scroll(-1000);
    expect(output()).toContain("live 2");
    expect(output()).not.toContain("❯ draft");
  });

  it("writes nothing for identical frames, including cursor escapes", () => {
    const { screen, output, reset } = fixture();
    screen.paint([plain("❯ draft")], 0, 2);
    reset();
    screen.paint([plain("❯ draft")], 0, 2);
    screen.scroll(-10);
    expect(output()).toBe("");
  });

  it("freezes input selection during asynchronous output and catches up after clearing", () => {
    const { screen, output, reset } = fixture();
    screen.paint([plain("❯ draft")], 0, 2);
    screen.mouse(mouse("press", 7, 2));
    screen.mouse(mouse("drag", 7, 6));
    screen.mouse(mouse("release", 7, 6));
    expect(screen.selectedText()).toBe("draft");
    expect(output()).toContain("\x1b[7m");
    reset();
    screen.append([plain("new message")]);
    screen.setTranscript([plain("streaming")]);
    screen.paint([plain("❯ draft"), plain("changed status")], 0, 2);
    expect(output()).toBe("");
    expect(screen.selectedText()).toBe("draft");
    screen.copySelection();
    expect(output()).toBe(`\x1b]52;c;${Buffer.from("draft").toString("base64")}\x07`);
    reset();
    screen.clearSelection();
    screen.paint([plain("❯ draft"), plain("changed status")], 0, 2);
    expect(output()).toContain("new message");
    expect(output()).toContain("streaming");
    expect(screen.hasSelection).toBe(false);
  });

  it("clears stale selection on resize and clamps coordinates", () => {
    const { screen, dimensions, output, reset } = fixture();
    screen.paint([plain("draft")], 0, 0);
    screen.mouse(mouse("press", 100, 100));
    screen.mouse(mouse("drag", 100, 0));
    dimensions.rows = 3;
    dimensions.columns = 8;
    reset();
    screen.invalidate();
    screen.paint([plain("draft")], 0, 0);
    expect(screen.hasSelection).toBe(false);
    expect(output()).toContain("\x1b[3;1H");
    expect(output()).not.toContain("\x1b[4;1H");
  });

  it("selects wide/combined graphemes and reversed multi-line ranges", () => {
    const selection = new ScreenSelection([plain("A中e\u0301🎉Z"), plain("second")], { row: 1, column: 2 });
    selection.focus = { row: 0, column: 2 };
    expect(selection.text()).toBe("中e\u0301🎉Z\nsec");
    expect(selection.highlight()[0]?.filter((span) => span.inverse).map((span) => span.text).join("")).toBe("中e\u0301🎉Z");
  });

  it("keeps the editor physical row stable across tail, status and context updates", () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    let bytes = "";
    output.on("data", (chunk) => { bytes += chunk.toString(); });
    const controller = new Controller(input, output, true, () => {}, () => {}, () => {}, async () => false);
    controller.screen.enabled = controller.screen.fixed = true;
    controller.prompt = "❯ ";
    controller.editor.insert("draft");
    controller.draw();
    const cursor = () => [...bytes.matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1)?.[0];
    const initial = cursor();
    controller.setTail(Array.from({ length: 30 }, (_, i) => plain(`live ${i}`)));
    expect(cursor()).toBe(initial);
    controller.setStatus({ label: "Working", startedAt: Date.now(), toolCount: 0, cancellable: true });
    expect(cursor()).toBe(initial);
    controller.setContext({ model: "test", usage: null });
    expect(cursor()).toBe(initial);
    controller.setTail([]);
    controller.setStatus(null);
    expect(cursor()).toBe(initial);
    const editorRow = Number(initial?.match(/\[(\d+);/)?.[1]) - 1;
    expect(editorRow).toBe(21);
    bytes = "";
    controller.handle(mouse("press", editorRow, 2));
    controller.handle(mouse("drag", editorRow, 6));
    controller.handle({ kind: "key", key: "interrupt", pasted: false });
    expect(bytes).toContain("\x1b]52;c;");
    controller.handle({ kind: "key", key: "escape", pasted: false });
    expect(controller.screen.hasSelection).toBe(false);
    expect(controller.editor.text).toBe("draft");
    controller.append(Array.from({ length: 30 }, (_, i) => plain(`HISTORY-${i}`)));
    controller.screen.scroll(20);
    controller.handle(mouse("press", 14, 2));
    controller.handle(mouse("drag", 14, 6));
    controller.append([plain("APPROVAL-CARD")]);
    bytes = "";
    controller.begin("Approve? [y/N] ", true);
    expect(controller.screen.hasSelection).toBe(false);
    expect(bytes).toContain("APPROVAL-CARD");
    expect(bytes).toContain("Approve? [y/N]");
    controller.end();
    expect(controller.editor.text).toBe("draft");
  });
});
