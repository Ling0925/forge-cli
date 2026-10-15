import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { PlainController } from "../../src/cli/plain-controller";
import { TerminalReader } from "../../src/cli/terminal";

it("prints prompts without configure and commits input before synchronous callbacks", async () => {
  const output = new PassThrough(); let bytes = ""; output.on("data", c => { bytes += c; });
  const submit = vi.fn((text: string) => { if (text === "go") c.begin("Approve? ", true); else c.end(); });
  const c = new PlainController({ input: new PassThrough(), output, tty: false, start: () => {}, submit, interrupt: () => {}, approval: async () => false, runInputActive: () => false });
  c.begin("> ", false);
  c.handle({ kind: "text", text: "go", pasted: false });
  c.handle({ kind: "key", key: "enter", pasted: false });
  expect(c.fresh).toBe(true); expect(c.inputText).toBe("");
  c.handle({ kind: "text", text: "y", pasted: true });
  c.handle({ kind: "key", key: "enter", pasted: false });
  expect(submit.mock.calls).toEqual([["go", false], ["no", false]]);
  expect(c.fresh).toBe(false);
  expect(bytes).toBe("> Approve? ");
  c.dispose();
});

it("uses a plain append-only path for nonTTY FIFO, tabs and paste lines", async () => {
  const input = new PassThrough(); const output = new PassThrough();
  let bytes = ""; output.on("data", c => { bytes += c; });
  const r = new TerminalReader({ input, output, isTTY: false });
  const signal = new AbortController().signal;
  try {
    const a = r.question("> ", signal);
    input.write("one\ttwo\nthree\n");
    expect(await a).toBe("one\ttwo");
    expect(await r.question("> ", signal)).toBe("three");
    r.ui.append([[{ text: "safe\x1b[2J" }]]);
    expect(bytes).not.toContain("\x1b");
    expect(bytes).toContain("safe");
  } finally { r.dispose(); }
  expect(input.listenerCount("data")).toBe(0);
});
