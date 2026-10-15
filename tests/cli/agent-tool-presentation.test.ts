import { describe, expect, it } from "vitest";
import { toolPresentation } from "../../src/cli/render/tool-presentation";
import { ToolTranscript } from "../../src/cli/render/tool-transcript";
import { toolSummaryLines } from "../../src/cli/render/tools";
import type { RichLine } from "../../src/cli/ui-contract";
import { visibleWidth } from "../../src/cli/theme";
import type { ToolCall, ToolResult } from "../../src/shared/schemas";

const result = (value: unknown, isError = false): ToolResult => ({ content: JSON.stringify(value), isError });
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(span => span.text).join("")).join("\n");
const call = (name: string): ToolCall => ({
  id: "tool-agent",
  type: "function",
  function: { name, arguments: JSON.stringify({ id: "child", task: "PRIVATE_TASK", message: "PRIVATE_MESSAGE", reason: "PRIVATE_REASON" }) },
});
const privateFields = {
  content: "PRIVATE_BODY",
  summary: "PRIVATE_SUMMARY",
  instruction: "PRIVATE_INSTRUCTION",
  ownership: "PRIVATE_OWNERSHIP",
  writePaths: ["PRIVATE_PATH"],
  resolution: "PRIVATE_RESOLUTION",
  reason: "PRIVATE_REASON",
};

const summaries: { name: string; payload: unknown; expected: string }[] = [
  { name: "spawn_agent", payload: { ...privateFields, childSessionId: "child", model: "model-a" }, expected: "Agent child · model-a" },
  { name: "wait_agents", payload: [{ ...privateFields, id: "child", status: "completed", active: false }], expected: "1 agents · 1 completed" },
  { name: "get_agent_result", payload: { ...privateFields, id: "child", status: "completed", model: "model-a", offset: 10, totalChars: 100, nextOffset: 22, truncated: true }, expected: "Agent child · completed · chars 11–22 / 100 total" },
  { name: "send_agent_message", payload: { ...privateFields, id: "child", queued: true, pendingMessages: 2 }, expected: "Agent child · message queued · 2 pending" },
  { name: "resolve_agent", payload: { ...privateFields, id: "child", status: "failed", handled: true }, expected: "Agent child · failed · handled" },
  { name: "cancel_agent", payload: { ...privateFields, id: "child", status: "cancelled" }, expected: "Agent child · cancelled" },
];

