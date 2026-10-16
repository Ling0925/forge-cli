import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSymbols, spinnerFrame } from "../../src/cli/symbols";
import { InkView } from "../../src/cli/ink/view";
import { initialInput, type InputState } from "../../src/cli/ink/input-state";
import { emptyEditor } from "../../src/cli/ink/input-editor";
import { InputStore } from "../../src/cli/ink/input-store";
import type { InkViewState } from "../../src/cli/ink/types";
import { contextFooter } from "../../src/cli/terminal/context-footer";
import { stripAnsi, stringWidth, truncate } from "../../src/cli/render/width";
import { measureContext } from "../../src/shared/context-usage";

afterEach(() => vi.unstubAllEnvs());
const base: InkViewState = { columns: 80, rows: 24, tail: [], status: null, context: null, plan: null,
  mode: "build", theme: "system", noColor: true, pendingInput: [], inputHint: null, now: 80 };
function frame(state: InkViewState, input: InputState = initialInput()): string {
  const output = Object.assign(new PassThrough(), { columns: state.columns, rows: state.rows, isTTY: true });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const app = render(createElement(InkView, { state, input }), { stdout: output as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  try { return stripAnsi(bytes); } finally { app.unmount(); app.cleanup(); }
}

describe("terminal symbol capabilities", () => {
  it.each(["dumb", "linux"])("falls back on %s even in UTF-8", TERM => {
    expect(resolveSymbols({ TERM, LANG: "en_US.UTF-8" }, "linux").prompt).toBe(">");
  });
  it("respects locale precedence, unknown environments and explicit overrides", () => {
    expect(resolveSymbols({ LANG: "C" }, "linux").prompt).toBe(">");
    expect(resolveSymbols({ LC_ALL: "C", LC_CTYPE: "C.UTF-8", LANG: "C.UTF-8" }, "linux").prompt).toBe(">");
    expect(resolveSymbols({ LC_CTYPE: "C.UTF-8", LANG: "C" }, "linux").prompt).toBe("❯");
    expect(resolveSymbols({}, "linux").prompt).toBe("❯");
    expect(resolveSymbols({ FORGE_SYMBOLS: "unicode", TERM: "dumb", LANG: "C" }, "linux").prompt).toBe("❯");
    expect(resolveSymbols({ FORGE_SYMBOLS: " ASCII ", LANG: "C.UTF-8" }, "linux").prompt).toBe(">");
    expect(resolveSymbols({ FORGE_SYMBOLS: "invalid", LANG: "C.UTF-8" }, "linux").prompt).toBe("❯");
  });
  it("distinguishes legacy Windows and modern terminal hints without treating NO_COLOR as missing glyphs", () => {
    expect(resolveSymbols({}, "win32").prompt).toBe(">");
    expect(resolveSymbols({ WT_SESSION: "test" }, "win32").prompt).toBe("❯");
    expect(resolveSymbols({ TERM_PROGRAM: "vscode" }, "win32").prompt).toBe("❯");
    expect(resolveSymbols({ NO_COLOR: "1", LANG: "C.UTF-8" }, "linux").prompt).toBe("❯");
  });
  it("has printable ASCII fallbacks and one-cell animation frames", () => {
    const symbols = resolveSymbols({ FORGE_SYMBOLS: "ascii" });
    for (const value of Object.values(symbols).flat()) expect(value).toMatch(/^[ -~]+$/);
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    expect([0, 80, 160, 240, 320].map(spinnerFrame)).toEqual(["|", "/", "-", "\\", "|"]);
    expect(symbols.spinnerFrames.every(s => stringWidth(s) === 1)).toBe(true);
    expect(truncate("abcdefgh", 5)).toBe("ab...");
    for (const width of [1, 2, 3]) expect(stringWidth(truncate("中文", width))).toBeLessThanOrEqual(width);
  });
});

describe("ASCII Ink integration", () => {
  it("shows composer, animated reasoning, plan and footer without replacing user glyphs", () => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    const output = frame({ ...base, context: { model: "exact-model", usage: measureContext([], 10000),
      sessionCache: { promptTokens: 10, cachedPromptTokens: 5, partial: true } },
      tail: [[{ text: "| ", animation: "spinner" }, { text: "原文 ❯ ✔ 👩‍💻" }]],
      plan: { explanation: "", steps: [{ step: "Implement", status: "in_progress" }] },
      status: { label: "Thinking", startedAt: 0, toolCount: 1, cancellable: true },
    });
    expect(output).toContain("> |");
    expect(output).toContain("/ 原文 ❯ ✔ 👩‍💻");
    expect(output).toContain("* Implement");
    expect(output).toContain("R~50%");
    expect(output).not.toMatch(/[⠋⠙⠹─━▏↑↓]/);
    const store = new InputStore(() => {}); store.begin("custom", false); store.end();
    expect(store.getSnapshot().prompt).toBe("> "); store.dispose();
  });
  it.each(["ascii", "unicode"])("preserves full emoji clusters in %s live/history/reading rows", mode => {
    vi.stubEnv("FORGE_SYMBOLS", mode);
    const value = "中文 é 👩‍💻 🇨🇳 ☀️";
    for (const noColor of [false, true]) for (const location of ["tail", "history", "reading"] as const) {
      const rows = [[{ text: value, tone: "muted" as const }]];
      const state: InkViewState = { ...base, columns: 30, noColor, theme: "dark", colorDepth: 24,
        ...(location === "tail" ? { tail: rows } : location === "history" ? { visibleHistory: rows }
          : { reading: { lines: rows, end: 1, pending: 0 } }) };
      const output = frame(state);
      expect(output).toContain(value);
      expect(output.split("\n").every(row => stringWidth(row) <= 29)).toBe(true);
    }
  });
  it.each([80, 24, 8, 2])("keeps picker rows within %s columns after fallback expansion", columns => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    const input: InputState = { ...initialInput(), focus: { kind: "picker", id: 1, index: 0, editor: emptyEditor(),
      spec: { title: "Pick", items: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `item-${i}`, active: true })) } } };
    const output = frame({ ...base, columns }, input);
    expect(output.split("\n").every(row => stringWidth(row) <= columns - 1)).toBe(true);
    expect(output).not.toMatch(/[^\x00-\x7f]/);
    if (columns === 80) { expect(output).toContain("Up/Down"); expect(output).toContain("> / item-0"); }
  });
  it.each([1, 8, 40, 80])("keeps context meter and summary bounded at %s cells", width => {
    vi.stubEnv("FORGE_SYMBOLS", "ascii");
    for (const compact of [false, true]) {
      const rows = contextFooter({ model: "long-model-name", reasoningEffort: "high", usage: measureContext([], 10000) }, width, compact);
      expect(rows.every(row => stringWidth(row.map(s => s.text).join("")) <= width)).toBe(true);
      expect(rows.flat().some(s => /[─━≈]/.test(s.text))).toBe(false);
    }
  });
});
