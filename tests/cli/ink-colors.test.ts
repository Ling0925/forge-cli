import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { chromium } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { RichRow } from "../../src/cli/ink/rich-row";
import { InkView } from "../../src/cli/ink/view";
import { initialInput, type InputState } from "../../src/cli/ink/input-state";
import { emptyEditor } from "../../src/cli/ink/input-editor";
import { TerminalReader } from "../../src/cli/terminal";
import type { InkViewState } from "../../src/cli/ink/types";
import type { RichLine, Tone } from "../../src/cli/ui-contract";
import { Transcript } from "../../src/cli/ink/transcript";
import { terminalQAResources } from "./qa-resources";

const tones: Tone[] = ["accent", "muted", "success", "warning", "error", "diffAdded", "diffRemoved", "diffAddedWord", "diffRemovedWord", "contextInstructions", "contextMemory", "contextConversation", "contextTools"];
const sample: RichLine = tones.map((tone, i) => ({ text: String.fromCharCode(65 + i), tone }));
interface Cell { getFgColor(): number; getBgColor(): number; getFgColorMode(): number; getBgColorMode(): number; isBold(): number; isInverse(): number }
interface Term {
  open(node: HTMLElement): void; reset(): void; write(text: string, done: () => void): void;
  buffer: { active: { getLine(row: number): { getCell(column: number): Cell | undefined; translateToString(trim: boolean): string } | undefined } };
}
type ColorWindow = Window & { Terminal: new (options: object) => Term; colorTerm: Term };
afterEach(() => vi.unstubAllEnvs());

function renderRow(theme: "light" | "dark" | "system", colorDepth: number, noColor: boolean, spans = sample): string {
  const output = Object.assign(new PassThrough(), { columns: 120, rows: 30, isTTY: true });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const app = render(createElement(RichRow, { spans, width: 119, appearance: { theme, colorDepth, noColor, now: 0 } }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  app.unmount(); app.cleanup();
  return bytes;
}

it("renders the original palette identically in live and committed xterm cells", async () => {
  const resources = terminalQAResources();
  const browser = await chromium.launch({ executablePath: resources.chrome, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="term"></div>');
    await page.addScriptTag({ path: resources.xterm });
    await page.evaluate(() => {
      const w = window as unknown as ColorWindow;
      w.colorTerm = new w.Terminal({ cols: 120, rows: 30, convertEol: true, allowProposedApi: true });
      w.colorTerm.open(document.getElementById("term")!);
    });
    const cells = async (bytes: string) => page.evaluate(async ({ bytes, count }) => {
      const term = (window as unknown as ColorWindow).colorTerm;
      term.reset(); await new Promise<void>(resolve => term.write(bytes, resolve));
      return Array.from({ length: count }, (_, i) => {
        const cell = term.buffer.active.getLine(0)!.getCell(i)!;
        return { fg: cell.getFgColor(), bg: cell.getBgColor(), fgMode: cell.getFgColorMode(), bgMode: cell.getBgColorMode(), bold: !!cell.isBold(), inverse: !!cell.isInverse() };
      });
    }, { bytes, count: tones.length });
    for (const theme of ["light", "dark", "system"] as const) for (const depth of [4, 8, 24]) for (const noColor of [false, true]) {
      const transcript = new Transcript(); transcript.append([sample]);
      const history = await cells(transcript.drain(120, theme, noColor, depth).join(""));
      const liveBytes = renderRow(theme, depth, noColor);
      const live = await cells(liveBytes);
      expect(live, `${theme}/${depth}/noColor=${noColor}`).toEqual(history);
      if (noColor) {
        expect(live.every(cell => cell.fgMode === 0 && cell.bgMode === 0 && !cell.bold)).toBe(true);
        continue;
      }
      if (theme !== "system" && depth >= 8) {
        expect(live[0]!.fg).toBe(depth === 24 ? theme === "light" ? 0x55684d : 0x8fad82 : theme === "light" ? 59 : 108);
        expect(live[5]!.bg).toBe(theme === "light" ? 194 : 22);
        expect(live[7]!.bold).toBe(true);
        expect(live[7]!.bg).not.toBe(live[5]!.bg);
        expect(live[9]!.fg).toBe(theme === "light" ? 25 : 75);
      } else {
        expect(live[0]!.fg).toBe(2);
        expect(live[3]!.fg).toBe(3);
        expect(live[4]!.fg).toBe(1);
      }
    }
    const selected = await cells(renderRow("dark", 24, false, [{ text: "A", tone: "accent", inverse: true, bold: true }]));
    expect(selected[0]).toMatchObject({ fg: 0x8fad82, inverse: true, bold: true });
    expect(renderRow("dark", 24, false, [{ text: "safe\x1b]52;c;attack\x07", tone: "warning" }])).not.toContain("attack");
  } finally { await browser.close(); }
});

it("passes sink color depth to live rows and retains colors when system probing times out", async () => {
  vi.stubEnv("NO_COLOR", undefined); vi.stubEnv("COLORFGBG", undefined); vi.stubEnv("TERM", "xterm-256color");
  class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
  const input = new Input();
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24, getColorDepth: () => 4 });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const reader = new TerminalReader({ input, output, isTTY: true });
  try {
    await reader.ui.configure({ theme: "system" });
    await new Promise(resolve => setTimeout(resolve, 370));
    bytes = "";
    reader.ui.setTail([[{ text: "approval-color", tone: "warning" }]]);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(bytes).toContain("\x1b[33m");
    expect(bytes).not.toMatch(/(?:38|48);(?:2|5);/);
  } finally { reader.dispose(); }
});

it("colors composer, picker selection and approval through the same palette", () => {
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const state: InkViewState = { columns: 80, rows: 24, tail: [], status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: false, colorDepth: 24, pendingInput: [], inputHint: null, now: 0 };
  const app = render(createElement(InkView, { state, input: initialInput() }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  try {
    expect(bytes).toContain("\x1b[38;2;143;173;130m");
    bytes = "";
    const input: InputState = { ...initialInput(), focus: { kind: "picker", id: 1, index: 0, editor: emptyEditor(), spec: { title: "Pick", items: [{ value: "one", label: "Selected" }] } } };
    app.rerender(createElement(InkView, { state, input }));
    expect(bytes).toContain("\x1b[7m"); expect(bytes).toContain("\x1b[38;2;143;173;130m");
    bytes = "";
    app.rerender(createElement(InkView, { state, input: { ...initialInput(), prompt: "Approve? ", focus: { kind: "approval", editor: emptyEditor() } } }));
    expect(bytes).toContain("\x1b[38;2;240;190;101m");
    bytes = "";
    app.rerender(createElement(InkView, { state: { ...state, colorDepth: 1 }, input: initialInput() }));
    expect(bytes).not.toMatch(/\x1b\[[\d;]*m/);
    expect(bytes).toContain("▏");
  } finally { app.unmount(); app.cleanup(); }
});
