import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import { Editor } from "../../src/cli/terminal/editor";
import { InputDecoder } from "../../src/cli/terminal/decoder";

it("pins bounded authoritative plan without moving composer or growing dock", () => {
  const c = new Controller(new PassThrough(), new PassThrough(), false, () => {}, () => {}, () => {}, async () => false);
  c.screen.enabled = true; c.screen.fixed = true; c.prompt = "❯ ";
  const paint = vi.spyOn(c.screen, "paint");
  c.draw(); const before = paint.mock.calls.at(-1);
  c.setPlan({explanation: "ignored", steps: Array.from({length: 100}, (_, i) => ({step: `step ${i} \x1b[31m`, status: i === 0 ? "in_progress" : "pending"}))});
  const after = paint.mock.calls.at(-1);
  expect(after?.[1]).toBe(before?.[1]); expect(after?.[0].length).toBe(before?.[0].length);
  expect(after?.[0][0]?.[0]?.text).toContain("Plan 0/100");
  expect(after?.[0][0]?.[0]?.text).not.toContain("\x1b");
  c.screen.setTranscript(Array.from({length:100}, (_, i) => [{text:`history ${i}`} ]));
  c.screen.scroll(20); c.draw(); expect(paint.mock.calls.at(-1)?.[0][0]?.[0]?.text).toContain("Plan 0/100");
  c.setPlan(null); expect(paint.mock.calls.at(-1)?.[1]).toBe(before?.[1]);
  c.dispose();
});

it("supports literal Alt+Enter and line-local editing without submitting", () => {
  const submit = vi.fn();
  const c = new Controller(new PassThrough(), new PassThrough(), false, () => {}, submit, () => {}, async () => false);
  const decoder = new InputDecoder(event => c.handle(event));
  decoder.feed("hello\x1b\rworld"); expect(c.editor.text).toBe("hello\nworld"); expect(submit).not.toHaveBeenCalled();
  decoder.feed("\x15"); expect(c.editor.text).toBe("hello\n");
  c.fresh = true; decoder.feed("\x1b\r"); expect(c.editor.text).toBe("hello\n");
  const e = new Editor(); e.set("one\ntwo three\nfour"); e.cursor = 7; e.key("kill-end"); expect(e.text).toBe("one\ntwo\nfour");
  e.key("word-left"); expect(e.cursor).toBe(4); e.key("word-right"); expect(e.cursor).toBe(7);
  decoder.dispose(); c.dispose();
});
