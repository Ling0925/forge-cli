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
  if (event.kind === "mouse") {
    controller.screen.mouse(event);
    return;
  }
  if (event.kind === "key" && event.key === "shift-tab") {
    if (!event.pasted && !controller.fresh && !controller.picker && !controller.screen.hasSelection) controller.modeToggle?.();
    return;
  }
  if (event.kind === "key" && !event.pasted && event.key === "redraw") {
    controller.screen.invalidate(); controller.draw(); return;
  }
  if (event.kind === "key" && !event.pasted && event.key === "alt-enter") {
    if (!controller.fresh && !controller.picker) { controller.editor.insert("\n"); controller.draw(); }
    return;
  }
  if (controller.screen.hasSelection) {
    if (event.kind === "key" && !event.pasted && event.key === "interrupt") {
      controller.screen.copySelection();
      return;
    }
    controller.screen.clearSelection();
    if (event.kind === "key" && !event.pasted && event.key === "escape") {
      controller.draw();
      return;
    }
  }
  if (event.kind === "key" && !event.pasted && (event.key === "page-up" || event.key === "page-down")) {
    controller.screen.scroll((event.key === "page-up" ? 1 : -1) * Math.max(1, controller.rows - 5));
    return;
  }
  if (event.kind === "key" && !event.pasted && !controller.fresh && !controller.picker && controller.screen.historyOffset > 0 && (event.key === "end" || (event.key === "escape" && !controller.editor.text))) {
    controller.screen.scroll(-Number.MAX_SAFE_INTEGER); return;
  }
  const editor = controller.picker?.editor ?? controller.editor;
  const previousText = editor.text;
  if (event.kind === "text") {
    editor.insert(event.text, event.pasted);
    controller.dismissed = false;
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
  } else if (event.key === "tab") {
    // Completion edits the draft only, including while a run is busy.
    // With no active suggestion, Tab must not silently insert a space.
    const selected = !controller.fresh && !controller.picker ? controller.menu.getSelected() : undefined;
    if (selected) {
      editor.set(`${selected.name} `);
      controller.menu.close();
    }
  } else if (event.key === "enter" || event.key === "shift-enter") {
    if (controller.picker) {
      if (event.key === "enter")
        controller.picker.resolve(
          controller.filtered()[controller.picker.index]?.value ?? null,
        );
    } else if (controller.fresh && event.key === "enter") {
      const answer = editor.tainted ? "" : editor.text;
      editor.clear();
      controller.submit(answer);
    } else if (
      !controller.busy ||
      ((event.key === "enter" || event.key === "shift-enter") &&
        (controller.runInputActive() || editor.text.startsWith("/")))
    ) {
      if (controller.menu.isActive)
        editor.set(controller.menu.getSelected()?.name ?? editor.text);
      if (event.key === "enter" || event.key === "shift-enter") {
        if (editor.text.endsWith("\\")) {
          editor.text = editor.text.slice(0, -1);
          editor.cursor = editor.text.length;
          editor.insert("\n");
        } else controller.finish(event.key === "shift-enter");
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
    if (event.key === "up") controller.menu.moveUp();
    else controller.menu.moveDown();
  } else if (!controller.fresh || !["up", "down"].includes(event.key))
    editor.key(event.key);
  if (editor.text !== previousText) controller.dismissed = false;
  if (
    controller.screen.enabled &&
    !controller.fresh &&
    !controller.picker &&
    !controller.dismissed &&
    editor.cursor === editor.text.length
  )
    controller.menu.update(editor.text);
  else controller.menu.close();
  controller.draw();
}
