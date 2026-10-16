import { PassThrough } from "node:stream";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { terminalQAResources } from "./qa-resources";

interface Term {
  open(element: HTMLElement): void; write(text: string, done: () => void): void; resize(columns: number, rows: number): void;
  onData(callback: (data: string) => void): { dispose(): void };
  select(column: number, row: number, length: number): void; getSelection(): string;
  buffer: { active: { type: string; length: number; baseY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
}
function browserWindow() { return window as unknown as { Terminal: new (options: object) => Term; inkTerm: Term }; }
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(raw: boolean) { this.isRaw = raw; return this; } }
class Output extends PassThrough { isTTY = true; columns = 80; rows = 24; }

it("Ink fullscreen anchors its dock, retains readable history and restores the original terminal", async () => {
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
    const reports: string[] = [];
    await page.exposeFunction("sendTerminalInput", (data: string) => { reports.push(data); input.write(data); });
    await page.evaluate(() => {
      const w = window as unknown as ReturnType<typeof browserWindow>;
      w.inkTerm = new w.Terminal({ cols: 80, rows: 24, scrollback: 5000, convertEol: true });
      w.inkTerm.open(document.getElementById("terminal")!);
      w.inkTerm.onData(data => { void (window as unknown as { sendTerminalInput(data: string): Promise<void> }).sendTerminalInput(data); });
    });
    const write = (data: string) => page.evaluate(async data => {
      await new Promise<void>(resolve => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.write(data, resolve));
    }, data);
    const flush = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      const data = pending; pending = ""; await write(data);
    };
    const lines = () => page.evaluate(() => {
      const b = (window as unknown as ReturnType<typeof browserWindow>).inkTerm.buffer.active;
      return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? "");
    });
    const dockRow = async (text = "❯") => (await lines()).findLastIndex(line => line.startsWith(text));
    await write("ORIGINAL-SHELL\r\n");
    await reader.ui.configure({ theme: "dark" }); await flush();
    expect(await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.buffer.active.type)).toBe("alternate");
    expect(await dockRow()).toBe(22);
    reader.ui.append([[{ text: "first-answer" }]]); await flush();
    expect((await lines()).join("\n")).toContain("first-answer");
    expect(await dockRow()).toBe(22);
    for (let i = 0; i < 60; i++) reader.ui.append([[{ text: `HISTORY-${String(i).padStart(3, "0")}` }]]);
    await flush();
    expect((await lines()).join("\n").split("HISTORY-059").length - 1).toBe(1);
    expect(await dockRow()).toBe(22);
    // Exercise actual browser wheel -> xterm SGR report -> decoder -> Ink viewport.
    const bounds = await page.locator(".xterm-screen").boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + 20, bounds!.y + 30);
    await page.mouse.wheel(0, -120); await flush();
    expect(reports.some(data => data.startsWith("\x1b[<64;"))).toBe(true);
    expect((await lines()).join("\n")).toContain("Reading");
    expect((await lines()).join("\n")).not.toContain("HISTORY-059");
    await page.mouse.wheel(0, 120); await flush();
    expect(reports.some(data => data.startsWith("\x1b[<65;"))).toBe(true);
    expect((await lines()).join("\n")).not.toContain("Reading");
    expect(await dockRow()).toBe(22);
    expect((await lines()).join("\n")).toContain("HISTORY-059");
    for (const count of [1, 40, 0]) {
      reader.ui.setTail(Array.from({ length: count }, (_, i) => [{ text: `UNFINISHED-${i}` }])); await flush();
      expect(await dockRow()).toBe(22);
    }
    input.write("/mod"); await flush();
    expect(await dockRow("❯ /mod")).toBe(22); // suggestions grow above the editor
    input.write("\x15draft\x1b[5~"); await flush();
    input.write("\x1b[5~\x1b[5~"); await flush();
    expect((await lines()).join("\n")).toContain("HISTORY-000");
    await page.evaluate(() => {
      const t = (window as unknown as ReturnType<typeof browserWindow>).inkTerm;
      t.select(0, 1, 8);
    });
    const selection = await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.getSelection());
    const before = emitted;
    reader.ui.update!({ append: [[{ text: "DONE-WHILE-READING" }]], tail: [], status: null }); await flush();
    expect(emitted).toBe(before);
    expect(await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.getSelection())).toBe(selection);
    const approval = reader.readApproval("Approve? ", new AbortController().signal);
    await flush(); expect(await dockRow("Approve?")).toBe(22);
    input.write("n\r"); expect(await approval).toBe(false); await flush();
    expect(await dockRow("❯ draft")).toBe(22);
    const picked = reader.ui.choose({ title: "Models", items: [{ label: "model-one", value: "one" }] }, new AbortController().signal);
    await flush(); expect((await lines()).join("\n")).toContain("model-one");
    input.write("\r"); expect(await picked).toBe("one"); await flush();
    expect(await dockRow("❯ draft")).toBe(22);
    for (const [cols, rows] of [[80, 12], [40, 12], [120, 40], [2, 2], [80, 24]] as const) {
      await page.evaluate(({ cols, rows }) => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.resize(cols, rows), { cols, rows });
      output.columns = cols; output.rows = rows; output.emit("resize"); await flush();
      if (cols > 2) expect(await dockRow("❯ draft")).toBe(rows - 2);
    }
    const answer = reader.question("❯ ", new AbortController().signal);
    input.write("\r"); expect(await answer).toBe("draft");
    const mixed = `中文 é 🎉 ${"mixed-width-".repeat(12)}END`;
    const next = reader.question("❯ ", new AbortController().signal); void next.catch(() => {});
    input.write(`${mixed}\x1b[D\x1b[D\x1b[DMID`); await flush();
    expect((await lines()).join("")).toContain("MIDEND");
    input.write("\r"); expect(await next).toBe(`${mixed.slice(0, -3)}MIDEND`);
    reader.dispose(); await flush();
    expect(await page.evaluate(() => (window as unknown as ReturnType<typeof browserWindow>).inkTerm.buffer.active.type)).toBe("normal");
    expect((await lines()).join("\n")).toContain("ORIGINAL-SHELL");
    expect(emitted).toContain("\x1b[?1000h");
    expect(emitted).toContain("\x1b[?1000l");
    expect(emitted).toContain("\x1b[?1006l");
    expect(emitted).not.toMatch(/\x1b\[\?(?:1002|1003)h/);
  } finally { reader.dispose(); await browser.close(); }
  expect(input.isRaw).toBe(false);
});
