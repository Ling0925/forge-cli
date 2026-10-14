import { PassThrough } from "node:stream";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { wrapRichLines } from "../../src/cli/render/rich";
import { TerminalReader } from "../../src/cli/terminal";
import { terminalQAResources } from "./qa-resources";

interface BrowserAddon {
  activate(terminal: BrowserTerminal): void;
  dispose(): void;
}
interface BrowserCell {
  getChars(): string;
  getWidth(): number;
}
interface BrowserTerminal {
  loadAddon(addon: BrowserAddon): void;
  unicode: { activeVersion: string };
  open(element: HTMLElement): void;
  write(data: string, callback: () => void): void;
  resize(cols: number, rows: number): void;
  buffer: {
    active: {
      length: number;
      baseY: number;
      cursorY: number;
      cursorX: number;
      getLine(index: number):
        | {
            translateToString(trim: boolean): string;
            getCell(column: number): BrowserCell | undefined;
          }
        | undefined;
    };
  };
}
declare global {
  interface Window {
    Terminal: new (options: {
      cols: number;
      rows: number;
      scrollback: number;
      allowProposedApi: boolean;
    }) => BrowserTerminal;
    Unicode11Addon: { Unicode11Addon: new () => BrowserAddon };
    term: BrowserTerminal;
  }
}

class Input extends PassThrough {
  isRaw = false;
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}
class Output extends PassThrough {
  columns = 80;
  rows = 30;
}
const signal = () => new AbortController().signal;

