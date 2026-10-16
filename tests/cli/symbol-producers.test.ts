import { afterEach, describe, expect, it, vi } from "vitest";
import { autoApprovalLines } from "../../src/cli/render/auto-approval";
import { createEventRenderer } from "../../src/cli/render/events";
import { historyLines } from "../../src/cli/render/history";
import { markdownLines } from "../../src/cli/render/markdown";
import { reasoningLine } from "../../src/cli/render/reasoning";
import { toolRunningLine, toolSummaryLines, toolFinishLines } from "../../src/cli/render/tools";
import { planLines } from "../../src/cli/format";
import { stringWidth } from "../../src/cli/render/width";
import { sessionSnapshotSchema, type ApprovalRequest, type ToolCall, type ToolResult } from "../../src/shared/schemas";
import type { RichLine } from "../../src/cli/ui-contract";

const text = (rows: readonly RichLine[]) => rows.map(row => row.map(s => s.text).join("")).join("\n");
const id = "12345678-1234-4234-8234-123456789abc";
const base = { sessionId: id, timestamp: "2026-01-01T00:00:00Z" };
const original = "中文 ❯ ✔ ─ 👩‍💻";
const call: ToolCall = { id: "t", type: "function", function: { name: "run_command", arguments: JSON.stringify({ argv: ["echo", original] }) } };
const result: ToolResult = { content: JSON.stringify({ stdout: original, stderr: "", exit_code: 0, duration_ms: 1000 }), isError: false };
afterEach(() => vi.unstubAllEnvs());

describe("UI-owned producer symbols", () => {
  it("keeps tool arguments/results intact while falling back branches and animation", () => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    expect(toolRunningLine(call)[0]).toMatchObject({ text: "|", animation: "spinner" });
    const summary = text(toolSummaryLines(call, result, 120));
    expect(summary).toContain(original);
    expect(summary).toContain("| done | exit 0 | 1s");
    expect(summary).toContain("  + ");
    expect(text(toolFinishLines(call, result, 120, true))).toContain(original);
    const request: ApprovalRequest = { ...base, id, childSessionId: id, toolCallId: "t", toolName: "run_command", description: "", command: ["echo", original] };
    const approval = text(autoApprovalLines(request, 120));
    expect(approval).toContain("Auto-approved | run_command");
    expect(approval).toContain("  | child"); expect(approval).toContain("  + echo");
    expect(approval).toContain(original);
    vi.stubEnv("FORGE_SYMBOLS", "unicode");
    expect(text(toolSummaryLines(call, result, 120))).toContain("  ╰ ");
  });

  it("falls back plans, history, reasoning and child cards but preserves prose", () => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    const plan = text(planLines({ explanation: "", steps: [{ step: original, status: "completed" }] }, 120));
    expect(plan).toContain(`+ 1. ${original}`);
    expect(text([reasoningLine(original, 120)!])).toBe(`* ${original}`);
    const session = sessionSnapshotSchema.parse({ version: 1, id, title: "resumed", workspace: "/workspace", model: "m",
      createdAt: base.timestamp, updatedAt: base.timestamp, status: "completed", events: [], changes: [],
      messages: [{ role: "user", content: original }, { role: "assistant", content: "done", reasoning: original }] });
    const history = text(historyLines(session, 120));
    expect(history).toContain("> You"); expect(history).toContain(original); expect(history).toContain(`* ${original}`);
    const renderer = createEventRenderer({ width: () => 120, expandReasoning: true });
    const child = renderer.push({ ...base, type: "agent_update", childSessionId: id, model: "m", status: "running", summary: "" });
    expect(text(child.tail)).toContain(" | Agent");
    expect(text(renderer.push({ ...base, type: "reasoning_delta", text: original }).append)).toContain(`* ${original}`);
  });

  it("uses compatible Markdown decorations and cache keys without rewriting code or table cells", () => {
    const source = `---\n\n\`\`\`text\n${original}\n\`\`\`\n\n| header |\n| --- |\n| ${original} |`;
    vi.stubEnv("FORGE_SYMBOLS", "unicode");
    const rich = text(markdownLines(source, 100));
    expect(rich).toContain("── text ──");
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    const compatible = text(markdownLines(source, 100));
    expect(compatible).toContain("-- text --");
    expect(compatible).toContain(`  header: ${original}`);
    expect(compatible).toContain(`  ${original}`);
    expect(compatible).not.toContain("── text ──");
    const plain = text(markdownLines("---\n\n- [x] done\n\n| a | b |\n| --- | --- |\n| c | d |", 80));
    expect(plain).not.toMatch(/[^\x00-\x7f]/);
  });

  it.each([8, 20, 40])("chooses fallback before truncating tool rows to %s cells", width => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    const rows = toolSummaryLines(call, result, width);
    expect(rows.every(row => stringWidth(text([row])) <= width)).toBe(true);
  });
});
