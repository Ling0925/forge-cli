import { PassThrough } from "node:stream";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { terminalQAResources } from "./qa-resources";

interface Term {
  open(element: HTMLElement): void; write(text: string, done: () => void): void; resize(columns: number, rows: number): void;
  select(column: number, row: number, length: number): void; getSelection(): string;
  buffer: { active: { length: number; baseY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
}
function browserWindow() { return window as unknown as { Terminal: new (options: object) => Term; inkTerm: Term }; }
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(raw: boolean) { this.isRaw = raw; return this; } }
class Output extends PassThrough { isTTY = true; columns = 80; rows = 24; }

it("Ink keeps committed scrollback unique, reads unfinished text, preserves selection and recovers from resize", async () => {
  const resources = terminalQAResources();
  const browser = await chromium.launch({ executablePath: resources.chrome, headless: true, args: ["--no-sandbox"] });
  const input = new Input(); const output = new Output();
  let pending = ""; let emitted = "";
  output.on("data", chunk => { pending += chunk.toString(); emitted += chunk.toString(); });
  const reader = new TerminalReader({ input, output, isTTY: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="terminal"></div>');
    await page.addScriptTag({ path: resources.xterm });
    await page.evaluate(() => {
      const w = window as unknown as ReturnType<typeof browserWindow>;
      w.inkTerm = new w.Terminal({ cols: 80, rows: 24, scrollback: 5000, convertEol: true });
      w.inkTerm.open(document.getElementById("terminal")!);
    });
    const flush = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      const data = pending; pending = "";
      await page.evaluate(async data => {
        const w = window as unknown as ReturnType<typeof browserWindow>;
        await new Promise<void>(resolve => w.inkTerm.write(data, resolve));
      }, data);
    };
    const lines = () => page.evaluate(() => {
      const b = (window as unknown as ReturnType<typeof browserWindow>).inkTerm.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? "");
    });
    await reader.ui.configure({ theme: "dark" });
    for (let i = 0; i < 60; i++) reader.ui.append([[{ text: `HISTORY-${String(i).padStart(3, "0")}` }]]);
    reader.ui.setTail(Array.from({ length: 80 }, (_, i) => [{ text: `UNFINISHED-${String(i).padStart(3, "0")}` }]));
    await flush();
    let text = (await lines()).join("\n");
    for (let i = 0; i < 60; i++) expect(text.split(`HISTORY-${String(i).padStart(3, "0")}`).length - 1).toBe(1);
    expect(text).toContain("UNFINISHED-079");
    input.write("draft\x1b[5~"); await flush();
    input.write("\x1b[5~\x1b[5~\x1b[5~"); await flush();
    text = (await lines()).join("\n"); expect(text).toContain("UNFINISHED-010");
    await page.evaluate(() => {
      const t = (window as unknown as ReturnType<typeof browserWindow>).inkTerm;
      t.select(0, t.buffer.active.baseY + 1, 8);
    });
    const selection = await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.getSelection());
    const before = emitted;
    reader.ui.update!({ append: [[{ text: "DONE-WHILE-READING" }]], tail: [], status: null });
    await flush();
    expect(emitted).toBe(before);
    expect(await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.getSelection())).toBe(selection);
    input.write("\x1b[F"); await flush();
    expect((await lines()).join("\n")).toContain("DONE-WHILE-READING");
    await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.resize(40, 12));
    output.columns = 40; output.rows = 12; output.emit("resize"); await flush();
    reader.ui.setTail([[{ text: "NEW-TAIL" }]]); await flush();
    text = (await lines()).join("\n"); expect(text).toContain("NEW-TAIL");
    expect(text.split("HISTORY-000").length - 1).toBe(1);
    expect(emitted).not.toContain("\x1b[3J");
    expect(emitted).not.toContain("\x1b[?1049h");
    const answer = reader.question("❯ ", new AbortController().signal);
    input.write("\r"); expect(await answer).toBe("draft");
    const mixed = `中文 é 🎉 ${"mixed-width-".repeat(12)}END`;
    const next = reader.question("❯ ", new AbortController().signal);
    void next.catch(() => {});
    input.write(`${mixed}\x1b[D\x1b[D\x1b[DMID`);
    for (const [cols, rows] of [[80, 24], [40, 12], [120, 40]] as const) {
      await page.evaluate(({ cols, rows }) => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.resize(cols, rows), { cols, rows });
      output.columns = cols; output.rows = rows; output.emit("resize"); await flush();
      expect((await lines()).join("")).toContain("MIDEND");
      expect((await lines()).join("\n").split("HISTORY-000").length - 1).toBe(1);
    }
    input.write("\r"); expect(await next).toBe(`${mixed.slice(0, -3)}MIDEND`);
  } finally { reader.dispose(); await browser.close(); }
  expect(input.isRaw).toBe(false);
});
