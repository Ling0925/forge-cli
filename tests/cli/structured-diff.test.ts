import { expect, it } from "vitest";
import type { FileChange, ToolCall } from "../../src/shared/schemas";
import { createDiffPatch } from "../../src/shared/diff";
import { fileChangeSchema, parseSessionId, sessionSnapshotSchema } from "../../src/shared/schemas";
import { createEventRenderer } from "../../src/cli/render/events";
import { historyLines } from "../../src/cli/render/history";
import { diffLines, diffStats } from "../../src/cli/render/diff";
import { toolFinishLines, toolSummaryLines } from "../../src/cli/render/tools";
import { stringWidth } from "../../src/cli/render/width";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(span => span.text).join("")).join("\n");
const change = (before: string | null, after: string, kind: FileChange["kind"] = "modified"): FileChange => ({
  path: "a.ts", kind, patch: createDiffPatch(before ?? "", after),
});
const call: ToolCall = { id: "write-1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"DO_NOT_INVENT"}' } };

it("uses the recorded patch consistently for live events and restored history", () => {
  const base = { sessionId: parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), timestamp: "2026-01-01T00:00:00Z" };
  const result = { content: '{"written":true}', isError: false, changes: [
    change("old captured\n", "new captured\n"),
  ] };
  const renderer = createEventRenderer({ width: () => 80 });
  renderer.push({ ...base, type: "tool_started", call });
  const live = text(renderer.push({ ...base, type: "tool_finished", toolCallId: call.id, result }).append);
  const stored = sessionSnapshotSchema.parse({ version: 1, id: base.sessionId, title: "saved", workspace: "/unused", model: "test",
    createdAt: base.timestamp, updatedAt: base.timestamp, status: "completed", events: [], changes: result.changes,
    messages: [{ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) }] });
  const history = text(historyLines(stored, 80));
  for (const output of [live, history]) {
    expect(output).toContain("1 - old captured"); expect(output).toContain("1 + new captured");
    expect(output).not.toContain("unrelated prefix");
  }
});

it("shows creation (including an empty file) and overwrite from real write changes", () => {
  for (const item of [change(null, "one\ntwo\n", "created"), change("old\n", "new\n")]) {
    const output = text(toolSummaryLines(call, { content: '{"written":true}', isError: false, changes: [item] }));
    expect(output).toContain(item.kind === "created" ? "[+2 -0]" : "[+1 -1]");
    expect(output).toContain(item.kind === "created" ? "2   two" : "1 - old");
    expect(output).toContain(item.kind === "created" ? "1   one" : "1 + new");
  }
  expect(text(diffLines(change(null, "", "created")))).toContain("empty file created");
  const noChanges = text(toolSummaryLines(call, { content: '{"written":true}', isError: false }));
  expect(noChanges).not.toContain("DO_NOT_INVENT");
  expect(noChanges).not.toContain("[+0");
});

it("keeps the complete patch for a late edit far beyond any preview window", () => {
  const before = Array.from({ length: 1800 }, (_, i) => `line ${i}\n`).join("");
  const after = before.replace("line 1700\n", "changed late\n");
  const item = change(before, after);
  expect(diffStats(item)).toEqual({ added: 1, removed: 1 });
  expect(text(diffLines(item))).toContain("1701 - line 1700");
  expect(text(diffLines(item))).toContain("1701 + changed late");
});

it("migrates legacy before/after previews into a patch and never reports unknown as zero", () => {
  // Legacy records carried bounded before/after previews plus a truncated flag.
  const legacy = { path: "a.ts", kind: "modified", before: "old\n", after: "new\n", truncated: false };
  const migrated = fileChangeSchema.parse(legacy);
  expect(migrated).not.toHaveProperty("before");
  expect(diffStats(migrated)).toEqual({ added: 1, removed: 1 });
  expect(text(diffLines(migrated))).toContain("1 + new");
  // A truncated legacy preview cannot yield an exact diff; label it unavailable.
  const partial = fileChangeSchema.parse({ ...legacy, truncated: true });
  expect(diffStats(partial)).toBeNull();
  expect(text(diffLines(partial))).toContain("exact diff unavailable");
  expect(text(diffLines(partial))).not.toContain("[+0");
  // A record with no patch at all is unknown, not zero.
  const missing = fileChangeSchema.parse({ path: "a.ts", kind: "modified" });
  expect(diffStats(missing)).toBeNull();
});

