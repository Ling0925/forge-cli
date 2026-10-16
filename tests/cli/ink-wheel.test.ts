import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InkController } from "../../src/cli/ink/controller";
import { TerminalModes } from "../../src/cli/ink/terminal-modes";
import { InputDecoder } from "../../src/cli/terminal/decoder";
import type { InkViewState } from "../../src/cli/ink/types";

class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(value: boolean) { this.isRaw = value; return this; } }
const up = "\x1b[<64;10;5M", down = "\x1b[<65;10;5M";
const cleanups: (() => void)[] = [];
beforeEach(() => { vi.stubEnv("TERM", "xterm-256color"); vi.stubEnv("FORGE_MOUSE", undefined); vi.stubEnv("INK_SCREEN_READER", undefined); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllEnvs(); });
async function fixture() {
  const input = new Input(); const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
  let bytes = ""; output.on("data", chunk => { bytes += chunk.toString(); });
  const submit = vi.fn(), interrupt = vi.fn();
  const controller = new InkController({ input, output, tty: true, start: () => {}, submit, interrupt,
    approval: async () => false, runInputActive: () => true });
  const decoder = new InputDecoder(event => controller.handle(event));
  cleanups.push(() => { decoder.dispose(); controller.dispose(); });
  await controller.configure({ theme: "dark" });
  controller.append(Array.from({ length: 100 }, (_, i) => [{ text: `row-${i}` }]));
  const snapshot = () => (controller as unknown as { snapshot(): InkViewState }).snapshot();
  return { controller, decoder, snapshot, submit, interrupt, input, bytes: () => bytes };
}

it("scrolls a frozen history three rows per wheel and resumes latest output at the bottom", async () => {
  const f = await fixture(); f.decoder.feed("draft");
  f.decoder.feed(up.slice(0, 6)); expect(f.snapshot().reading).toBeNull(); f.decoder.feed(up.slice(6));
  expect(f.snapshot().reading?.end).toBe(97);
  f.decoder.feed(up); expect(f.snapshot().reading?.end).toBe(94);
  f.controller.update({ append: [[{ text: "new-output" }]], tail: [[{ text: "new-tail" }]], status: null });
  expect(f.snapshot().reading?.lines).toHaveLength(100);
  f.decoder.feed("ignored\r"); expect(f.submit).not.toHaveBeenCalled(); expect(f.controller.inputText).toBe("draft");
  f.decoder.feed(down.repeat(2)); expect(f.snapshot().reading).toBeNull();
  expect(f.snapshot().visibleHistory?.flat().some(s => s.text === "new-output")).toBe(true);
  expect(f.snapshot().tail[0]?.[0]?.text).toBe("new-tail");
  f.decoder.feed("\r"); expect(f.submit).toHaveBeenCalledWith("draft", false);
});

it("bounds top scrolling, supports keyboard exit and ignores paste, Shift, clicks and live downward scrolling", async () => {
  const f = await fixture();
  f.decoder.feed(down + "\x1b[<68;10;5M" + "\x1b[<0;10;5M" + "\x1b[<0;10;5m" + `\x1b[200~${up}\x1b[201~`);
  expect(f.snapshot().reading).toBeNull(); expect(f.controller.inputText).toBe("");
  f.decoder.feed(up.repeat(60)); expect(f.snapshot().reading?.end).toBe(22);
  f.decoder.feed("\x1b[F"); expect(f.snapshot().reading).toBeNull();
  f.decoder.feed(up + "\x03"); expect(f.snapshot().reading).toBeNull(); expect(f.interrupt).not.toHaveBeenCalled();
});

it("never routes wheel/click reports into approval or picker actions", async () => {
  const f = await fixture(); f.decoder.feed("saved" + up);
  f.controller.begin("Approve? ", true); expect(f.snapshot().reading).toBeNull();
  f.decoder.feed(up + down + "\x1b[<0;1;1M");
  expect(f.snapshot().reading).toBeNull(); expect(f.submit).not.toHaveBeenCalled();
  f.controller.end();
  const choice = f.controller.choose({ title: "Pick", items: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }, new AbortController().signal);
  f.decoder.feed(up + down + "\x1b[<0;1;1M"); expect(f.snapshot().reading).toBeNull();
  f.decoder.feed("\r"); expect(await choice).toBe("a"); expect(f.controller.inputText).toBe("saved");
});

it.each(["opt-out", "screen-reader"])("does not enable or consume wheel reports in %s mode", async mode => {
  vi.stubEnv(mode === "opt-out" ? "FORGE_MOUSE" : "INK_SCREEN_READER", mode === "opt-out" ? "0" : "true");
  const f = await fixture(); f.decoder.feed(up);
  expect(f.snapshot().reading).toBeNull(); expect(f.bytes()).not.toContain("\x1b[?1000h");
});

it("enables reports only in fullscreen and restores them once even if individual resets fail", () => {
  const input = new Input(); const writes: string[] = [];
  let fail = "";
  const modes = new TerminalModes(input, { isTTY: true, write: (text: string) => {
    writes.push(text); if (text === fail) throw new Error("write failed"); return true;
  } } as NodeJS.WriteStream, () => {});
  modes.configure("dark"); expect(modes.mouseEnabled).toBe(false);
  modes.enterFullscreen(); modes.enterFullscreen(); expect(modes.mouseEnabled).toBe(true);
  expect(writes.filter(s => s.includes("1000h"))).toHaveLength(1);
  fail = "\x1b[?1000l"; expect(() => modes.dispose()).toThrow("write failed");
  expect(writes).toContain("\x1b[?1006l"); expect(writes).toContain("\x1b[?1049l");
  expect(input.isRaw).toBe(false); expect(modes.mouseEnabled).toBe(false);
  const count = writes.length; modes.dispose(); expect(writes).toHaveLength(count);
});

it("cleans reports after a partially successful enable and skips dumb/nonTTY fullscreen", () => {
  const input = new Input(); const writes: string[] = [];
  const modes = new TerminalModes(input, { isTTY: true, write: (text: string) => {
    writes.push(text); if (text.includes("1000h")) throw new Error("enable failed"); return true;
  } } as NodeJS.WriteStream, () => {});
  modes.configure("dark"); expect(() => modes.enterFullscreen()).toThrow("enable failed");
  expect(writes).toContain("\x1b[?1000l"); expect(writes).toContain("\x1b[?1006l");
  expect(writes).toContain("\x1b[?1049l"); expect(input.isRaw).toBe(false);
  for (const tty of [false, true]) {
    vi.stubEnv("TERM", tty ? "dumb" : "xterm-256color");
    const write = vi.fn(); const plain = new TerminalModes(input, { isTTY: tty, write } as unknown as NodeJS.WriteStream, () => {});
    plain.enterFullscreen(); plain.dispose(); expect(write).not.toHaveBeenCalled();
  }
});
