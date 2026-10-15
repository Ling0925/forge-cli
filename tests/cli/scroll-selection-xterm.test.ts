import { PassThrough } from "node:stream";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { terminalQAResources } from "./qa-resources";

it("xterm renders a stationary editor, scrollable live transcript and persistent inverse selection", async () => {
  const resources = terminalQAResources();
  const browser = await chromium.launch({ executablePath: resources.chrome, headless: true, args: ["--no-sandbox"] });
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let pending = "";
  output.on("data", (chunk) => { pending += chunk.toString(); });
  const reader = new TerminalReader({ input, output, isTTY: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="terminal"></div>');
    await page.addScriptTag({ path: resources.xterm });
    await page.addScriptTag({ path: resources.unicode11 });
    await page.evaluate(() => {
      const term = new window.Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
      term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.open(document.getElementById("terminal")!);
      window.term = term;
    });
    const flush = async () => {
      const data = pending;
      pending = "";
      await page.evaluate((data) => new Promise<void>((resolve) => window.term.write(data, resolve)), data);
    };
    const snapshot = () => page.evaluate(() => {
      const buffer = window.term.buffer.active;
      return { x: buffer.cursorX, y: buffer.cursorY, lines: Array.from({ length: 24 }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "") };
    });
    await reader.ui.configure({ theme: "dark" });
    const abort = new AbortController();
    const question = reader.question("❯ ", abort.signal).catch(() => null);
    input.write("draft");
    reader.ui.setPendingInput!(["Steer (1): change direction", "Queue (1): later task"]);
    for (let i = 0; i < 30; i++) reader.ui.append([[{ text: `HISTORY-${i}` }]]);
    reader.ui.setTail(Array.from({ length: 20 }, (_, i) => [{ text: `LIVE-${i}` }]));
    await flush();
    const bottom = await snapshot();
    expect(bottom.lines[bottom.y]).toBe("❯ draft");
    expect(bottom.lines.join("\n")).toContain("LIVE-19");
    input.write("\x1b[5~");
    await flush();
    const scrolled = await snapshot();
    expect(scrolled.y).toBe(bottom.y);
    expect(scrolled.x).toBe(bottom.x);
    expect(scrolled.lines.join("\n")).toContain("HISTORY-");
    expect(scrolled.lines.join("\n")).not.toContain("LIVE-19");
    reader.ui.setTail(Array.from({ length: 21 }, (_, i) => [{ text: `LIVE-${i}` }]));
    await flush();
    expect((await snapshot()).lines).toEqual(scrolled.lines);
    const row = bottom.y + 1;
    input.write(`\x1b[<0;3;${row}M\x1b[<32;7;${row}M\x1b[<0;7;${row}m`);
    await flush();
    const selected = await snapshot();
    const inverse = await page.evaluate((row) => {
      // xterm's browser cell exposes attributes in addition to chars/width.
      const cell = window.term.buffer.active.getLine(row)?.getCell(2) as unknown as { isInverse(): number };
      return cell.isInverse();
    }, bottom.y);
    expect(inverse).toBeTruthy();
    reader.ui.append([[{ text: "NEW-COMMITTED" }]]);
    reader.ui.setTail([[{ text: "LATEST-LIVE" }]]);
    reader.ui.setStatus({ label: "Working", startedAt: Date.now(), toolCount: 0, cancellable: true });
    await flush();
    const duringSelection = await snapshot();
    expect(duringSelection.lines[bottom.y]).toBe(selected.lines[bottom.y]);
    expect(duringSelection.lines.join("\n")).toContain("Working");
    expect(duringSelection.lines.join("\n")).not.toContain("LATEST-LIVE");
    input.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 45));
    input.write("\x1b[6~\x1b[6~\x1b[6~");
    await flush();
    const caughtUp = await snapshot();
    expect(caughtUp.lines.join("\n")).toContain("NEW-COMMITTED");
    expect(caughtUp.lines.join("\n")).toContain("LATEST-LIVE");
    expect(caughtUp.y).toBe(bottom.y);
    expect(caughtUp.lines[caughtUp.y]).toBe("❯ draft");
    for (const frame of [bottom, scrolled, caughtUp]) {
      expect(frame.lines[frame.y + 1]).toBe("Steer (1): change direction");
      expect(frame.lines[frame.y + 2]).toBe("Queue (1): later task");
    }
    abort.abort();
    await question;
  } finally {
    reader.dispose();
    await browser.close();
  }
});
