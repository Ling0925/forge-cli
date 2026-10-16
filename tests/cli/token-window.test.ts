import { describe, expect, it } from "vitest";
import { estimateTokens, measureContext, reportedContext, resolveContextWindow } from "../../src/shared/context-usage";
import { agentEventSchema } from "../../src/shared/schemas";
import { contextFooter } from "../../src/cli/terminal/context-footer";

describe("token window accounting", () => {
  it("uses per-model overrides then metadata then exact known IDs; unknown stays unknown", () => {
    expect(resolveContextWindow("alias", { modelContextWindows: { alias: 64000 } }, 128000)).toBe(64000);
    expect(resolveContextWindow("gpt-4o", {}, 32000)).toBe(32000);
    expect(resolveContextWindow("gpt-4o", {})).toBe(128000);
    expect(resolveContextWindow("alias/gpt-4o", {})).toBeNull();
    expect(resolveContextWindow("alias", { modelContextWindows: { alias: null } })).toBeNull();
  });
  it("estimates CJK differently and includes tool schemas without local metadata", () => {
    expect(estimateTokens("你好世界")).toBe(4);
    expect(estimateTokens("abcdefgh")).toBe(2);
    const base = measureContext([{ role: "user", content: "你好" }], 128000);
    const tools = measureContext([{ role: "user", content: "你好" }], 128000, [{ type: "function", function: { name: "test", description: "tool", parameters: {} } }]);
    expect(tools.usedTokens).toBeGreaterThan(base.usedTokens);
    expect(tools.parts.tools).toBeGreaterThan(0);
  });
  it("calibrates to this request's input including cache hits, not accumulated billing usage", () => {
    const projection = measureContext([{ role: "system", content: "rules" }, { role: "user", content: "hello" }], 128000);
    const reported = reportedContext(projection, { promptTokens: 5000, cachedPromptTokens: 4500, completionTokens: 200, totalTokens: 5200 }, { role: "assistant", content: "answer" });
    expect(reported.usedTokens).toBe(5200);
    expect(Object.values(reported.parts).reduce((a, b) => a + b, 0)).toBe(5200);
    expect(reported.promptTokens).toBe(5000);
    expect(reported.basis).toBe("request-with-output");
    const line = contextFooter({ model: "test", usage: reported, sessionCache: { promptTokens: 5000, cachedPromptTokens: 4500, partial: false } }, 100)[0]!.map(span => span.text).join("");
    expect(line).toContain("4.1%");
    expect(line).toContain("≈4.1% · R90% · 128k");
    const next = reportedContext(projection, { promptTokens: 6000, completionTokens: 100, totalTokens: 6100 }, { role: "assistant", content: "next" });
    expect(next.usedTokens).toBe(6100);
    expect(reported.cachedPromptTokens).toBe(4500);
    expect(next.cachedPromptTokens).toBeUndefined();
    const noCache = reportedContext(reported, { promptTokens: 6000, completionTokens: 0, totalTokens: 6000 }, { role: "assistant", content: "next" });
    expect(noCache.cachedPromptTokens).toBeUndefined();
    const event = agentEventSchema.parse({ type: "context_usage", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", timestamp: "2026-01-01T00:00:00Z", usage: reported });
    expect(event.type === "context_usage" && event.usage.cachedPromptTokens).toBe(4500);
  });
  it("reads legacy char usage without interpreting characters as tokens", () => {
    const event = agentEventSchema.parse({ type: "context_usage", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", timestamp: "2026-01-01T00:00:00Z", usage: { budgetChars: 100000, usedChars: 10000, parts: { instructions: 1000, memory: 0, conversation: 9000, tools: 0 } } });
    expect(event.type).toBe("context_usage");
    if (event.type !== "context_usage") throw Error("wrong event");
    expect(event.usage.windowTokens).toBeNull();
    expect(event.usage.usedTokens).toBe(0);
    expect(contextFooter({ model: "unknown", usage: event.usage }, 80)[0]!.map(span => span.text).join("")).toContain("?% · R0% · ?");
  });
});
