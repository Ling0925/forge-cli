import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { Screen, composerLayout } from "../../src/cli/terminal/screen";
import { stripAnsi } from "../../src/cli/theme";

class Input extends PassThrough {
  isRaw = false;
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}
class Output extends PassThrough {
  columns = 19;
  rows = 8;
}
function fixture() {
  const input = new Input();
  const output = new Output();
  let bytes = "";
  output.on("data", (chunk: Buffer) => {
    bytes += chunk.toString();
  });
  const interrupt = vi.fn();
  const reader = new TerminalReader({
    input,
    output,
    isTTY: true,
    onInterrupt: interrupt,
  });
  return { input, output, interrupt, reader, bytes: () => bytes };
}
const signal = () => new AbortController().signal;
it("retains grapheme draft and midline cursor during busy streaming, does not dispatch", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  const first = f.reader.question("❯ ", signal());
  f.input.write("run\r");
  expect(await first).toBe("run");
  f.reader.ui.setBusy(true);
  f.input.write("中👩‍💻abc\x1b[D\x7fZ\r");
  f.reader.ui.setStatus({
    label: "Thinking",
    startedAt: Date.now(),
    toolCount: 1,
    cancellable: true,
  });
  f.reader.ui.setTail([[{ text: "assistant tail" }]]);
  f.reader.ui.append([[{ text: "permanent" }]]);
  expect(f.bytes()).toContain("中👩‍💻aZc");
  f.input.write("\x03");
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  f.reader.ui.setBusy(false);
  const next = f.reader.question("❯ ", signal());
  f.input.write("\r");
  expect(await next).toBe("中👩‍💻aZc");
  f.reader.dispose();
  expect(f.input.isRaw).toBe(false);
  expect(f.bytes()).toContain("\x1b[?2004l");
  expect(f.input.listenerCount("data")).toBe(0);
});
it("keeps filtered menu through resize and Esc preserves draft; CtrlP/N selects", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "light" });
  const answer = f.reader.question("❯ ", signal());
  f.input.write("/mod");
  f.output.columns = 9;
  f.output.emit("resize");
  f.input.write("\x0e\x10\r");
  expect(await answer).toBe("/model");
  const draft = f.reader.question("❯ ", signal());
  f.input.write("/mod\x1b");
  await new Promise((resolve) => setTimeout(resolve, 45));
  f.input.write("\r");
  expect(await draft).toBe("/mod");
  f.reader.dispose();
});
it("retains transcript in alternate viewport and restores terminal modes on EOF", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  for (let i = 0; i < 30; i++)
    f.reader.ui.append([[{ text: `transcript-${i}` }]]);
  f.input.write("draft");
  f.reader.ui.setTail([[{ text: "tail" }]]);
  f.output.columns = 12;
  f.output.emit("resize");
  expect(stripAnsi(f.bytes())).toContain("transcript");
  expect(f.bytes()).toContain("\x1b[?1049h");
  expect(f.bytes()).toContain("\x1b[?1006h");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: verifies absence of destructive terminal sequences
  expect(f.bytes()).not.toMatch(/\x1b\[3J/);
  f.input.write("\x04");
  expect(f.input.isRaw).toBe(false);
  expect(f.bytes()).toContain("\x1b[?1002l\x1b[?1006l");
  f.reader.dispose();
});
it("idle CtrlC clears first, exits second and resets after question return", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  const answer = f.reader.question("❯ ", signal());
  f.input.write("draft\x03");
  expect(f.interrupt).not.toHaveBeenCalled();
  f.input.write("\x03");
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  f.input.write("ok\r");
  expect(await answer).toBe("ok");
  f.input.write("new\x03\x03");
  expect(f.interrupt).toHaveBeenCalledTimes(2);
  f.reader.dispose();
});
it("plain nonTTY lifecycle emits no escapes and has bounded FIFO", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let bytes = "";
  output.on("data", (chunk: Buffer) => {
    bytes += chunk.toString();
  });
  const reader = new TerminalReader({
    input,
    output,
    isTTY: false,
    maxLines: 2,
  });
  await reader.ui.configure({ theme: "dark" });
  const first = reader.question("> ", signal());
  input.write("one\r\ntwo\nthree\n");
  expect(await first).toBe("one");
  expect(await reader.question("", signal())).toBe("two");
  expect(await reader.question("", signal())).toBe("three");
  reader.ui.append([[{ text: "untrusted\x1b[2J" }]]);
  expect(bytes).not.toContain("\x1b");
  reader.dispose();
});
it("physical composer uses wide graphemes and exact-width autowrap row", () => {
  const layout = composerLayout("❯ 中👩‍💻ab", "❯ 中👩‍💻ab".length, 6);
  expect(
    layout.lines.map((line) => line.map((span) => span.text).join("")),
  ).toEqual(["❯ 中👩‍💻", "ab"]);
  expect(layout.row).toBe(1);
  expect(layout.column).toBe(2);
  expect(composerLayout("abcd", 4, 4)).toMatchObject({ row: 1, column: 0 });
});

