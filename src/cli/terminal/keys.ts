import type { Controller } from "./controller";
import type { InputEvent } from "./decoder";
export function handle(controller: Controller, event: InputEvent): void {
  if (event.kind === "background") {
    if (controller.probe) {
      clearTimeout(controller.probe);
      controller.probe = undefined;
      controller.background = event.background;
      controller.theme();
      controller.draw();
    }
    return;
  }
  const editor = controller.picker?.editor ?? controller.editor;
  if (event.kind === "text") {
    editor.insert(event.text, event.pasted);
    controller.dismissed = false;
    controller.navigated = false;
    if (controller.picker) controller.picker.index = 0;
  } else if (event.key === "tab" && !controller.screen.enabled) {
    editor.insert("\t", event.pasted);
  } else if (event.pasted) {
    editor.tainted = true;
    if (event.key === "enter" && !controller.fresh && !controller.picker) {
      if (controller.screen.enabled) editor.insert("\n", true);
      else controller.finish();
    }
  } else if (event.key === "interrupt") {
    if (controller.picker) controller.picker.resolve(null);
    else if (controller.fresh) {
      controller.submit("");
      controller.interrupt();
    } else if (controller.busy || !editor.text) controller.interrupt();
    else editor.clear();
  } else if (event.key === "escape") {
    if (controller.picker) controller.picker.resolve(null);
    else if (controller.fresh) {
      editor.clear();
      controller.submit("");
    } else {
      controller.dismissed = true;
      controller.menu.close();
    }
  } else if (event.key === "enter" || event.key === "tab") {
    if (controller.picker) {
      if (event.key === "enter")
        controller.picker.resolve(
          controller.filtered()[controller.picker.index]?.value ?? null,
        );
    } else if (controller.fresh && event.key === "enter") {
      const answer = editor.tainted ? "" : editor.text;
      editor.clear();
      controller.submit(answer);
    } else if (!controller.busy) {
      if (controller.menu.isActive)
        editor.set(
          (controller.navigated
            ? undefined
            : controller.menu.state.items.find(
                (item) => item.name === editor.text,
              )
          )?.name ??
            controller.menu.getSelected()?.name ??
            editor.text,
        );
      if (event.key === "enter") {
        if (editor.text.endsWith("\\")) {
          editor.text = editor.text.slice(0, -1);
          editor.cursor = editor.text.length;
          editor.insert("\n");
        } else controller.finish();
      } else {
        editor.insert(" ");
        controller.menu.close();
        controller.dismissed = true;
      }
    }
  } else if (
    controller.picker &&
    (event.key === "up" || event.key === "down")
  ) {
    const n = controller.filtered().length;
    controller.picker.index = n
      ? (controller.picker.index + (event.key === "up" ? n - 1 : 1)) % n
      : 0;
  } else if (
    controller.menu.isActive &&
    (event.key === "up" || event.key === "down")
  ) {
    controller.navigated = true;
    if (event.key === "up") controller.menu.moveUp();
    else controller.menu.moveDown();
  } else if (!controller.fresh || !["up", "down"].includes(event.key))
    editor.key(event.key);
  if (
    controller.screen.enabled &&
    !controller.fresh &&
    !controller.picker &&
    !controller.dismissed
  )
    controller.menu.update(editor.text);
  controller.draw();
}
