import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import { SlashMenu } from "../../src/cli/slash-menu";
import type { InputEvent } from "../../src/cli/terminal/decoder";

const controllers: Controller[] = [];
beforeEach(() => vi.stubEnv("TERM", "xterm-256color"));
afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose(); vi.unstubAllEnvs(); });
async function fixture() {
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  output.resume();
  const submit = vi.fn();
  const controller = new Controller(new PassThrough(), output, true, () => {}, submit, () => {}, async () => false);
  controllers.push(controller);
  await controller.configure({ theme: "dark" });
  controller.begin("❯ ", false);
  const text = (text: string) => controller.handle({ kind: "text", text, pasted: false });
  const key = (key: string) => controller.handle({ kind: "key", key, pasted: false } as InputEvent);
  return { controller, submit, text, key };
}

it("highlights the exact command and Enter always submits the highlighted item", async () => {
  const { controller, submit, text, key } = await fixture();
  text("/mode");
  expect(controller.menu.getSelected()?.name).toBe("/mode");
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/mode", false);
  text("/mode");
  key("up");
  expect(controller.menu.getSelected()?.name).toBe("/model");
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/model", false);
});

it("resets stale selection on a changed query but preserves navigation on redraw", () => {
  const menu = new SlashMenu();
  menu.update("/mod");
  menu.moveDown();
  menu.update("/mod");
  expect(menu.getSelected()?.name).toBe("/mode");
  menu.update("/m");
  expect(menu.getSelected()?.name).toBe("/model");
  menu.update("/MODE");
  expect(menu.getSelected()?.name).toBe("/mode");
});

it.each([" /help", "\n/help", "/help\n", "/help\t", "/help\n/exit", "/model test"])(
  "does not hijack whitespace or multiline draft %j", (draft) => {
    const menu = new SlashMenu();
    expect(menu.update(draft)).toBe(false);
  },
);

it("does not replace drafts when editing in the middle of a command", async () => {
  const { controller, submit, text, key } = await fixture();
  text("/mode");
  key("left");
  expect(controller.menu.isActive).toBe(false);
  key("tab");
  expect(controller.editor.text).toBe("/mode");
  expect(controller.editor.cursor).toBe(4);
  key("end");
  expect(controller.menu.getSelected()?.name).toBe("/mode");
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/mode", false);
});

it("reopens after an edit following Escape, not after cursor movement", async () => {
  const { controller, text, key } = await fixture();
  text("/help");
  key("escape");
  key("left");
  key("end");
  expect(controller.menu.isActive).toBe(false);
  key("backspace");
  expect(controller.editor.text).toBe("/hel");
  expect(controller.menu.getSelected()?.name).toBe("/help");
});

it("preserves a pasted multiline draft on Enter rather than replacing it with a command", async () => {
  const { controller, submit, key } = await fixture();
  const draft = "/help\n/exit";
  controller.handle({ kind: "text", text: draft, pasted: true });
  expect(controller.menu.isActive).toBe(false);
  key("enter");
  expect(submit).toHaveBeenLastCalledWith(draft, false);
});

it("Escape submits the literal draft and deleting the Tab separator restores suggestions", async () => {
  const { controller, submit, text, key } = await fixture();
  text("/hel");
  key("escape");
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/hel", false);
  text("/mod");
  key("tab");
  expect(controller.editor.text).toBe("/model ");
  key("backspace");
  expect(controller.menu.getSelected()?.name).toBe("/model");
  text(" test");
  expect(controller.menu.isActive).toBe(false);
  key("tab");
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/model test", false);
});

it("supports Tab completion while busy without submitting or modifying ordinary text", async () => {
  const { controller, submit, text, key } = await fixture();
  controller.setBusy(true);
  text("/hel");
  key("tab");
  expect(controller.editor.text).toBe("/help ");
  expect(submit).not.toHaveBeenCalled();
  key("enter");
  expect(submit).toHaveBeenLastCalledWith("/help ", false);
  controller.setBusy(false);
  text("ordinary draft");
  key("tab");
  expect(controller.editor.text).toBe("ordinary draft");
});