it("recovers abort and picker overflow without disabling raw lifecycle", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  const abort = new AbortController();
  const first = f.reader.question("❯ ", abort.signal);
  abort.abort();
  await expect(first).rejects.toThrow();
  expect(f.input.isRaw).toBe(true);
  const next = f.reader.question("❯ ", signal());
  f.input.write("/mod\r");
  expect(await next).toBe("/model");
  f.reader.dispose();
  const input = new Input();
  const output = new Output();
  const reader = new TerminalReader({
    input,
    output,
    isTTY: true,
    maxBytes: 16,
  });
  await reader.ui.configure({ theme: "dark" });
  const pick = reader.ui.choose({ title: "Pick", items: [] }, signal());
  input.write("x".repeat(17));
  expect(await pick).toBeNull();
  expect(input.isRaw).toBe(true);
  reader.dispose();
});
it("approval suspends and restores multiline busy draft with cursor", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  f.reader.ui.setBusy(true);
  f.input.write("\x1b[200~first\nsecond\x1b[201~\x1b[D");
  const approval = f.reader.readApproval("?", signal());
  f.input.write("y\r");
  expect(await approval).toBe(true);
  f.input.write("Z");
  f.reader.ui.setBusy(false);
  const answer = f.reader.question("❯ ", signal());
  f.input.write("\r");
  expect(await answer).toBe("first\nseconZd");
  f.reader.dispose();
});
it("coalesces a substantial paste into bounded repaint output and never revives disposal", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  const before = f.bytes().length;
  f.input.write(`\x1b[200~${"x".repeat(4096)}\x1b[201~`);
  expect(f.bytes().length - before).toBeLessThan(1000);
  f.reader.dispose();
  const stopped = f.bytes();
  await f.reader.ui.configure({ theme: "system" });
  f.reader.ui.append([[{ text: "late" }]]);
  expect(f.bytes()).toBe(stopped);
});
it("full-width followed by newline consumes one physical break", () => {
  expect(
    composerLayout("abcd\nx", 6, 4).lines.map((line) =>
      line.map((span) => span.text).join(""),
    ),
  ).toEqual(["abcd", "x"]);
});

it("CtrlC during approval denies and interrupts the active run", async () => {
  const f = fixture();
  await f.reader.ui.configure({ theme: "dark" });
  f.reader.ui.setBusy(true);
  f.input.write("busy-draft");
  const approval = f.reader.readApproval("?", signal());
  f.input.write("\x03");
  expect(await approval).toBe(false);
  expect(f.interrupt).toHaveBeenCalledTimes(1);
  f.reader.ui.setBusy(false);
  const next = f.reader.question("❯ ", signal());
  f.input.write("\r");
  expect(await next).toBe("busy-draft");
  f.reader.dispose();
});

it("composer placeholder, accent spans, stable dock and aligned menu preserve input cursor", async () => {
  const paint = vi.spyOn(Screen.prototype, "paint");
  const f = fixture();
  try {
    await f.reader.ui.configure({ theme: "dark" });
    const empty = paint.mock.calls.at(-1);
    expect(empty?.[0][empty?.[1] ?? 0]?.map((span) => span.text).join("")).toContain("Ask anything");
    expect(empty?.[1]).toBe(1);
    expect(empty?.[0]).toHaveLength(4);
    expect(
      empty?.[0].flat().find((span) => span.text.includes("Ask anything"))
        ?.tone,
    ).toBe("muted");
    expect(empty?.[2]).toBe(2);
    const question = f.reader.question("❯ ", signal());
    void question.catch(() => {});
    f.input.write("/mod");
    const frame = paint.mock.calls.at(-1)?.[0] ?? [];
    const composer = frame.find(
      (line) => line.map((span) => span.text).join("") === "❯ /mod",
    );
    expect(composer).toEqual([
      { text: "❯ ", tone: "accent" },
      { text: "/mod" },
    ]);
    expect(
      frame.flat().some((span) => span.text.includes("Ask anything")),
    ).toBe(false);
    const options = frame.filter(
      (line) =>
        line[1]?.text.startsWith("/mod") && line[0]?.inverse !== undefined,
    );
    expect(options).toHaveLength(2);
    const descriptions = options.map(
      (line) => line[1]?.text.match(/^\/\S+\s+/)?.[0].length,
    );
    expect(descriptions[0]).toBe(descriptions[1]);
    expect(options[0]?.[0]).toMatchObject({
      text: "❯ ",
      tone: "accent",
      inverse: true,
    });
    f.input.write("\r");
    expect(await question).toBe("/model");
    const approval = f.reader.readApproval("?", signal());
    expect(
      paint.mock.calls
        .at(-1)?.[0]
        .flat()
        .some((span) => span.text.includes("Ask anything")),
    ).toBe(false);
    f.input.write("n\r");
    expect(await approval).toBe(false);
    f.output.rows = 2;
    f.output.emit("resize");
    const small = paint.mock.calls.at(-1);
    expect(small?.[0]).toHaveLength(1);
    expect(small?.[1]).toBe(0);
  } finally {
    f.reader.dispose();
    paint.mockRestore();
  }
});
