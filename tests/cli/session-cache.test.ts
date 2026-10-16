import { describe, expect, it } from "vitest";
import { SessionCache, cacheRate } from "../../src/cli/interactive/session-cache";
import { parseSessionId, type AgentEvent, type ContextUsage } from "../../src/shared/schemas";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const other = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const base = { sessionId: id, timestamp: "2026-01-01T00:00:00Z" };
const start = (): AgentEvent => ({ ...base, type: "run_started", model: "test", permission: "workspace" });
const report = (prompt?: number, cached?: number, basis: ContextUsage["basis"] = "request-with-output"): AgentEvent => ({ ...base,
  type: "context_usage", usage: { windowTokens: 10000, usedTokens: prompt ?? 0, basis, estimated: true,
    ...(prompt === undefined ? {} : { promptTokens: prompt }), ...(cached === undefined ? {} : { cachedPromptTokens: cached }),
    parts: { instructions: 0, memory: 0, conversation: prompt ?? 0, tools: 0 } } });
const finish = (prompt: number, cached?: number): AgentEvent => ({ ...base, type: "run_finished", status: "completed", turns: 2, toolCalls: 0,
  usage: { promptTokens: prompt, completionTokens: 20, totalTokens: prompt + 20, ...(cached === undefined ? {} : { cachedPromptTokens: cached }) } });
const session = (events: AgentEvent[] = []) => ({ id, events });

describe("session weighted cache rate", () => {
  it("updates after every request across runs without resetting during projection", () => {
    const s = new SessionCache(session());
    expect(cacheRate(s.snapshot())).toBe("0%");
    s.push(start()); s.push(report(100, 0)); expect(cacheRate(s.snapshot())).toBe("0%");
    s.push(report(900, 900, "projected")); expect(cacheRate(s.snapshot())).toBe("0%");
    s.push(report(900, 900)); expect(cacheRate(s.snapshot())).toBe("90%");
    s.push(finish(1000, 900)); expect(s.snapshot()).toMatchObject({ promptTokens: 1000, cachedPromptTokens: 900 });
    s.push(start()); s.push(report(2000, undefined, "projected")); expect(cacheRate(s.snapshot())).toBe("90%");
    s.push(report(1000, 0)); expect(cacheRate(s.snapshot())).toBe("45%");
    s.push(finish(1000, 0)); expect(cacheRate(s.snapshot())).toBe("45%");
  });
  it("restores the same result from persisted request events without double counting run totals", () => {
    const events = [start(), report(100, 0), report(900, 900), finish(1000, 900), start(), report(1000, 0), finish(1000, 0)];
    const s = new SessionCache(session(events));
    expect(cacheRate(s.snapshot())).toBe("45%");
    s.restore(session(events)); expect(s.snapshot()).toEqual({ promptTokens: 2000, cachedPromptTokens: 900, partial: false });
    s.push({ ...report(10000, 10000), sessionId: other });
    expect(cacheRate(s.snapshot())).toBe("45%");
  });
  it("preserves partial interrupted runs and handles old records with only aggregate usage", () => {
    const s = new SessionCache(session([start(), finish(1000, 800), start(), report(1000, 200)]));
    expect(cacheRate(s.snapshot())).toBe("50%");
    s.push(start()); s.push(report(1000, 500)); s.push(finish(1000, 500));
    expect(cacheRate(s.snapshot())).toBe("50%");
    expect(s.snapshot().promptTokens).toBe(3000);
  });
  it("replaces input-only usage with final usage for the same request", () => {
    const s = new SessionCache(session());
    s.push(report(100, 50, "request")); expect(cacheRate(s.snapshot())).toBe("50%");
    s.push(report(100, 50));
    expect(s.snapshot().promptTokens).toBe(100);
    s.push(report(200, 100, "request")); s.push(report(undefined, undefined, "projected"));
    expect(s.snapshot().promptTokens).toBe(300);
  });
  it("does not count missing/invalid cache values as zero and never displays a dash", () => {
    const s = new SessionCache(session([report(1000, 900)]));
    for (const event of [report(2000), report(100, 101), report(undefined, 12)]) s.push(event);
    expect(s.snapshot()).toEqual({ promptTokens: 1000, cachedPromptTokens: 900, partial: true });
    expect(cacheRate(s.snapshot())).toBe("≈90%");
    const missing = new SessionCache(session([finish(1000)]));
    expect(cacheRate(missing.snapshot())).toBe("≈0%");
    expect(cacheRate()).toBe("0%");
  });
  it("keeps partial known statistics when a run ends without a complete usage report", () => {
    const s = new SessionCache(session([start(), report(1000, 800)]));
    s.push({ ...base, type: "run_finished", status: "cancelled", turns: 2, toolCalls: 1, usageComplete: false });
    expect(s.snapshot()).toEqual({ promptTokens: 1000, cachedPromptTokens: 800, partial: true });
    expect(cacheRate(s.snapshot())).toBe("≈80%");
  });
  it("switches/new/fork sessions without mixing history and leaves same-session stats intact", () => {
    const s = new SessionCache(session([report(100, 90)]));
    s.ensureSession(session()); expect(cacheRate(s.snapshot())).toBe("90%");
    s.ensureSession({ id: other, events: [] }); expect(cacheRate(s.snapshot())).toBe("0%");
    s.restore(session([report(100, 90)])); expect(cacheRate(s.snapshot())).toBe("90%");
    s.restore(); expect(cacheRate(s.snapshot())).toBe("0%");
  });
});
