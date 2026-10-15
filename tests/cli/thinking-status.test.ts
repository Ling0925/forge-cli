import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { createEventRenderer } from "../../src/cli/render/events";
import { TerminalReader } from "./legacy/reader";
import { stripAnsi } from "../../src/cli/theme";
import type { AgentEvent, ContextUsage } from "../../src/shared/schemas";

const event = (value: object) => value as AgentEvent;
const usage = (usedTokens: number, extra: Partial<ContextUsage> = {}) => event({
  type: "context_usage", usage: { usedTokens, windowTokens: 2000000, estimated: true,
    basis: "projected", parts: { instructions: usedTokens, memory: 0, conversation: 0, tools: 0 }, ...extra },
});

it("counts only this user turn's output across requests and resets for the next turn", () => {
  const renderer = createEventRenderer();
  expect(renderer.push(event({ type: "run_started" })).status?.tokens).toBe(0);
  expect(renderer.push(usage(12800)).status).toMatchObject({ label: "thinking", tokens: 0 });
  expect(renderer.push(event({ type: "text_delta", text: "abcdefgh" })).status)
    .toMatchObject({ label: "responding", tokens: 2, tokensEstimated: true });
  expect(renderer.push(usage(12900, { basis: "request-with-output", promptTokens: 12800, completionTokens: 100 })).status)
    .toMatchObject({ tokens: 100, tokensEstimated: false });
  // Another model request in the same user turn: neither context nor tool results count.
  expect(renderer.push(usage(14000)).status?.tokens).toBe(100);
  expect(renderer.push(event({ type: "text_delta", text: "abcd" })).status?.tokens).toBe(101);
  expect(renderer.push(usage(14050, { basis: "request-with-output", promptTokens: 14000, completionTokens: 50 })).status)
    .toMatchObject({ tokens: 150, tokensEstimated: false });
  expect(renderer.finish().status).toBeNull();
  expect(renderer.push(usage(15000)).status).toBeUndefined();
  expect(renderer.push(event({ type: "run_started" })).status?.tokens).toBe(0);
  expect(renderer.push(usage(20000)).status?.tokens).toBe(0);
});

it("keeps missing-usage output estimates across requests without adding context", () => {
  const renderer = createEventRenderer();
  renderer.push(event({ type: "run_started" }));
  renderer.push(usage(100000));
  renderer.push(event({ type: "text_delta", text: "abcdefgh" }));
  expect(renderer.push(usage(100006)).status).toMatchObject({ tokens: 2, tokensEstimated: true });
  expect(renderer.push(usage(120000)).status?.tokens).toBe(2);
  renderer.push(event({ type: "text_delta", text: "abcd" }));
  expect(renderer.push(usage(120010, { basis: "request-with-output", promptTokens: 120000, completionTokens: 10 })).status)
    .toMatchObject({ tokens: 12, tokensEstimated: true });
  renderer.push(event({ type: "state_changed", status: "cancelled" }));
  expect(renderer.push(event({ type: "run_started" })).status).toMatchObject({ tokens: 0, tokensEstimated: false });
});

it("animates thinking without tool events, shows k/m tokens and stops repainting when finished", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("TERM", "xterm-256color");
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let bytes = "";
  output.on("data", (chunk) => { bytes += String(chunk); });
  const reader = new TerminalReader({ input, output, isTTY: true });
  try {
    await reader.ui.configure({ theme: "dark" });
    const renderer = createEventRenderer();
    reader.ui.update!(renderer.push(event({ type: "run_started" })));
    expect(stripAnsi(bytes)).toContain("⠋ thinking · 0s · 0k tokens");
    reader.ui.update!(renderer.push(usage(100000)));
    reader.ui.update!(renderer.push(event({ type: "text_delta", text: "a".repeat(51200) })));
    reader.ui.update!(renderer.push(event({ type: "state_changed", status: "running" })));
    expect(stripAnsi(bytes)).toContain("⠋ thinking · 0s · ≈12.8k tokens");
    bytes = "";
    vi.advanceTimersByTime(100);
    expect(stripAnsi(bytes)).toContain("⠙ thinking · 0s · ≈12.8k tokens");
    reader.ui.update!(renderer.push(usage(1150000, { basis: "request-with-output", promptTokens: 100000, completionTokens: 1050000 })));
    expect(stripAnsi(bytes)).toContain("1.05m tokens");
    reader.ui.update!(renderer.finish());
    bytes = "";
    vi.advanceTimersByTime(1000);
    expect(bytes).toBe("");
  } finally {
    reader.dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
