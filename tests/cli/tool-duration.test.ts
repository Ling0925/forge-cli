import { expect, it } from "vitest";
import { formatDuration } from "../../src/cli/render/duration";
import { createEventRenderer } from "../../src/cli/render/events";
import { ToolTranscript } from "../../src/cli/render/tool-transcript";
import { historyLines } from "../../src/cli/render/history";
import { toolSummaryLines } from "../../src/cli/render/tools";
import { sessionSnapshotSchema, type AgentEvent, type ToolCall } from "../../src/shared/schemas";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(s => s.text).join("")).join("\n");
const call = (id: string, name = "read_file"): ToolCall => ({ id, type: "function", function: { name, arguments: '{"path":"a.ts"}' } });
const result = { content: '{"content":"1: a","offset":0,"total_lines":1}', isError: false };
const base = { sessionId: "12345678-1234-4234-8234-123456789abc", timestamp: "2026-01-01T00:00:00Z" };
it.each([[0,"0ms"],[999,"999ms"],[1000,"1s"],[1250,"1.2s"],[59999,"59.9s"],[60000,"1m"],[90000,"1.5m"],[3599999,"59.9m"],[3600000,"1h"],[5400000,"1.5h"],[86400000,"1d"],[129600000,"1.5d"],[-1,"?"],[NaN,"?"],[Infinity,"?"]])("formats %s as %s", (ms, expected) => {
  expect(formatDuration(Number(ms))).toBe(expected);
});
it("times concurrent tools independently and freezes completed list/detail duration", () => {
  let now = 0; const tools = new ToolTranscript();
  const renderer = createEventRenderer({ now: () => now, tools, width: () => 120 });
  const a = call("a"), b = call("b");
  renderer.push({ ...base, type: "tool_started", call: a });
  now = 1000; renderer.push({ ...base, type: "tool_started", call: b });
  // Duplicate start must not reset a's clock.
  renderer.push({ ...base, type: "tool_started", call: a });
  now = 1250;
  expect(text(renderer.push({ ...base, type: "tool_finished", toolCallId: "a", result }).append)).toContain("1.2s");
  expect(text(renderer.push({ ...base, type: "tool_finished", toolCallId: "b", result }).append)).toContain("250ms");
  now = 999999;
  expect(text(tools.list(120))).toContain("250ms"); expect(text(tools.detail(1, 120))).toContain("1.2s");
  expect(text(tools.summary("a", result, 120, now))).toContain("1.2s");
});
it("restores event timing, falls back to command duration, and omits missing timing", () => {
  const c = call("a");
  const events: AgentEvent[] = [{ ...base, type: "tool_started", call: c }, { ...base, type: "tool_finished", toolCallId: "a", result, timestamp: "2026-01-01T00:02:30Z" }];
  const s = sessionSnapshotSchema.parse({ version: 1, id: base.sessionId, title: "test", workspace: "/workspace", model: "test", createdAt: base.timestamp, updatedAt: base.timestamp, status: "idle", events, changes: [], messages: [{ role: "assistant", content: null, tool_calls: [c] }, { role: "tool", tool_call_id: "a", content: JSON.stringify(result) }] });
  expect(text(historyLines(s, 120))).toContain("2.5m");
  expect(text(historyLines({ ...s, events: [] }, 120))).not.toContain("0ms");
  const cmd = { content: '{"exit_code":0,"duration_ms":90000}', isError: false };
  expect(text(toolSummaryLines(call("cmd", "run_command"), cmd, 120))).toContain("1.5m");
  expect(text(toolSummaryLines(call("other", "mcp__x__y"), cmd, 120))).not.toContain("1.5m");
});
