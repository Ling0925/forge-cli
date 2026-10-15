import { expect, it } from "vitest";
import { reasoningLine } from "../../src/cli/render/reasoning";
import { historyLines } from "../../src/cli/render/history";
import { sessionSnapshotSchema } from "../../src/shared/schemas";

const text = (lines: readonly (readonly { text: string }[])[]) =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

it("shows only the latest reasoning line, flattened and bounded to the width", () => {
  const line = reasoningLine("first thought\nsecond thought that is long", 60);
  expect(line).toBeDefined();
  const rendered = text([line!]);
  expect(rendered).toContain("✻");
  expect(rendered).toContain("second thought");
  expect(rendered).not.toContain("first thought");
  // A narrow width truncates with an explicit marker rather than wrapping.
  expect(text([reasoningLine("second thought", 8)!])).toContain("…");
  expect(reasoningLine("   \n  ", 40)).toBeUndefined();
});

it("restores persisted assistant reasoning in rebuilt CLI history", () => {
  const session = sessionSnapshotSchema.parse({
    version: 1,
    id: "12345678-1234-4234-8234-123456789abc",
    title: "resumed",
    workspace: "/workspace",
    model: "m",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    status: "completed",
    events: [],
    changes: [],
    messages: [
      { role: "user", content: "do it" },
      { role: "assistant", content: "done", reasoning: "checked the file first" },
    ],
  });
  const body = text(historyLines(session, 80));
  expect(body).toContain("✻ checked the file first");
  expect(body).toContain("done");
});