describe("agent tool presentation", () => {
  it("summarizes paginated lists without exposing ownership, paths or activity", () => {
    const payload = {
      agents: [
        { ...privateFields, id: "running", status: "running", model: "model-a", currentRun: "PRIVATE_RUN", active: true },
        { ...privateFields, id: "handled", status: "failed", model: "model-b", currentRun: null, active: false, handled: true },
        { ...privateFields, id: "done", status: "completed", model: "model-c", currentRun: null, active: false },
      ],
      total: 42,
      offset: 0,
      nextOffset: 3,
      truncated: true,
    };
    const presentation = toolPresentation("list_agents", result(payload));
    expect(presentation).toMatchObject({ detail: "3 agents / 42 total · 1 running · 1 failed (handled) · 1 completed", failed: false });
    expect(presentation.warning).toBe("truncated · next offset 3");
    const rendered = text(toolSummaryLines(call("list_agents"), result(payload), 160));
    expect(rendered).not.toContain("PRIVATE_");
    expect(rendered).not.toContain('{"');
    expect(toolPresentation("list_agents", result({ ...payload, agents: [], offset: 42, nextOffset: null, truncated: false })))
      .toMatchObject({ detail: "0 agents / 42 total", warning: "", failed: false });
  });

  it.each(["list_agents", "wait_agents"])("keeps legacy %s arrays compact", name => {
    expect(toolPresentation(name, result([
      { status: "running", active: true, summary: "PRIVATE_SUMMARY" },
      { status: "completed", active: false },
    ]))).toMatchObject({ detail: "2 agents · 1 running · 1 completed", warning: "", failed: false });
    expect(toolPresentation(name, result([])).detail).toBe("0 agents");
  });

  it.each(summaries)("renders $name metadata without default raw expansion", ({ name, payload, expected }) => {
    const tools = new ToolTranscript();
    const c = call(name);
    tools.start(c);
    const rows = tools.summary(c.id, result(payload), 160);
    const rendered = text(rows);
    expect(rendered).toContain(expected);
    expect(rendered).not.toContain("PRIVATE_");
    expect(rendered).not.toContain('{"');
    expect(rows.length).toBeLessThanOrEqual(3);
    // Full arguments and results remain available only through explicit /tools N.
    expect(text(tools.detail(1, 160))).toContain("PRIVATE_");
  });

  it("keeps top-level list errors visible without echoing their reason", () => {
    const presentation = toolPresentation("list_agents", result({ error: "PRIVATE_ERROR" }));
    expect(presentation.failed).toBe(true);
    expect(presentation.warning).toContain("agent failure");
    expect(presentation.detail).not.toContain("PRIVATE_");
  });

  it("shows result pagination, empty pages and truncated wait summaries without their text", () => {
    const page = { id: "child", status: "completed", model: "model-a", content: "PRIVATE_BODY", offset: 10, totalChars: 100, nextOffset: 22, truncated: true };
    expect(toolPresentation("get_agent_result", result(page)).warning).toBe("truncated · next offset 22");
    expect(toolPresentation("get_agent_result", result({ ...page, content: "", offset: 100, nextOffset: null, truncated: false })))
      .toMatchObject({ detail: "Agent child · completed · 0 chars read / 100 total", warning: "" });
    expect(toolPresentation("wait_agents", result([{ status: "running", active: true, summary: "PRIVATE_SUMMARY", truncated: true }])))
      .toMatchObject({ detail: "1 agents · 1 running", warning: "truncated", failed: false });
  });

  it.each(["list_agents", "wait_agents", "get_agent_result", "cancel_agent", "resolve_agent"])("recognizes unhandled failures in %s and clears handled warnings", name => {
    for (const failure of [{ status: "failed" }, { status: "completed", error: "PRIVATE_ERROR" }, { errors: [{ message: "PRIVATE_ERROR" }] }]) {
      const record = { ...privateFields, ...failure, id: "child", model: "model-a", offset: 0, totalChars: 12 };
      const payload = (handled?: boolean) => {
        const entry = { ...record, ...(handled === undefined ? {} : { handled }) };
        return name === "list_agents" ? { agents: [entry], total: 1 } : name === "wait_agents" ? [entry] : entry;
      };
      for (const handled of [undefined, false]) {
        const presentation = toolPresentation(name, result(payload(handled)));
        expect(presentation.failed).toBe(true);
        expect(presentation.warning).toContain("agent failure");
        expect(presentation.detail).not.toContain("PRIVATE_");
      }
      const handled = toolPresentation(name, result(payload(true)));
      expect(handled.failed).toBe(false);
      expect(handled.warning).not.toContain("agent failure");
      expect(toolSummaryLines(call(name), result(payload(true)), 160).flat().some(span => span.tone === "error")).toBe(false);
      expect(toolPresentation(name, result(payload(true), true))).toMatchObject({ failed: true, detail: "Agent tool failed · inspect details" });
    }
  });

  it.each(["get_agent_result", "send_agent_message", "resolve_agent"])("does not echo raw or error text for %s", name => {
    const cases = [
      { content: "PRIVATE_RAW", failure: false },
      { content: "{PRIVATE_MALFORMED", failure: false },
      { content: JSON.stringify({ error: "PRIVATE_ERROR", message: "PRIVATE_MESSAGE" }), failure: true },
      { content: JSON.stringify({ content: "PRIVATE_BODY".repeat(30000) }), failure: false },
    ];
    for (const { content, failure } of cases) {
      for (const isError of [false, true]) {
        const presentation = toolPresentation(name, { content, isError });
        expect(presentation.detail).not.toContain("PRIVATE_");
        expect(presentation.warning).not.toContain("PRIVATE_");
        expect(presentation.failed).toBe(isError || failure);
      }
    }
  });

  it("bounds new tool cards at narrow widths", () => {
    for (const { name, payload } of summaries.filter(item => ["get_agent_result", "send_agent_message", "resolve_agent"].includes(item.name))) {
      for (const width of [1, 8, 20, 40, 80]) {
        const rows = toolSummaryLines(call(name), result(payload), width);
        expect(rows.length).toBeLessThanOrEqual(3);
        for (const row of rows) expect(visibleWidth(text([row]))).toBeLessThanOrEqual(width);
        expect(text(rows)).not.toContain("PRIVATE_");
      }
    }
  });
});
