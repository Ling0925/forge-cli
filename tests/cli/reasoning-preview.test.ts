import { expect, it } from "vitest";
import { createEventRenderer } from "../../src/cli/render/events";
import type { AgentEvent } from "../../src/shared/schemas";

const event = (value: object) => value as AgentEvent;
const text = (lines: readonly (readonly { text: string }[])[]) =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

it("shows one live reasoning line that replaces itself as thinking streams", () => {
  const renderer = createEventRenderer({ width: () => 40 });
  expect(renderer.push(event({ type: "run_started" })).tail).toEqual([]);
  const first = renderer.push(event({ type: "reasoning_delta", text: "Reading the file" }));
  expect(first.tail).toHaveLength(1);
  expect(text(first.tail)).toContain("Reading the file");
  // A newer line replaces the previous one entirely (scrolling single-line view).
  const second = renderer.push(event({ type: "reasoning_delta", text: "\nNow checking the runtime" }));
  expect(second.tail).toHaveLength(1);
  expect(text(second.tail)).toContain("Now checking the runtime");
  expect(text(second.tail)).not.toContain("Reading the file");
});

it("clears the reasoning line once the answer or a tool call begins", () => {
  for (const next of [
    { type: "text_delta", text: "answer" },
    { type: "tool_started", call: { id: "c", type: "function", function: { name: "read_file", arguments: "{}" } } },
    { type: "run_finished", status: "completed", turns: 1, toolCalls: 0 },
  ] as const) {
    const renderer = createEventRenderer();
    renderer.push(event({ type: "run_started" }));
    renderer.push(event({ type: "reasoning_delta", text: "hidden thought" }));
    const update = renderer.push(event(next));
    expect(text(update.tail)).not.toContain("hidden thought");
  }
});

it("bounds the displayed reasoning to the current line and sanitizes controls", () => {
  const renderer = createEventRenderer({ width: () => 20 });
  renderer.push(event({ type: "run_started" }));
  const update = renderer.push(
    event({ type: "reasoning_delta", text: "line1\n\u001b[2Jline2 that is far too long to fit" }),
  );
  const shown = text(update.tail);
  expect(shown).not.toContain("\u001b");
  expect(shown).not.toContain("line1");
  expect(shown).toContain("line2");
});
