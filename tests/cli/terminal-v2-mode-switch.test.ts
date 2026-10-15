import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { Controller } from "./legacy/controller";
import { InputDecoder } from "../../src/cli/terminal/decoder";

it("decodes split Shift+Tab and toggles only the ordinary composer, preserving draft", () => {
  const output = new PassThrough();
  const c = new Controller(
    new PassThrough(),
    output,
    false,
    () => {},
    () => {},
    () => {},
    async () => false,
  );
  let toggles = 0;
  const off = c.onModeToggle(() => {
    toggles++;
    c.setMode(c.mode === "build" ? "plan" : "build");
  });
  const decoder = new InputDecoder((event) => c.handle(event));
  c.editor.set("keep draft");
  decoder.feed("\x1b[");
  decoder.feed("Z");
  expect(c.mode).toBe("plan");
  expect(c.editor.text).toBe("keep draft");
  c.busy = true;
  decoder.feed("\x1b[Z");
  expect(c.mode).toBe("build");
  c.fresh = true;
  decoder.feed("\x1b[Z");
  expect(toggles).toBe(2);
  c.fresh = false;
  decoder.feed("\x1b[200~\x1b[Z\x1b[201~");
  expect(toggles).toBe(2);
  const choice = c.choose(
    { title: "Pick", items: [] },
    new AbortController().signal,
  );
  decoder.feed("\x1b[Z");
  expect(toggles).toBe(2);
  c.picker?.resolve(null);
  off();
  decoder.feed("\x1b[Z");
  expect(toggles).toBe(2);
  decoder.dispose();
  c.dispose();
  return choice;
});
