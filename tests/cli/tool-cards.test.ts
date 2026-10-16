import { expect, it } from "vitest";
import { toolPresentation, savedToolResult } from "../../src/cli/render/tool-presentation";
import { toolSummaryLines } from "../../src/cli/render/tools";
import { ToolTranscript } from "../../src/cli/render/tool-transcript";
import { historyLines } from "../../src/cli/render/history";
import { sessionSnapshotSchema, type ToolCall } from "../../src/shared/schemas";
import { createDiffPatch } from "../../src/shared/diff";
import { visibleWidth } from "../../src/cli/theme";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(s => s.text).join("")).join("\n");
const result = (value: unknown, isError = false) => ({ content: JSON.stringify(value), isError });
const call = (name: string): ToolCall => ({ id: "tool-1", type: "function", function: { name, arguments: '{"path":"src/a.ts"}' } });
it.each([
  ["read_file", { content: "1: SECRET_BODY\n2: next", offset: 0, total_lines: 20 }, "lines 1–2 / 20 total"],
  ["list_files", { entries: [{ path: "src/a.ts", kind: "file" }] }, "1 entries"],
  ["search_files", { matches: [{ path: "a.ts", line: 42, excerpt: "BIG_BODY" }] }, "a.ts:42"],
  ["write_file", { written: true }, "File written"],
  ["write_file", { written: false, unchanged: true }, "No changes · content already matches"],
  ["edit_file", { edited: false, unchanged: true, replacements: 0 }, "No changes · replacement already matches"],
  ["edit_file", { edited: true, replacements: 2 }, "2 replacements"],
  ["make_directory", { created: true }, "Directory ready"],
  ["git_status", { output: " M a.ts\n?? b.ts" }, "2 visible status entries"],
  ["git_diff", { output: "diff --git a/a b/a\n--- a/a\n+++ b/a\n-old\n+new", truncated: true }, "+1 −1 (partial preview)"],
  ["git_log", { output: "abc123 fix test\ndef456 feature" }, "2 commits"],
  ["project_context", { sources: [{ path: "AGENTS.md", body: "SECRET_BODY" }] }, "1 instruction sources"],
  ["load_skill", { name: "Review", sourceDirectory: "skills/review", body: "SECRET_BODY" }, "Review"],
  ["list_models", { ids: ["model-a"], total: 100 }, "1 models / 100 total"],
  ["update_plan", { steps: [{ step: "Review", status: "in_progress" }] }, "Plan 0/1"],
  ["spawn_agent", { childSessionId: "child", model: "flash" }, "Agent child · flash"],
  ["list_agents", [{ status: "running" }], "1 running"],
  ["wait_agents", [{ status: "completed", summary: "SECRET_BODY" }], "1 completed"],
  ["cancel_agent", { id: "child", status: "cancelled" }, "cancelled"],
  ["mcp_list_tools", { server: "local", tools: [{ name: "x" }] }, "1 tools"],
  ["browser_navigate", { navigated: true }, "Page navigated"],
  ["browser_read", { text: "Page text" }, "9 text characters"],
  ["browser_click", { completed: true }, "Browser action completed"],
  ["browser_fill", { completed: true }, "Browser action completed"],
  ["browser_close", { closed: true }, "Browser closed"],
  ["browser_screenshot", { artifact: "shot.png", bytes: 123, width: 1280, height: 720 }, "shot.png · 123 bytes"],
])("renders %s from its declared fields without dumping JSON", (name, payload, expected) => {
  const rendered = text(toolSummaryLines(call(String(name)), result(payload), 120, 1));
  expect(rendered).toContain(expected);
  expect(rendered).not.toContain("SECRET_BODY"); expect(rendered).not.toContain("BIG_BODY");
  expect(rendered).not.toContain('{"'); expect(rendered).not.toContain("/tools 1");
});
it("shows real edit diffs inline with bounded rows and preserves detail access", () => {
  const edited = { ...result({ edited: true, replacements: 1 }), changes: [{ path: "a.ts", kind: "modified" as const, patch: createDiffPatch("const old = 1;", "const next = 2;") }] };
  const tools = new ToolTranscript(); const c = call("edit_file"); tools.start(c);
  const rows = tools.summary(c.id, edited, 80);
  expect(text(rows)).toContain("[+1 -1]");
  expect(text(rows)).toContain("1 - const old = 1;"); expect(text(rows)).toContain("1 + const next = 2;");
  expect(rows.flat().some(s => s.tone === "diffAdded")).toBe(true);
  expect(text(rows)).not.toContain("details:");
  expect(text(tools.detail(1, 80))).toContain("1 + const next = 2;");
  const large = { ...edited, changes: [{ path: "a.ts", kind: "modified" as const, patch: createDiffPatch("old\n".repeat(200), ("长".repeat(100) + "\n").repeat(200)) }] };
  const bounded = tools.summary(c.id, large, 40);
  // Header + detail + at most 20 diff rows + the indexed /tools hint.
  expect(bounded.length).toBeLessThanOrEqual(23);
  // The narrow card clips the combined row/patch omission notice; /tools keeps it in full.
  expect(text(bounded)).toContain("more diff content omitted");
  expect(text(bounded)).toContain("/tools 1");
  expect(text(tools.detail(1, 120))).toContain("patch also truncated");
  for (const row of bounded) expect(visibleWidth(text([row]))).toBeLessThanOrEqual(40);
  expect(text(toolSummaryLines(call("write_file"), edited, 80))).toContain("1 + const next = 2;");
  expect(text(toolSummaryLines(c, { ...edited, changes: [{ path: "a.ts", kind: "modified" as const }] }, 80))).toContain("unavailable");
});
it("keeps errors, timeout, truncation and pagination visible", () => {
  const command = toolPresentation("run_command", result({ stdout: "ok", stderr: "broken", exit_code: null, timed_out: true, duration_ms: 100, truncated: true }));
  expect(command).toMatchObject({ failed: true, detail: "broken" });
  expect(command.warning).toContain("timed out"); expect(command.warning).toContain("truncated");
  expect(toolPresentation("read_file", result({ error: "denied" }, true))).toMatchObject({ failed: true, detail: "denied" });
  expect(toolPresentation("list_models", result({ ids: [], total: 20, nextOffset: 5, truncated: true })).warning).toContain("next offset 5");
  expect(toolPresentation("wait_agents", result([{ status: "failed", errors: [{ error: "offline" }] }])).failed).toBe(true);
});
it("bounds physical rows and sanitizes hostile values", () => {
  for (const width of [1, 8, 20, 40, 80]) {
    const rows = toolSummaryLines(call("run_command"), result({ stdout: "中文😀".repeat(1000) + "\x1b]52;c;evil\x07", exit_code: 1 }), width, 1);
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const row of rows) expect(visibleWidth(text([row]))).toBeLessThanOrEqual(width);
    expect(text(rows)).not.toContain("\x1b");
  }
});
it("restores saved error envelopes and preserves expanded data without rerunning", () => {
  const tools = new ToolTranscript(); const c = call("project_context");
  const original = result({ sources: [{ path: "AGENTS.md", body: "FULL_DETAIL" }] });
  tools.start(c); tools.summary(c.id, original, 80);
  expect(text(tools.detail(1, 80))).toContain("FULL_DETAIL");
  const failure = result({ error: "access denied" }, true);
  expect(savedToolResult(JSON.stringify(failure))).toEqual(failure);
  const s = sessionSnapshotSchema.parse({ version: 1, id: "12345678-1234-4234-8234-123456789abc", title: "test", workspace: "/workspace", model: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "idle", events: [], changes: [], messages: [{ role: "assistant", content: null, tool_calls: [c] }, { role: "tool", tool_call_id: c.id, content: JSON.stringify(failure) }] });
  const body = text(historyLines(s, 80)); expect(body).toContain("failed"); expect(body).toContain("access denied");
  expect(body).not.toContain("/tools 1");
});
it("uses correct tree branching prefix for single detail and warning lines", () => {
  const c = call("read_file");
  // Without warning: detail ends the branch with ╰
  const single = toolSummaryLines(c, result({ content: "test", offset: 0, total_lines: 10 }), 80);
  expect(text(single)).toContain("  ╰ lines 1–1 / 10 total");
  expect(text(single)).not.toContain("  │");

  // With warning: detail continues with │ and warning closes with ╰
  const withWarn = toolSummaryLines(c, result({ content: "test", offset: 0, total_lines: 10, truncated: true }), 80);
  expect(text(withWarn)).toContain("  │ lines 1–1 / 10 total");
  expect(text(withWarn)).toContain("  ╰ truncated");
});
