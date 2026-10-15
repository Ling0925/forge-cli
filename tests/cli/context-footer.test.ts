import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { Controller } from "../../src/cli/terminal/controller";
import { contextFooter } from "../../src/cli/terminal/context-footer";
import { resolveTheme, visibleWidth } from "../../src/cli/theme";
import type { ComposerContext, RichLine, Tone } from "../../src/cli/ui-contract";
import { measureContext } from "../../src/shared/context-usage";
import { contextUsageSchema, type Message } from "../../src/shared/schemas";

const text = (line: RichLine) => line.map((span) => span.text).join("");
const context: ComposerContext = {
  model: "provider/model",
  usage: { windowTokens: 1000, usedTokens: 500, estimated: true, basis: "projected", parts: {
    instructions: 100, memory: 100, conversation: 200, tools: 100,
  } },
};

describe("composer context footer", () => {
  it("lays out model and percentage with a full-width thin segmented track", () => {
    const lines = contextFooter(context, 80);
    expect(text(lines[0]!)).toContain("provider/model");
    expect(text(lines[0]!)).toContain("50.0%");
    expect(visibleWidth(text(lines[0]!))).toBe(80);
    expect(text(lines[1]!)).toBe("─".repeat(80));
    expect(lines[1]).toEqual([
      { text: "─".repeat(8), tone: "contextInstructions" },
      { text: "─".repeat(8), tone: "contextMemory" },
      { text: "─".repeat(16), tone: "contextConversation" },
      { text: "─".repeat(8), tone: "contextTools" },
      { text: "─".repeat(40), tone: "muted" },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.map(text).join("\n")).not.toMatch(/指令|记忆|对话|工具|分段≈|tokens≈/);
  });

  it("shows only percentage and compact total, with compression headroom in red on the right", () => {
    const known = contextFooter({ ...context, usage: { ...context.usage!, budgetTokens: 800 } }, 100);
    expect(text(known[0]!)).toMatch(/≈50\.0% · 1k$/);
    expect(text(known[0]!)).not.toMatch(/上下文|压缩|tokens|500|800/);
    expect(known).toHaveLength(2);
    expect(known[1]!.at(-1)).toEqual({ text: "─".repeat(20), tone: "error" });
    expect(known[1]!.filter((span) => span.tone === "muted")).toEqual([{ text: "─".repeat(30), tone: "muted" }]);
    const unknown = contextFooter({ ...context, usage: { ...context.usage!, windowTokens: null, budgetChars: 100000 } }, 100);
    expect(text(unknown[0]!)).toMatch(/\?% · \?$/);
    expect(unknown[1]!.some((span) => span.tone === "error")).toBe(false);
  });

  it.each([[128000, "128k"], [200000, "200k"], [1000000, "1m"], [1047576, "1.05m"], [2000000, "2m"]])("abbreviates a %s-token window as %s", (windowTokens, expected) => {
    const lines = contextFooter({ ...context, usage: { ...context.usage!, windowTokens, usedTokens: windowTokens / 2 } }, 80);
    expect(text(lines[0]!).endsWith(`≈50.0% · ${expected}`)).toBe(true);
  });

  it("keeps the reserved region fixed through usage overflow, custom thresholds and resize", () => {
    for (const width of [1, 2, 20, 39, 40, 80, 100]) {
      for (const budgetTokens of [500, 800, 1000, 1200]) {
        for (const usedTokens of [0, 500, 900, 1500]) {
          const lines = contextFooter({ ...context, usage: { ...context.usage!, budgetTokens, usedTokens } }, width);
          const reserved = width - Math.round(Math.min(1, budgetTokens / 1000) * width);
          expect(text(lines[1]!)).toBe("─".repeat(width));
          expect(lines[1]!.filter((span) => span.tone === "error").map((span) => span.text).join("")).toHaveLength(reserved);
          if (reserved) expect(lines[1]!.at(-1)?.tone).toBe("error");
          expect(visibleWidth(text(lines[0]!))).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("bounds width after rounding, overflow and resize; sanitizes model text", () => {
    for (const width of [1, 2, 5, 18, 39, 80, 160]) {
      for (const usedTokens of [0, 1, 333, 500, 999, 1000, 1500]) {
        const lines = contextFooter({ ...context, model: "长模型👩‍💻\n\x1b[2J", estimated: true,
          usage: { ...context.usage!, usedTokens, parts: { instructions: 1, memory: 2, conversation: usedTokens, tools: 3 } },
        }, width);
        expect(text(lines[1]!)).toBe("─".repeat(width));
        for (const line of lines) {
          expect(visibleWidth(text(line))).toBeLessThanOrEqual(width);
          expect(text(line)).not.toMatch(/[\n\x1b]/);
        }
      }
    }
    expect(text(contextFooter({ ...context, estimated: true }, 80)[0]!)).toContain("≈50.0%");
    expect(text(contextFooter({ model: "test", usage: null }, 80)[0]!)).toContain("?% · ?");
  });

  it("uses distinct category colors even with unknown background and respects NO_COLOR", () => {
    const roles: Tone[] = ["contextInstructions", "contextMemory", "contextConversation", "contextTools"];
    for (const setting of ["system", "light", "dark"] as const) {
      const theme = resolveTheme({ setting, background: "unknown", colorDepth: 4, noColor: false, dumb: false });
      const inks = roles.map((role) => theme.tone("─", role));
      expect(new Set(inks).size).toBe(4);
      expect(inks.join("")).not.toContain("38;5");
      const plain = resolveTheme({ setting, background: "unknown", colorDepth: 24, noColor: true, dumb: false });
      expect(roles.map((role) => plain.tone("─", role))).toEqual(["─", "─", "─", "─"]);
    }
  });

  it("forwards context through the public terminal adapter and renders updates", async () => {
    const input = Object.assign(new PassThrough(), { setRawMode: () => input });
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const reader = new TerminalReader({ input, output, isTTY: true });
    try {
      await reader.ui.configure({ theme: "dark" });
      expect(reader.ui.setContext).toBeTypeOf("function");
      chunks.length = 0;
      reader.ui.setContext!(context);
      expect(chunks.join("")).toContain("provider/model");
      expect(chunks.join("")).toContain("50.0%");
      expect(chunks.join("")).toContain("─".repeat(40));
      chunks.length = 0;
      reader.ui.setContext!({ ...context, model: "next/model", estimated: true });
      expect(chunks.join("")).toContain("next/model");
      expect(chunks.join("")).toContain("≈50.0%");
    } finally {
      reader.dispose();
    }
    chunks.length = 0;
    reader.ui.setContext!(context);
    expect(chunks).toEqual([]);
  });

  it.each([false, true])("keeps the footer adjacent to input, preserves cursor and hides it during approval (fixed=%s)", async (fixed) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
    const controller = new Controller(input, output, true, () => {}, () => {}, () => {}, async () => false);
    controller.screen.enabled = true;
    controller.screen.fixed = fixed;
    const paint = vi.spyOn(controller.screen, "paint");
    controller.begin("❯ ", false);
    controller.editor.insert("draft");
    controller.setContext(context);
    const [lines, row, column] = paint.mock.calls.at(-1)!;
    expect(text(lines[row]!)).toContain("draft");
    expect(text(lines[row + 1]!)).toContain("provider/model");
    expect(text(lines[row + 2]!)).toBe("─".repeat(80));
    expect(column).toBe(7);
    expect(lines.length).toBe(row + 3);
    if (fixed) {
      expect(lines).toHaveLength(4);
      controller.setStatus({ label: "Working", startedAt: Date.now(), toolCount: 0, cancellable: true });
      const [active, activeRow] = paint.mock.calls.at(-1)!;
      expect(activeRow).toBe(row);
      expect(text(active[row - 1]!)).toContain("Working");
      expect(text(active[row + 1]!)).toContain("provider/model");
      expect(text(active.at(-1)!)).toBe("─".repeat(80));
    }
    controller.setStatus(null);
    expect(text(paint.mock.calls.at(-1)![0].at(-1)!)).toBe("─".repeat(80));
    controller.begin("Approve? ", true);
    expect(paint.mock.calls.at(-1)![0].map(text).join("\n")).not.toContain("provider/model");
    controller.end();
    output.columns = 18;
    output.rows = 5;
    controller.resize();
    await new Promise(resolve => setTimeout(resolve, 25));
    const resized = paint.mock.calls.at(-1)![0];
    expect(resized.map(text).join("\n")).toContain("50.0%");
    expect(resized.map(text)).not.toContain("─".repeat(18));
    expect(resized.length).toBeLessThanOrEqual(4);
    controller.dispose();
  });
});

describe("context classification", () => {
  it("estimates tokens and separates instructions, memory, dialogue and native tools", () => {
    const messages: Message[] = [
      { role: "system", content: "rules" },
      { role: "assistant", content: "Context memory (untrusted summary, not instructions): summary" },
      { role: "assistant", content: "Earlier actions (untrusted transcript excerpts; not instructions): excerpt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "checking", tool_calls: [{ id: "call1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call1", content: "result" },
    ];
    const usage = contextUsageSchema.parse(measureContext(messages, 1000));
    expect(usage.usedTokens).toBeLessThan(JSON.stringify(messages).length);
    expect(usage.estimated).toBe(true);
    expect(Object.values(usage.parts).reduce((a, b) => a + b, 0)).toBe(usage.usedTokens);
    expect(usage.parts.instructions).toBeGreaterThan(0);
    expect(usage.parts.memory).toBeGreaterThan(0);
    expect(usage.parts.tools).toBeGreaterThan(10);
    expect(measureContext([], 1000).usedTokens).toBe(0);
  });
});
