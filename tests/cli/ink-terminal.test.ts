import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeIO } from "../../src/cli/node-io";
import { InkController } from "../../src/cli/ink/controller";
import { TerminalReader } from "../../src/cli/terminal";
import { stripAnsi } from "../../src/cli/theme";

class Input extends PassThrough {
  isTTY = true;
  isRaw = false;
  setRawMode(value: boolean): this { this.isRaw = value; return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
class Output extends PassThrough { isTTY = true; columns = 80; rows = 24; }
const signal = () => new AbortController().signal;
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.unstubAllEnvs(); });
function fixture(maxBytes?: number) {
  const input = new Input();
  const output = new Output();
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); });
  const interrupt = vi.fn();
  const closed = vi.fn();
  const reader = new TerminalReader({ input, output, isTTY: true,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    onInterrupt: interrupt, onClose: closed, createController: options => new InkController(options) });
  cleanup.push(() => reader.dispose());
  return { input, output, reader, interrupt, closed, bytes: () => bytes };
}

describe("Ink terminal migration", () => {
  it("cleans the TUI on SIGHUP without retaining process listeners", async () => {
    const input = new Input(); const output = new Output(); output.on("data", () => {});
    const io = createNodeIO({ stdin: input, stdout: output, stderr: output });
    // Ink/cli-cursor installs a process-wide exit hook on first mount.
    await io.ui!.configure({ theme: "dark" });
    const before = process.listenerCount("SIGHUP");
    const closed = vi.fn(); const off = io.onClose!(closed);
    try {
      process.emit("SIGHUP");
      expect(closed).toHaveBeenCalledOnce();
      expect(input.isRaw).toBe(false);
    } finally { off(); await io.dispose?.(); }
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  it("screen-reader mode suppresses timer-only animation and partial tail churn", async () => {
    vi.stubEnv("INK_SCREEN_READER", "true");
    const f = fixture(); await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.setStatus({ label: "Thinking", startedAt: Date.now(), toolCount: 0, cancellable: true });
    await settle(); const before = f.bytes();
    f.reader.ui.setTail([[{ text: "hidden partial stream" }]]);
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(f.bytes()).toBe(before);
    f.reader.ui.append([[{ text: "completed accessible answer" }]]);
    await settle(); expect(f.bytes()).toContain("completed accessible answer");
  });

  it("freezes reading while output advances, and returns to live without submitting keys", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.setTail(Array.from({ length: 80 }, (_, i) => [{ text: `live-line-${i}` }]));
    f.input.write("draft\x1b[5~");
    await settle();
    expect(stripAnsi(f.bytes())).toContain("Reading");
    const before = f.bytes();
    f.reader.ui.update!({ append: [[{ text: "completed-while-reading" }]], tail: [], status: null });
    await settle();
    expect(f.bytes()).toBe(before);
    f.input.write("\r");
    f.input.write("\x1b[F");
    await settle();
    expect(stripAnsi(f.bytes())).toContain("completed-while-reading");
    const answer = f.reader.question("❯ ", signal());
    f.input.write("\r");
    expect(await answer).toBe("draft");
  });

  it("approval exits reading and always presents a fresh prompt", async () => {
    const f = fixture(); await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.setTail([[{ text: "reading content" }]]);
    f.input.write("\x1b[5~");
    const approval = f.reader.readApproval("Approve? ", signal());
    f.input.write("n\r"); expect(await approval).toBe(false);
  });

  it("keeps single-request approval visible without mounting Ink", async () => {
    const f = fixture();
    const approval = f.reader.readApproval("Approval: run_command\nargv: [test]\nApprove? [Y/n] ", signal());
    expect(f.bytes()).toContain("argv: [test]");
    expect(f.bytes()).not.toContain("\x1b");
    f.input.write("n\r");
    expect(await approval).toBe(false);
  });

  it("uses Ink fullscreen through the default rich adapter without mouse capture", async () => {
    const input = new Input();
    const output = new Output();
    let bytes = "";
    output.on("data", chunk => { bytes += chunk.toString(); });
    const io = createNodeIO({ stdin: input, stdout: output, stderr: output });
    cleanup.push(() => { void io.dispose?.(); });
    await io.ui!.configure({ theme: "dark" });
    io.ui!.append([[{ text: "ink-static-marker" }]]);
    const answer = io.question("❯ ", signal());
    input.write("hello\r");
    expect(await answer).toBe("hello");
    await settle();
    expect(stripAnsi(bytes)).toContain("ink-static-marker");
    expect(bytes).toContain("\x1b[?1049h");
    expect(bytes).not.toMatch(/\x1b\[\?(?:1002|1006)h/);
    await io.dispose?.();
    expect(bytes).toContain("\x1b[?1049l");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);
  });

  it("retains multiline Unicode draft/cursor across streaming, resize and fresh approval", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.setBusy(true);
    f.input.write("\x1b[200~first\n中👩‍💻ab\x1b[201~\x1b[D");
    f.reader.ui.setTail([[{ text: "live tail" }]]);
    f.output.columns = 20; f.output.emit("resize");
    const approved = f.reader.readApproval("Approve? [Y/n] ", signal());
    f.input.write("y\r");
    expect(await approved).toBe(true);
    f.reader.ui.setBusy(false);
    const next = f.reader.question("❯ ", signal());
    f.input.write("Z\r");
    expect(await next).toBe("first\n中👩‍💻aZb");
  });

  it.each(["\x1b[200~y\n\x1b[201~", "\x1b[200~\x1b[Z\x1b[201~", "\x1b[A"])("never approves tainted confirmation %j", async payload => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    const approved = f.reader.readApproval("Approve? ", signal());
    f.input.write(payload + "\r");
    expect(await approved).toBe(false);
  });

  it("keeps split paste taint across approval boundaries and discards typeahead", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    f.input.write("y\r\x1b[200~");
    const approved = f.reader.readApproval("Approve? ", signal());
    f.input.write("y\n\x1b[201~\r");
    expect(await approved).toBe(false);
    const fresh = f.reader.readApproval("Approve? ", signal());
    f.input.write("\r");
    expect(await fresh).toBe(true);
  });

  it("completes slash commands, preserves dismissed drafts and toggles mode", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    const toggle = vi.fn(); f.reader.ui.onModeToggle!(toggle);
    const first = f.reader.question("❯ ", signal());
    f.input.write("/mod\tchosen\r");
    expect(await first).toBe("/model chosen");
    const second = f.reader.question("❯ ", signal());
    f.input.write("/mod\x1b"); await settle(); f.input.write("\r");
    expect(await second).toBe("/mod");
    f.input.write("\x1b[Z");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("routes follow-ups and steering once, retaining history", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    const received = vi.fn();
    f.reader.ui.setBusy(true);
    const off = f.reader.onRunInput(received);
    f.input.write("follow\rsteer\x1b\r");
    expect(received.mock.calls).toEqual([["follow", false], ["steer", true]]);
    off(); f.reader.ui.setBusy(false);
    const next = f.reader.question("❯ ", signal());
    f.input.write("\x1b[A\r");
    expect(await next).toBe("steer");
  });

  it("refreshes picker selection by identity and blocks pasted stop confirmation", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    const items = [{ value: "a", label: "agent alpha" }, { value: "b", label: "agent beta" }];
    const choice = f.reader.ui.choose({ title: "Tasks", items }, signal());
    f.input.write("agent\x1b[B");
    f.reader.ui.updatePicker!({ title: "Tasks", items: [...items].reverse() });
    f.input.write("\r");
    expect(await choice).toBe("b");
    const stop = f.reader.ui.choose({ title: "Stop?", confirmation: true, items }, signal());
    f.input.write("\x1b[200~beta\x1b[201~\r");
    expect(await stop).toBeNull();
    const cancelled = f.reader.ui.choose({ title: "Tasks", items }, signal());
    f.input.write("\x03");
    expect(await cancelled).toBeNull();
    expect(f.interrupt).not.toHaveBeenCalled();
  });

  it("cleans input, timers, pending pickers and raw mode on EOF", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    const choice = f.reader.ui.choose({ title: "Pick", items: [] }, signal());
    f.reader.ui.setStatus({ label: "Working", startedAt: Date.now(), toolCount: 0, cancellable: true });
    f.input.write("\x04");
    expect(await choice).toBeNull();
    expect(f.closed).toHaveBeenCalledOnce();
    expect(f.input.isRaw).toBe(false);
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.output.listenerCount("resize")).toBe(0);
    const bytes = f.bytes();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(f.bytes()).toBe(bytes);
  });

  it("recovers from bounded-input overflow and prompt cancellation", async () => {
    const f = fixture(16);
    await f.reader.ui.configure({ theme: "dark" });
    const abort = new AbortController();
    const first = f.reader.question("❯ ", abort.signal);
    abort.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    const pick = f.reader.ui.choose({ title: "Pick", items: [] }, signal());
    f.input.write("x".repeat(17));
    expect(await pick).toBeNull();
    await expect(f.reader.question("❯ ", signal())).rejects.toMatchObject({ code: "invalid_input" });
    const next = f.reader.question("❯ ", signal());
    f.input.write("ok\r");
    expect(await next).toBe("ok");
  });

  it("approval preempts task focus without leaking its answer into follow-ups", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.setBusy(true);
    const received = vi.fn();
    const off = f.reader.onRunInput(received);
    f.input.write("draft中\x1b[D");
    const task = f.reader.ui.choose({ title: "Tasks", items: [{ value: "a", label: "agent" }] }, signal());
    f.input.write("agent");
    const approval = f.reader.readApproval("Approve? ", signal());
    expect(await task).toBeNull();
    f.input.write("n\r");
    expect(await approval).toBe(false);
    expect(received).not.toHaveBeenCalled();
    f.input.write("Z\r");
    expect(received.mock.calls).toEqual([["draftZ中", false]]);
    off();
  });

  it("denies an overflowing approval while retaining the suspended draft", async () => {
    const f = fixture(16);
    await f.reader.ui.configure({ theme: "dark" });
    f.input.write("draft\x1b[D");
    const approval = f.reader.readApproval("Approve? ", signal());
    f.input.write("x".repeat(17));
    expect(await approval).toBe(false);
    const next = f.reader.question("❯ ", signal());
    f.input.write("Z\r");
    expect(await next).toBe("drafZt");
  });

  it("restores the existing raw mode if disposed while Ink is loading", async () => {
    const f = fixture();
    f.input.isRaw = true;
    const mounting = f.reader.ui.configure({ theme: "dark" });
    f.reader.dispose();
    await mounting;
    expect(f.input.isRaw).toBe(true);
    expect(f.output.listenerCount("resize")).toBe(0);
    expect(f.input.listenerCount("data")).toBe(0);
  });

  it("commits history once while replacing tail and sanitizing controls", async () => {
    const f = fixture();
    await f.reader.ui.configure({ theme: "dark" });
    f.reader.ui.append([[{ text: "unique-committed" }]]);
    f.reader.ui.setTail([[{ text: "partial-tail" }]]);
    await settle();
    f.reader.ui.update!({ append: [[{ text: "final-tail\x1b]52;c;bad\x07" }]], tail: [], status: null });
    await settle();
    expect(stripAnsi(f.bytes()).match(/unique-committed/g)).toHaveLength(1);
    expect(stripAnsi(f.bytes())).toContain("final-tail");
    expect(f.bytes()).not.toContain("\x1b]52;");
  });
});
