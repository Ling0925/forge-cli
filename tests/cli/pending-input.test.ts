import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { RunQueue } from "../../src/cli/interactive/run-queue";
import { Controller } from "./legacy/controller";
import { TerminalReader } from "./legacy/reader";
import { visibleWidth } from "../../src/cli/theme";

const text = (lines: readonly (readonly { text: string }[])[]) => lines.map(line => line.map(s => s.text).join(""));

describe("pending input dock", () => {
  it("separates steering from follow-ups and retains paused previews", () => {
    const queue = new RunQueue();
    queue.add("follow-up", "later task");
    queue.add("steer", "change direction");
    expect(queue.preview().join("\n")).toContain("Steer (1)");
    expect(queue.preview().join("\n")).toContain("change direction");
    expect(queue.preview().join("\n")).toContain("Queue (1)");
    expect(queue.preview().join("\n")).toContain("later task");
    expect(queue.drainSteering()).toEqual(["change direction"]);
    expect(queue.preview().join("\n")).not.toContain("Steer");
    queue.finish(false);
    expect(queue.preview().join("\n")).toContain("paused");
    queue.clear();
    expect(queue.preview()).toEqual([]);
  });

  it("pins previews while typing, streaming, scrolling and resizing; hides them for consent", async () => {
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const controller = new Controller(new PassThrough(), output, true, () => {}, () => {}, () => {}, async () => false);
    controller.screen.enabled = true;
    controller.screen.fixed = true;
    const paint = vi.spyOn(controller.screen, "paint");
    controller.begin("❯ ", false);
    controller.editor.insert("draft");
    controller.setPendingInput(["Steer (1) · waiting: change direction", "Queue (1): later task"]);
    for (let index = 0; index < 20; index++) {
      controller.append([[{ text: `output ${index}` }]]);
      controller.setTail([[{ text: `stream ${index}` }]]);
    }
    controller.screen.scroll(5);
    controller.draw();
    let [lines, row] = paint.mock.calls.at(-1)!;
    expect(text(lines).join("\n")).toContain("change direction");
    expect(text(lines).join("\n")).toContain("later task");
    expect(text(lines)[row]).toContain("draft");
    for (const rows of [10, 5, 3, 2]) {
      output.rows = rows;
      output.columns = 24;
      controller.resize();
      await new Promise(resolve => setTimeout(resolve, 25));
      [lines, row] = paint.mock.calls.at(-1)!;
      expect(lines.length).toBeLessThanOrEqual(rows - 1);
      expect(text(lines)[row]).toContain("draft");
      expect(text(lines).every(line => visibleWidth(line) <= 24)).toBe(true);
    }
    output.rows = 24;
    output.columns = 80;
    controller.begin("Approve? ", true);
    expect(text(paint.mock.calls.at(-1)![0]).join("\n")).not.toContain("Steer");
    controller.end();
    expect(text(paint.mock.calls.at(-1)![0]).join("\n")).toContain("change direction");
    controller.setPendingInput([]);
    expect(text(paint.mock.calls.at(-1)![0]).join("\n")).not.toContain("Queue");
    controller.dispose();
  });

  it("exposes the dock through TerminalUI", async () => {
    const input = Object.assign(new PassThrough(), { setRawMode: () => input });
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    let bytes = "";
    output.on("data", chunk => { bytes += String(chunk); });
    const reader = new TerminalReader({ input, output, isTTY: true });
    try {
      await reader.ui.configure({ theme: "dark" });
      expect(reader.ui.setPendingInput).toBeTypeOf("function");
      reader.ui.setPendingInput!(["Queue (1): visible task"]);
      expect(bytes).toContain("visible task");
    } finally { reader.dispose(); }
  });
});
