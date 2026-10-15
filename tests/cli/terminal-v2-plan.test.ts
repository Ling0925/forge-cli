import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import { Editor } from "../../src/cli/terminal/editor";
import { InputDecoder } from "../../src/cli/terminal/decoder";
import { visibleWidth } from "../../src/cli/theme";

it.each([12, 24, 40, 80, 120])("keeps live activity ahead of plan and notices at %s columns", columns => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const output = Object.assign(new PassThrough(), { columns, rows: 24 });
  const c = new Controller(new PassThrough(), output, false, () => {}, () => {}, () => {}, async () => false);
  c.screen.enabled = true; c.screen.fixed = true; c.prompt = "❯ ";
  const paint = vi.spyOn(c.screen, "paint");
  const rowText = () => paint.mock.calls.at(-1)?.[0][0]?.map(s => s.text).join("") ?? "";
  try {
    c.setPlan({ explanation: "", steps: [{ step: "很长的计划步骤".repeat(30), status: "in_progress" }] });
    const initial = paint.mock.calls.at(-1);
    c.setStatus({ label: "thinking", startedAt: 0, toolCount: 1, cancellable: true });
    const first = rowText();
    expect(first).toContain("10s");
    if (columns >= 24) expect(first).toContain("thinking");
    if (columns >= 40) expect(first).toContain("Plan 0/1");
    expect(visibleWidth(first)).toBeLessThanOrEqual(columns);
    vi.setSystemTime(11100); c.draw(); expect(rowText()).not.toBe(first);
    expect(rowText()).toContain("11s");
    c.notify("Clipboard request sent");
    if (columns >= 24) expect(rowText()).toContain("thinking");
    expect(paint.mock.calls.at(-1)?.[1]).toBe(initial?.[1]);
    expect(paint.mock.calls.at(-1)?.[0].length).toBe(initial?.[0].length);
    c.setStatus({ label: "run_command", startedAt: 0, toolCount: 2, cancellable: true });
    if (columns >= 40) expect(rowText()).toContain("run_command");
    c.setStatus(null); c.notice = null; c.draw(); expect(rowText()).toContain("Plan 0/1");
    expect(rowText()).not.toContain("thinking");
  } finally { c.dispose(); vi.useRealTimers(); }
});

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