it("keeps a chronological prefix under row budgets, not a later green line", () => {
  const item = change(Array.from({ length: 30 }, (_, i) => `old ${i}\n`).join(""), "addition at end\n");
  const rows = diffLines(item, { maxRows: 8 });
  expect(rows).toHaveLength(8);
  expect(text(rows)).toContain("1 - old 0");
  expect(text(rows)).not.toContain("+ addition at end");
  expect(text(rows)).toContain("omitted");
  const result = { content: '{"written":true}', isError: false, changes: [item] };
  const summary = toolSummaryLines(call, result);
  const detail = toolFinishLines(call, result, 80, true);
  expect(summary.length).toBeLessThanOrEqual(24);
  expect(detail.length).toBeGreaterThan(24);
  expect(text(detail)).toContain("+ addition at end");
});

it("preserves whitespace and grapheme clusters while soft-wrapping long lines", () => {
  const source = "  ab  👩‍💻é中文  ".repeat(8);
  const item = change(null, `${source}\n`, "created");
  for (const width of [1, 2, 4, 8, 17, 40]) {
    const rows = diffLines(item, { width, maxRows: 12 });
    expect(rows.length).toBeLessThanOrEqual(12);
    for (const row of rows) expect(stringWidth(text([row]))).toBeLessThanOrEqual(width);
    expect(text(rows)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
  const rows = diffLines(item, { width: 17, maxRows: 200 }).slice(1);
  // Every source row has the same four-cell gutter, including continuations.
  expect(rows.map(row => text([row]).slice(4)).join("")).toBe(source);
});

it("uses semantic line and word emphasis without changing text or embedding ANSI", () => {
  const rows = diffLines(change("const value = oldName;\n", "const value = newName;\n"));
  expect(rows.flat().some(span => span.tone === "diffRemovedWord" && span.text === "old")).toBe(true);
  expect(rows.flat().some(span => span.tone === "diffAddedWord" && span.text === "new")).toBe(true);
  expect(text(rows)).toContain("1 - const value = oldName;");
  expect(text(rows)).toContain("1 + const value = newName;");
  expect(text(rows)).not.toContain("\x1b");
});

it("compares raw tabs/CR/final newlines and marks their display differences", () => {
  const item = change("\tsame\r\n", "    same");
  expect(diffStats(item)).toEqual({ added: 1, removed: 1 });
  const output = text(diffLines(item));
  expect(output).toContain("-     same ⟪CR⟫");
  expect(output).toContain("+     same ⟪no final newline⟫");
  expect(output).not.toContain("\t");
});

it("filters complete terminal-control sequences across style segments and offers expansion", () => {
  const item = change("const a = 1;\n", "const a = 2;\u001b]52;c;PRIVATE_PAYLOAD\u0007\u001b[31m\n");
  const rendered = text(diffLines(item));
  expect(rendered).not.toContain("PRIVATE_PAYLOAD");
  expect(rendered).not.toContain("[31m");
  expect(rendered).not.toContain("\u001b");
  const long = change(null, "line\n".repeat(100), "created");
  const summary = toolSummaryLines(call, { content: '{"written":true}', isError: false, changes: [long] }, 80, 7);
  expect(text(summary)).toContain("/tools 7");
});

it("shows exact totals and a clear omission notice for truncated patches", () => {
  const item = change(null, "new\n".repeat(600), "created");
  expect(item.patch?.status).toBe("truncated");
  expect(diffStats(item)).toEqual({ added: 600, removed: 0 });
  const output = text(diffLines(item, { maxRows: 700 }));
  expect(output).toContain("new file · 600 lines");
  expect(output).toContain("patch truncated");
  const short = text(diffLines(item, { maxRows: 5 }));
  expect(short).toContain("patch also truncated");
});
