import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LiveRun } from "../../src/cli/live-run";
import { createNodeIO } from "../../src/cli/node-io";
import { TerminalReader } from "../../src/cli/terminal";
import { resolveTheme } from "../../src/cli/theme";
import type { RenderUpdate, TerminalUI } from "../../src/cli/ui-contract";
import type { AgentEvent } from "../../src/shared/schemas";

class Input extends PassThrough {
  isRaw = false;
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
}

class Output extends PassThrough {
  columns = 40;
  rows = 10;
}

const signal = (): AbortSignal => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(onClose?: () => void) {
  const input = new Input();
  const output = new Output();
  const reader = new TerminalReader({
    input,
    output,
    isTTY: true,
    ...(onClose ? { onClose } : {}),
  });
  return { input, output, reader };
}

describe("run input", () => {
  it.each(["\x1b\r", "\x1b\n", "\x1b[13;3u", "\x1b[27;3;13~", "\x1b[13;3~"])("steers with Alt+Enter %j but never submits pasted shortcuts", async sequence => {
    const { input, reader } = fixture();
    try {
      await reader.ui.configure({ theme: "dark" });
      const lines: Array<[string, boolean | undefined]> = [];
      reader.onRunInput((line, steer) => lines.push([line, steer]));
      reader.ui.setBusy(true);
      input.write("adjust direction");
      // Split the protocol sequence at every byte, as real terminal IO may do.
      for (const byte of sequence) input.write(byte);
      expect(lines).toEqual([["adjust direction", true]]);
      input.write(`\x1b[200~pasted${sequence}\x1b[201~`);
      expect(lines).toHaveLength(1);
      const approval = reader.readApproval("Approve? [Y/n] ", signal());
      input.write(sequence); expect(await approval).toBe(false);
    } finally { reader.dispose(); }
  });
  it("keeps a busy draft when no run-input listener is subscribed", async () => {
    const { input, reader } = fixture();
    await reader.ui.configure({ theme: "dark" });
    const first = reader.question("❯ ", signal());
    input.write("start\r");
    expect(await first).toBe("start");

    reader.ui.setBusy(true);
    input.write("queued draft\r");
    await tick();
    reader.ui.setBusy(false);

    const next = reader.question("❯ ", signal());
    input.write("\r");
    expect(await next).toBe("queued draft");
    reader.dispose();
  });

  it("drains normal queued lines FIFO and delivers busy Enter submissions", async () => {
    const { input, reader } = fixture();
    await reader.ui.configure({ theme: "dark" });
    input.write("one\r");
    input.write("two\r");

    const lines: string[] = [];
    const unsubscribe = reader.onRunInput((line) => lines.push(line));
    expect(lines).toEqual(["one", "two"]);
    expect(() => reader.onRunInput(() => {})).toThrow(/run input/i);

    reader.ui.setBusy(true);
    input.write("three\r");
    expect(lines).toEqual(["one", "two", "three"]);
    unsubscribe();
    reader.dispose();
  });

  it("submits slash while busy without a run listener and distinguishes Enter from Shift+Enter", async () => {
    const { input, reader } = fixture();
    await reader.ui.configure({ theme: "dark" });
    const lines: Array<[string, boolean | undefined]> = [];
    reader.ui.setBusy(true);
    input.write("/help\r");
    const unsubscribe = reader.onRunInput((line, steer) => lines.push([line, steer]));
    expect(lines).toEqual([["/help", undefined]]);
    input.write("follow-up\r");
    input.write("steer\x1b[13;2u");
    expect(lines).toEqual([["/help", undefined], ["follow-up", false], ["steer", true]]);
    unsubscribe();
    reader.dispose();
  });

  it("forwards non-TTY run input through NodeIO", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const io = createNodeIO({ stdin: input, stdout: output, stderr: error, isTTY: false });
    const lines: string[] = [];
    const unsubscribe = io.onRunInput?.((line) => lines.push(line));
    input.write("plain one\nplain two\n");
    expect(lines).toEqual(["plain one", "plain two"]);
    unsubscribe?.();
    io.dispose?.();
  });

  it("does not let queued or pasted y approve a fresh approval", async () => {
    const { input, reader } = fixture();
    await reader.ui.configure({ theme: "dark" });
    input.write("y\r");

    const queued = reader.readApproval("Approve? [Y/n] ", signal());
    let settled = false; void queued.then(() => { settled = true; });
    await tick(); expect(settled).toBe(false);
    input.write("n\r");
    expect(await queued).toBe(false);

    const pasted = reader.readApproval("Approve? [Y/n] ", signal());
    input.write("\x1b[200~y\r\x1b[201~");
    await tick();
    input.write("\r");
    expect(await pasted).toBe(false);
    reader.dispose();
  });

  it("restores a busy draft after a fresh approval", async () => {
    const { input, reader } = fixture();
    await reader.ui.configure({ theme: "dark" });
    reader.ui.setBusy(true);
    input.write("draft");

    const approval = reader.readApproval("Approve? [Y/n] ", signal());
    input.write("no\r");
    expect(await approval).toBe(false);

    reader.ui.setBusy(false);
    const next = reader.question("❯ ", signal());
    input.write("\r");
    expect(await next).toBe("draft");
    reader.dispose();
  });

  it("stops busy submissions after unsubscribe and still handles EOF", async () => {
    const onClose = vi.fn();
    const { input, reader } = fixture(onClose);
    await reader.ui.configure({ theme: "dark" });
    const lines: string[] = [];
    const unsubscribe = reader.onRunInput((line) => lines.push(line));

    reader.ui.setBusy(true);
    input.write("during\r");
    expect(lines).toEqual(["during"]);
    unsubscribe();
    input.write("after\r");
    expect(lines).toEqual(["during"]);

    reader.ui.setBusy(false);
    const next = reader.question("❯ ", signal());
    input.write("\r");
    expect(await next).toBe("after");

    const pending = reader.question("❯ ", signal());
    input.end();
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("live run atomic render", () => {
  it("uses TerminalUI.update when available", () => {
    const updates: RenderUpdate[] = [];
    const append = vi.fn();
    const setTail = vi.fn();
    const setStatus = vi.fn();
    const ui: TerminalUI = {
      columns: 80,
      rows: 24,
      configure: async () => undefined,
      append,
      setTail,
      setStatus,
      setBusy: () => undefined,
      choose: async () => null,
      approve: async () => false,
      update: (update) => updates.push(update),
      setInputHint: () => undefined,
      dispose: () => undefined,
    };
    const io = {
      isTTY: true,
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => "",
      question: async () => "",
      onInterrupt: () => () => undefined,
      ui,
    };
    const theme = resolveTheme({
      setting: "dark",
      background: "dark",
      colorDepth: 24,
      noColor: false,
      dumb: false,
    });
    const run = new LiveRun(io, theme);

    run.event({ type: "run_started" } as AgentEvent);
    run.event({ type: "text_delta", text: "hello" } as AgentEvent);
    run.dispose();

    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((update) => update.tail.length || update.append.length)).toBe(true);
    expect(append).not.toHaveBeenCalled();
    expect(setTail).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
  });
});
