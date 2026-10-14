import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNodeIO } from "../../src/cli/cli";
import { TerminalReader } from "../../src/cli/terminal";

const delay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

const reader = (options?: {
  isTTY?: boolean;
  maxLines?: number;
  maxBytes?: number;
}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const instance = new TerminalReader({
    input,
    output,
    isTTY: options?.isTTY ?? false,
    ...(options?.maxLines === undefined ? {} : { maxLines: options.maxLines }),
    ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  // A PassThrough only emits `data` once flowing, and the reader attaches its
  // listener lazily. Real commands attach at the first prompt; tests must do
  // the same before injecting type-ahead.
  const start = async (): Promise<void> => {
    const pending = instance.question("", new AbortController().signal);
    await delay();
    input.write("\n");
    await pending;
  };
  return { input, output, instance, start };
};

describe("TerminalReader streams", () => {
  it("returns pasted lines in order from a single chunk", async () => {
    const { input, instance } = reader();
    input.write("one\ntwo\nthree\n");
    await delay();
    const signal = new AbortController().signal;
    expect(await instance.question("> ", signal)).toBe("one");
    expect(await instance.question("> ", signal)).toBe("two");
    expect(await instance.question("> ", signal)).toBe("three");
  });

  it("assembles a line split across chunk boundaries and strips controls", async () => {
    const { input, instance } = reader();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("> ", signal);
    input.write("hel\u001b[31m");
    input.write("lo\n");
    expect(await pending).toBe("hello");
  });

  it("normalizes CRLF terminators", async () => {
    const { input, instance } = reader();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("> ", signal);
    input.write("a\r\n");
    expect(await pending).toBe("a");
  });

  it("rejects with invalid_input on EOF while waiting", async () => {
    const { input, instance } = reader();
    const pending = instance.question("> ", new AbortController().signal);
    await delay();
    input.end();
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects pending reads with cancelled on abort", async () => {
    const { instance } = reader({ isTTY: true });
    const controller = new AbortController();
    const pending = instance.question("> ", controller.signal);
    await delay();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects an already-aborted signal before reading", async () => {
    const { instance } = reader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      instance.question("> ", controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("TerminalReader fresh reads and type-ahead", () => {
  it("discards a queued complete line on a fresh read (non-tty)", async () => {
    const { input, instance, start } = reader();
    await start();
    input.write("y\n");
    await delay();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("Approve? ", signal, { fresh: true });
    input.write("n\n");
    expect(await pending).toBe("n");
  });

  it("discards an unfinished type-ahead fragment on a fresh read (non-tty)", async () => {
    const { input, instance, start } = reader();
    await start();
    // A pasted/pre-typed approval with no newline.
    input.write("y");
    await delay();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("Approve? ", signal, { fresh: true });
    await delay();
    input.write("\n");
    // The stray `y` was cleared, so only the empty remainder remains.
    expect(await pending).toBe("");
  });

  it("discards readline's unfinished fragment on a fresh read (tty)", async () => {
    const { input, instance, start } = reader({ isTTY: true });
    await start();
    input.write("y");
    await delay();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("Approve? ", signal, { fresh: true });
    await delay();
    input.write("\n");
    expect(await pending).toBe("");
  });

  it("discards a queued complete line on a fresh read (tty)", async () => {
    const { input, instance, start } = reader({ isTTY: true });
    await start();
    input.write("y\n");
    await delay();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("Approve? ", signal, { fresh: true });
    await delay();
    input.write("n\n");
    expect(await pending).toBe("n");
  });

  it("keeps a buffered line for a non-fresh read", async () => {
    const { input, instance, start } = reader();
    await start();
    input.write("keep\n");
    await delay();
    const signal = new AbortController().signal;
    expect(await instance.question("> ", signal)).toBe("keep");
  });
});

describe("TerminalReader bounds", () => {
  it("bounds complete lines by UTF-8 byte length, not code units", async () => {
    const { input, instance } = reader({ maxBytes: 4 });
    const signal = new AbortController().signal;
    // "ééé" is 3 code units but 6 UTF-8 bytes, over the 4-byte bound.
    const pending = instance.question("> ", signal);
    input.write("ééé\n");
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("accepts a line exactly at the UTF-8 byte bound", async () => {
    const { input, instance } = reader({ maxBytes: 4 });
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("> ", signal);
    input.write("éé\n"); // exactly 4 UTF-8 bytes
    expect(await pending).toBe("éé");
  });

  it("bounds an unfinished fragment by UTF-8 bytes", async () => {
    const { input, instance, start } = reader({ maxBytes: 4 });
    await start();
    const pending = instance.question("> ", new AbortController().signal);
    await delay();
    input.write("ééé"); // 6 bytes, no newline
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reports an overflow safely when idle instead of dropping silently", async () => {
    const { input, instance, start } = reader({ maxBytes: 4 });
    await start();
    input.write("toolong\n");
    await delay();
    await expect(
      instance.question("> ", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("enforces the queued-line cap instead of dropping silently", async () => {
    const { input, instance, start } = reader({ maxLines: 1 });
    await start();
    input.write("a\nb\n");
    await delay();
    await expect(
      instance.question("> ", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("TerminalReader lifecycle", () => {
  it("does not attach stdin listeners until a question is asked", () => {
    const { input, instance } = reader();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    instance.dispose();
    expect(input.listenerCount("data")).toBe(0);
  });

  it("detaches stdin listeners and rejects the pending read on dispose", async () => {
    const { input, instance } = reader();
    const pending = instance.question("> ", new AbortController().signal);
    await delay();
    expect(input.listenerCount("data")).toBe(1);
    instance.dispose();
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects a replaced question so its promise never hangs", async () => {
    const { input, instance } = reader({ isTTY: true });
    const first = instance.question("first ", new AbortController().signal);
    await delay();
    const second = instance.question("second ", new AbortController().signal);
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    input.write("ok\n");
    expect(await second).toBe("ok");
  });

  it("does not surface the EOF error twice", async () => {
    const { input, instance } = reader();
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("> ", signal);
    await delay();
    input.end();
    await expect(pending).rejects.toMatchObject({ code: "invalid_input" });
    await expect(instance.question("> ", signal)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("createNodeIO wiring", () => {
  const nodeIO = (input: PassThrough, isTTY = false) => {
    const io = createNodeIO({
      stdin: input,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY,
    });
    return io;
  };

  it("preserves sequential pasted commands instead of losing the tail", async () => {
    const input = new PassThrough();
    const io = nodeIO(input);
    const signal = new AbortController().signal;
    const first = io.question("forge> ", signal);
    await delay();
    input.write("/diagnostics\n/context\n/skills\n");
    expect(await first).toBe("/diagnostics");
    expect(await io.question("forge> ", signal)).toBe("/context");
    expect(await io.question("forge> ", signal)).toBe("/skills");
    io.dispose?.();
  });

  it("does not let buffered type-ahead approve via readApproval", async () => {
    const input = new PassThrough();
    const io = nodeIO(input);
    const signal = new AbortController().signal;
    // Complete a normal read so the reader is flowing (as in a real loop).
    const warm = io.question("forge> ", signal);
    await delay();
    input.write("\n");
    expect(await warm).toBe("");
    // A stray approval pre-typed with no newline while the model was working.
    input.write("y");
    await delay();
    const approval = io.readApproval?.("Approve? ", signal);
    await delay();
    input.write("\n");
    // Fresh read discards the stray `y`; blank answer is not approval.
    expect(await approval).toBe(false);
    io.dispose?.();
  });

  it("reads POST-prompt fresh approval as approval", async () => {
    const input = new PassThrough();
    const io = nodeIO(input);
    const signal = new AbortController().signal;
    const warm = io.question("forge> ", signal);
    await delay();
    input.write("\n");
    await warm;
    const approval = io.readApproval?.("Approve? ", signal);
    await delay();
    input.write("yes\n");
    expect(await approval).toBe(true);
    io.dispose?.();
  });
});

describe("TerminalReader SIGINT draft lifecycle (TTY)", () => {
  it("first SIGINT clears typed draft line and second SIGINT triggers interrupt callback", async () => {
    let interrupted = false;
    const input = new PassThrough();
    const output = new PassThrough();
    const instance = new TerminalReader({
      input,
      output,
      isTTY: true,
      onInterrupt: () => {
        interrupted = true;
      },
    });
    await instance.ui.configure({ theme: "dark" });
    const signal = new AbortController().signal;
    const pending = instance.question("> ", signal);
    pending.catch(() => {});
    await delay();
    input.write("/model");
    await delay();
    input.write("\u0003");
    await delay();
    expect(interrupted).toBe(false);
    input.write("\u0003");
    await delay();
    expect(interrupted).toBe(true);
    instance.dispose();
  });
});

it("keeps NodeIO lazy and refuses rich capability for redirected stdout", () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: false });
  const error = Object.assign(new PassThrough(), { isTTY: true });
  const io = createNodeIO({ stdin: input, stdout: output, stderr: error });
  expect(io.ui).toBeUndefined();
  expect(io.isTTY).toBe(false);
  expect(input.listenerCount("data")).toBe(0);
  io.dispose?.();
});

it("explicit false suppresses rich UI even with three actual TTY streams", () => {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = Object.assign(new PassThrough(), { isTTY: true });
  const io = createNodeIO({ stdin, stdout, stderr, isTTY: false });
  expect(io.ui).toBeUndefined();
  expect(stdin.listenerCount("data")).toBe(0);
  const initial = stdin.listenerCount("end");
  const off = io.onClose?.(() => {});
  expect(stdin.listenerCount("end")).toBe(initial + 1);
  expect(stdin.listenerCount("data")).toBe(0);
  off?.();
  expect(stdin.listenerCount("end")).toBe(initial);
  io.dispose?.();
});
