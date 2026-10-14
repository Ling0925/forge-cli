import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
describe("live slash composer", () => {
  beforeEach(() => vi.stubEnv("TERM", "xterm-256color"));
  afterEach(() => vi.unstubAllEnvs());
  it("reserves rows below composer, intercepts arrows, completes Enter and preserves Escape draft", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (data) => {
      transcript += data.toString();
    });
    const reader = new TerminalReader({ input, output, isTTY: true });
    await reader.ui.configure({ theme: "dark" });
    const pending = reader.question("❯ ", new AbortController().signal);
    input.write("/mod");
    await tick();
    const screen = cells(transcript);
    expect(screen.rows[screen.row]).toBe("❯ /mod");
    expect(screen.rows.slice(screen.row + 1).join("\n")).toContain("/model");
    expect(screen.col).toBe(6);
    input.write("\u001b[B");
    await tick();
    expect(cells(transcript).rows.slice(1).join("\n")).toContain("/mode");
    input.write("\r");
    expect(await pending).toBe("/mode");
    const next = reader.question("❯ ", new AbortController().signal);
    input.write("/hel");
    await tick();
    input.write("\u001b");
    await tick();
    input.write("p\r");
    expect(await next).toBe("/help");
    reader.dispose();
  });
  it("preserves exact command on Enter unless selection was navigated", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new TerminalReader({ input, output, isTTY: true });
    await reader.ui.configure({ theme: "dark" });
    const pending = reader.question("❯ ", new AbortController().signal);
    input.write("/mode\r");
    expect(await pending).toBe("/mode");
    const next = reader.question("❯ ", new AbortController().signal);
    input.write("/mode\u001b[B\u001b[A\r");
    expect(await next).toBe("/model");
    reader.dispose();
  });
  it("appends a separator when Tab completes an exact command", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new TerminalReader({ input, output, isTTY: true });
    await reader.ui.configure({ theme: "dark" });
    const pending = reader.question("❯ ", new AbortController().signal);
    input.write("/model\tgpt\r");
    expect(await pending).toBe("/model gpt");
    reader.dispose();
  });
  it("repaints on resize and preserves a long CJK draft", async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 40 });
    let transcript = "";
    output.on("data", (data) => {
      transcript += data.toString();
    });
    const reader = new TerminalReader({ input, output, isTTY: true });
    await reader.ui.configure({ theme: "dark" });
    const pending = reader.question("❯ ", new AbortController().signal);
    input.write("/mod");
    await tick();
    expect(cells(transcript).rows.slice(1).join("\n")).toContain("/model");
    output.columns = 80;
    output.emit("resize");
    expect(cells(transcript).rows.slice(1).join("\n")).toContain("/model");
    input.write(` ${"中文".repeat(50)}\r`);
    expect(await pending).toBe(`/mod ${"中文".repeat(50)}`);
    reader.dispose();
  });
  it("disables suggestions and discards partial typeahead on fresh approval", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new TerminalReader({ input, output, isTTY: true });
    await reader.ui.configure({ theme: "dark" });
    const ctrl = new AbortController();
    const old = reader.question("❯ ", ctrl.signal).catch(() => "cancelled");
    input.write("/hel");
    await tick();
    ctrl.abort();
    await old;
    const fresh = reader.question(
      "Approve? [y/N] ",
      new AbortController().signal,
      { fresh: true },
    );
    input.write("n\r");
    expect(await fresh).toBe("n");
    reader.dispose();
  });
});

// Small VT cell model: cursor movement and erase-below must affect assertions.
function cells(text: string) {
  const grid: string[][] = [[]];
  let row = 0;
  let col = 0;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: parse terminal output
  const tokens = text.match(/\x1b\[[0-9;]*[A-Za-z]|[^\x1b]/gu) ?? [];
  for (const token of tokens) {
    if (token.startsWith("\u001b[")) {
      const n = Number(token.slice(2, -1)) || 1;
      switch (token.at(-1)) {
        case "A":
          row = Math.max(0, row - n);
          break;
        case "B":
          row += n;
          break;
        case "G":
          col = n - 1;
          break;
        case "C":
          col += n;
          break;
        case "D":
          col = Math.max(0, col - n);
          break;
        case "K":
          grid[row] = [];
          break;
        case "J":
          grid[row] = (grid[row] ?? []).slice(0, col);
          grid.splice(row + 1);
          break;
      }
    } else if (token === "\r") col = 0;
    else if (token === "\n") row++;
    else {
      const line = grid[row] ?? [];
      grid[row] = line;
      line[col++] = token;
    }
  }
  return { rows: grid.map((line) => line.join("")), row, col };
}