it("actual browser xterm replaces transient frames through width/height resize", async () => {
  const resources = terminalQAResources();
  const browser = await chromium.launch({
    executablePath: resources.chrome,
    headless: true,
    args: ["--no-sandbox"],
  });
  const input = new Input();
  const output = new Output();
  let pending = "";
  let emitted = "";
  output.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    emitted += chunk.toString();
  });
  const reader = new TerminalReader({ input, output, isTTY: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="terminal"></div>');
    await page.addScriptTag({
      path: resources.xterm,
    });
    await page.addScriptTag({ path: resources.unicode11 });
    await page.evaluate(() => {
      const w = window;
      const term = new w.Terminal({
        cols: 80,
        rows: 30,
        scrollback: 1000,
        allowProposedApi: true,
      });
      const element = document.getElementById("terminal");
      if (!element) throw new Error("Missing terminal mount");
      term.loadAddon(new w.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = "11";
      term.open(element);
      w.term = term;
    });
    const cells = await page.evaluate(async () => {
      const term = window.term;
      await new Promise<void>((resolve) =>
        term.write("中文🎉e\u0301A", resolve),
      );
      const line = term.buffer.active.getLine(0);
      return {
        version: term.unicode.activeVersion,
        x: term.buffer.active.cursorX,
        cells: Array.from({ length: 8 }, (_, column) => {
          const cell = line?.getCell(column);
          return { chars: cell?.getChars(), width: cell?.getWidth() };
        }),
      };
    });
    expect(cells.version).toBe("11");
    expect(cells.x).toBe(8);
    expect(cells.cells).toEqual([
      { chars: "中", width: 2 },
      { chars: "", width: 0 },
      { chars: "文", width: 2 },
      { chars: "", width: 0 },
      { chars: "🎉", width: 2 },
      { chars: "", width: 0 },
      { chars: "e\u0301", width: 1 },
      { chars: "A", width: 1 },
    ]);
    // Remove only the sanity probe's current line before product output begins.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => window.term.write("\r\x1b[2K", resolve)),
    );
    const flush = async () => {
      const bytes = pending;
      pending = "";
      await page.evaluate(
        (data) =>
          new Promise<void>((resolve) => {
            window.term.write(data, resolve);
          }),
        bytes,
      );
    };
    const snapshot = () =>
      page.evaluate(() => {
        const term = window.term;
        const b = term.buffer.active;
        return {
          lines: Array.from(
            { length: b.length },
            (_, i) => b.getLine(i)?.translateToString(true) ?? "",
          ),
          x: b.cursorX,
          y: b.cursorY,
          base: b.baseY,
        };
      });
    const resize = async (cols: number, rows: number) => {
      await page.evaluate(({ cols, rows }) => window.term.resize(cols, rows), {
        cols,
        rows,
      });
      output.columns = cols;
      output.rows = rows;
      output.emit("resize");
      await flush();
    };
    await reader.ui.configure({ theme: "dark" });
    for (let i = 0; i < 90; i++)
      reader.ui.append([[{ text: `HISTORY-${String(i).padStart(3, "0")}` }]]);
    reader.ui.append([[{ text: "F".repeat(80) }]]);
    reader.ui.setTail([[{ text: "UNIQUE-TAIL" }]]);
    const answer = reader.question("❯ ", signal());
    void answer.catch(() => {});
    input.write("/mod\x0e");
    await flush();
    const assertHistory = async () => {
      const snap = await snapshot();
      const text = snap.lines.join("\n");
      for (let i = 0; i < 90; i++)
        expect(
          text.split(`HISTORY-${String(i).padStart(3, "0")}`).length - 1,
        ).toBe(1);
      expect(text.split("UNIQUE-TAIL").length - 1).toBe(1);
      expect(
        snap.lines.filter((line) => /^.[ ]\/mode /.test(line)).length,
      ).toBe(1);
      expect(
        snap.lines.filter((line) => /^.[ ]\/model /.test(line)).length,
      ).toBe(1);
      expect(snap.lines.filter((line) => line === "❯ /mod").length).toBe(1);
    };
    await assertHistory();
    for (const [cols, rows] of [
      [40, 30],
      [80, 30],
      [80, 12],
      [80, 30],
    ] as const) {
      await resize(cols, rows);
      await assertHistory();
    }
    input.write("\r");
    expect(await answer).toBe("/mode");
    reader.ui.setBusy(true);
    input.write("a".repeat(78));
    await flush();
    for (const [cols, rows] of [
      [40, 30],
      [80, 30],
      [80, 12],
      [80, 30],
    ] as const) {
      await resize(cols, rows);
      const snap = await snapshot();
      expect(snap.x).toBe(0);
      expect(snap.lines.filter((line) => line.includes("❯ a")).length).toBe(1);
      expect(snap.lines.join("\n").split("UNIQUE-TAIL").length - 1).toBe(1);
    }
    input.write("\x15");

    const draft = `${"中文".repeat(25)}midline-END`;
    input.write(`${draft}\x1b[D\x1b[D\x1b[D`);
    await flush();
    for (const [cols, rows] of [
      [40, 30],
      [80, 30],
      [80, 12],
      [80, 30],
    ] as const) {
      await resize(cols, rows);
      const snap = await snapshot();
      const text = snap.lines.join("\n");

      expect(text.split("midline-END").length - 1).toBe(1);
      expect(text.split("UNIQUE-TAIL").length - 1).toBe(1);
      for (let i = 0; i < 90; i++)
        expect(
          text.split(`HISTORY-${String(i).padStart(3, "0")}`).length - 1,
        ).toBe(1);
      expect(text.split("/mode ").length - 1).toBe(0);
      expect(snap.x).toBe(30);
    }
    const longTail = Array.from(
      { length: 24 },
      (_, i) => `TAIL-${String(i).padStart(2, "0")} ${"paragraph ".repeat(6)}`,
    ).join(" ");
    expect(wrapRichLines([[{ text: longTail }]], 40).length).toBeGreaterThan(
      12,
    );
    reader.ui.setTail([[{ text: longTail }]]);
    await resize(40, 30);
    for (const rows of [12, 30]) {
      await resize(40, rows);
      const snap = await snapshot();
      const text = snap.lines.join("\n");
      expect(text.split("midline-END").length - 1).toBe(1);
      expect(text).not.toContain("UNIQUE-TAIL");
      const tailRows = snap.lines.filter(
        (line) => line.includes("paragraph") || line.includes("TAIL-"),
      );
      expect(tailRows.length).toBeGreaterThan(0);
      expect(tailRows.length).toBeLessThanOrEqual(3);
      expect(
        snap.lines
          .slice(0, snap.base)
          .some((line) => line.includes("paragraph") || line.includes("TAIL-")),
      ).toBe(false);
      for (let i = 0; i < 90; i++)
        expect(
          text.split(`HISTORY-${String(i).padStart(3, "0")}`).length - 1,
        ).toBe(1);
      expect(snap.x).toBe(30);
    }
    reader.ui.setTail([]);
    reader.ui.append([[{ text: longTail }]]);
    await flush();
    const committed = (await snapshot()).lines.join("");
    for (let i = 0; i < 24; i++)
      expect(
        committed.split(`TAIL-${String(i).padStart(2, "0")}`).length - 1,
      ).toBe(1);
    input.write("Z");
    reader.ui.setBusy(false);
    const restored = reader.question("❯ ", signal());
    input.write("\r");
    expect(await restored).toBe(`${draft.slice(0, -3)}ZEND`);
    await flush();
    await resize(80, 24);
    reader.ui.append([[{ text: "LAST-COMMITTED completed · 0 tools" }]]);
    const mixed = `下一个很长的草稿 é 🎉 中文宽度 ${"mixed-width-draft-".repeat(5)}tail`;
    const next = reader.question("❯ ", signal());
    void next.catch(() => {});
    input.write(`${mixed}${"\x1b[D".repeat(4)}MID`);
    await flush();
    const assertLastCommitted = async (cols: number) => {
      const snap = await snapshot();
      const text = snap.lines.join("");
      expect(text.split("LAST-COMMITTED completed · 0 tools").length - 1).toBe(
        1,
      );
      for (let i = 0; i < 90; i++)
        expect(
          text.split(`HISTORY-${String(i).padStart(3, "0")}`).length - 1,
        ).toBe(1);
      expect(text.split(`${mixed.slice(0, -4)}MIDtail`).length - 1).toBe(1);
      expect(snap.x).toBe(cols === 80 ? 46 : 6);
      expect(snap.y + snap.base).toBe(
        snap.lines.findIndex((line) => line.endsWith("MIDtail")),
      );
    };
    await assertLastCommitted(80);
    await resize(40, 12); // Both dimensions change before one output resize event.
    await assertLastCommitted(40);
    await resize(40, 30);
    await assertLastCommitted(40);
    input.write("\r");
    expect(await next).toBe(`${mixed.slice(0, -4)}MIDtail`);
    await flush();
    const finalText = (await snapshot()).lines.join("");
    expect(
      finalText.split("LAST-COMMITTED completed · 0 tools").length - 1,
    ).toBe(1);
    expect(emitted).not.toContain("\x1b[3J");
    expect(emitted).not.toContain("\x1b[?1049h");
    expect(emitted).not.toContain("\x1b[2J");
    expect(finalText).toContain("HISTORY-000");
    expect(finalText).toContain("HISTORY-089");
    // No second completion is appended: the unique sentinel must be the original.
  } finally {
    reader.dispose();
    await browser.close();
  }
}, 30_000);
