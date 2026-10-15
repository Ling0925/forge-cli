import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import type { PickerSpec } from "../../src/cli/ui-contract";

const spec: PickerSpec = {
  title: "Tasks",
  items: [
    { value: "a", label: "agent alpha" },
    { value: "b", label: "agent beta" },
  ],
};
function fixture() {
  const interrupt = vi.fn();
  const controller = new Controller(new PassThrough(), new PassThrough(), false,
    () => {}, () => {}, interrupt, async () => false);
  return { controller, interrupt };
}

describe("refreshable task picker", () => {
  it("preserves query and selected value on updates and ignores other titles", async () => {
    const { controller } = fixture();
    const result = controller.choose(spec, new AbortController().signal);
    controller.handle({ kind: "text", text: "agent", pasted: false });
    controller.handle({ kind: "key", key: "down", pasted: false });
    const editor = controller.picker?.editor;
    controller.updatePicker({ ...spec, items: [spec.items[1]!, spec.items[0]!] });
    expect(controller.picker?.editor).toBe(editor);
    expect(editor?.text).toBe("agent");
    expect(controller.filtered()[controller.picker!.index]?.value).toBe("b");
    controller.updatePicker({ title: "Other picker", items: [] });
    expect(controller.picker?.spec.title).toBe("Tasks");
    controller.handle({ kind: "key", key: "enter", pasted: false });
    expect(await result).toBe("b");
    controller.dispose();
  });

  it("dismisses an open picker before fresh approval and refuses new pickers", async () => {
    const { controller } = fixture();
    const result = controller.choose(spec, new AbortController().signal);
    controller.begin("Approve?", true);
    expect(await result).toBeNull();
    expect(controller.picker).toBeUndefined();
    expect(await controller.choose(spec, new AbortController().signal)).toBeNull();
    controller.dispose();
  });

  it.each(["text", "key", "early-key"] as const)("pasted %s cannot confirm a stop, even followed by real Enter", async kind => {
    const { controller } = fixture();
    const result = controller.choose({
      title: "Stop?", confirmation: true,
      items: [{ value: "cancel", label: "Cancel" }, { value: "stop", label: "Stop" }],
    }, new AbortController().signal);
    if (kind === "text") controller.handle({ kind: "text", text: "Stop", pasted: true });
    else {
      controller.handle({ kind: "key", key: "down", pasted: false });
      controller.handle({ kind: "key", key: kind === "early-key" ? "shift-tab" : "enter", pasted: true });
    }
    controller.handle({ kind: "key", key: "enter", pasted: false });
    expect(await result).toBeNull();
    controller.dispose();
  });

  it("allows explicit fresh selection; Esc closes without interrupting parent", async () => {
    const { controller, interrupt } = fixture();
    const result = controller.choose({ ...spec, confirmation: true }, new AbortController().signal);
    controller.handle({ kind: "key", key: "down", pasted: false });
    controller.handle({ kind: "key", key: "enter", pasted: false });
    expect(await result).toBe("b");
    const closed = controller.choose(spec, new AbortController().signal);
    controller.handle({ kind: "key", key: "escape", pasted: false });
    expect(await closed).toBeNull();
    expect(interrupt).not.toHaveBeenCalled();
    controller.dispose();
  });
});
