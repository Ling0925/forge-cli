import { expect, it } from "vitest";
import { createEventRenderer } from "../../src/cli/render/events";
import { toolActivity } from "../../src/shared/tool-activity";
import { agentEventSchema, type AgentEvent, type ApprovalRequest } from "../../src/shared/schemas";
import type { RichLine } from "../../src/cli/ui-contract";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = { sessionId: id, timestamp: "2026-01-01T00:00:00Z" };
const child = (status: "running" | "completed" | "failed", activity?: string): AgentEvent => ({ ...base, type: "agent_update", childSessionId: id, model: "flash", status, summary: "PRIVATE CHILD OUTPUT", ...(activity ? { currentTool: { name: "run_command", target: activity } } : {}) });
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(s => s.text).join("")).join("\n");
it("replaces child commands without appending logs or disrupting parent streaming", () => {
  const r = createEventRenderer({ width: () => 100 });
  r.push({ ...base, type: "text_delta", text: "Parent **draft**" });
  for (let i = 0; i < 50; i++) {
    const u = r.push(child("running", `command-${i}`));
    expect(u.append).toEqual([]); expect(text(u.tail)).toContain(`command-${i}`);
    expect(text(u.tail)).toContain("Parent"); expect(text(u.tail)).not.toContain("PRIVATE CHILD OUTPUT");
    if (i > 0) expect(text(u.tail)).not.toContain(`command-${i - 1} ·`);
    expect(u.tail.filter(line => text([line]).includes("Agent"))).toHaveLength(1);
  }
  const done = r.push(child("failed")); expect(text(done.append)).toContain("failed");
  expect(text(done.tail)).not.toContain("Agent"); expect(text(done.tail)).toContain("Parent");
  expect(r.push(child("failed")).append).toEqual([]);
  expect(text(r.finish().append)).toContain("Parent");
});
it("ignores child conversation drafts without corrupting parent Markdown", () => {
  const renderer = createEventRenderer();
  const before = renderer.push({ ...base, type: "text_delta", text: "Parent **draft**" });
  const progress = renderer.push({ ...base, type: "agent_progress", childSessionId: id,
    text: "child-only live reply", truncated: false, childTurn: 1, childStep: 1 });
  expect(progress.append).toEqual([]);
  expect(progress.tail).toEqual(before.tail);
  expect(text(renderer.finish().append)).not.toContain("child-only");
});
it("routes child approval into the current card and clears it at tool finish/cancel", () => {
  const r = createEventRenderer(); r.push(child("running"));
  const request: ApprovalRequest = { ...base, id, childSessionId: id, toolCallId: "t", toolName: "run_command", description: "do not print", command: ["node", "--token", "SECRET"] };
  const update = r.childApproval(request);
  expect(update.append).toEqual([]); expect(text(update.tail)).toContain("auto-approved");
  expect(text(update.tail)).not.toContain("SECRET"); expect(text(update.tail)).not.toContain("do not print");
  expect(text(r.push(child("running")).tail)).toContain("thinking");
  const stopped = r.push({ ...base, type: "state_changed", status: "cancelled" });
  expect(stopped.tail).toEqual([]); expect(text(stopped.append)).toContain("interrupted");
  expect(r.finish().append).toEqual([]);
});
it("bounds child cards and parses optional activity while omitting edit bodies", () => {
  const call = { id: "t", type: "function" as const, function: { name: "run_command", arguments: JSON.stringify({ argv: ["node", "--password", "SECRET"] }) } };
  expect(toolActivity(call).target).not.toContain("SECRET");
  expect(toolActivity({ ...call, function: { name: "edit_file", arguments: '{"path":"a.ts","new_text":"PRIVATE"}' } })).toEqual({ name: "edit_file", target: "a.ts" });
  expect(agentEventSchema.parse(child("running", "node"))).toMatchObject({ currentTool: { target: "node" } });
  const r = createEventRenderer({ width: () => 40 });
  for (let n = 0; n < 8; n++) r.push({ ...child("running"), childSessionId: `${n}aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` });
  expect(r.push({ ...base, type: "state_changed", status: "running" }).tail.length).toBeLessThanOrEqual(4);
});
