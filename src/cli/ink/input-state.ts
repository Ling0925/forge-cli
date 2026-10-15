import { matchSlashCommands } from "../commands";
import type { SlashMenuState } from "../slash-menu";
import type { InputEvent } from "../terminal/decoder";
import type { PickerSpec } from "../ui-contract";
import { clearEditor, editKey, emptyEditor, insertText, remember, setText, type InputEditor } from "./input-editor";

export type InputFocus =
  | { readonly kind: "composer" }
  | { readonly kind: "approval"; readonly editor: InputEditor }
  | { readonly kind: "picker"; readonly id: number; readonly spec: PickerSpec; readonly editor: InputEditor; readonly index: number };
export interface InputState {
  readonly composer: InputEditor;
  readonly focus: InputFocus;
  readonly prompt: string;
  readonly menu: SlashMenuState;
  readonly dismissed: boolean;
}
export type InputEffect =
  | { readonly type: "submit"; readonly text: string; readonly steer: boolean; readonly echo: string }
  | { readonly type: "approval"; readonly answer: string }
  | { readonly type: "pick"; readonly id: number; readonly value: string | null }
  | { readonly type: "interrupt" | "toggle-mode" };
export interface InputTransition { readonly state: InputState; readonly effects: readonly InputEffect[] }
export const closedMenu = (): SlashMenuState => ({ active: false, items: [], query: "", selectedIndex: 0 });
export const initialInput = (): InputState => ({ composer: emptyEditor(), focus: { kind: "composer" }, prompt: "❯ ", menu: closedMenu(), dismissed: false });
export const focusedEditor = (state: InputState): InputEditor => state.focus.kind === "composer" ? state.composer : state.focus.editor;
export const pickerItems = (focus: Extract<InputFocus, { kind: "picker" }>) => {
  const query = focus.editor.text.toLocaleLowerCase();
  return focus.spec.items.filter(item => `${item.label} ${item.detail ?? ""} ${item.value}`.toLocaleLowerCase().includes(query));
};
function updateMenu(state: InputState): InputState {
  const { text, cursor } = state.composer;
  if (state.focus.kind !== "composer" || state.dismissed || cursor !== text.length || !text.startsWith("/") || /\s/.test(text))
    return { ...state, menu: closedMenu() };
  if (state.menu.query === text) return state;
  const items = matchSlashCommands(text);
  return { ...state, menu: { active: items.length > 0, items, query: text,
    selectedIndex: Math.max(0, items.findIndex(item => item.name === text.toLowerCase())) } };
}
function approvalInput(state: InputState, event: Extract<InputEvent, { kind: "text" | "key" }>): InputTransition {
  if (state.focus.kind !== "approval") return { state, effects: [] };
  let editor = state.focus.editor;
  if (event.pasted || (event.kind === "key" && ["up", "down"].includes(event.key))) editor = { ...editor, tainted: true };
  const effects: InputEffect[] = [];
  if (event.kind === "text") editor = insertText(editor, event.text, event.pasted);
  else if (!event.pasted) {
    if (["enter", "shift-enter", "alt-enter", "escape", "interrupt"].includes(event.key)) {
      effects.push({ type: "approval", answer: event.key === "enter" && !editor.tainted ? editor.text : "no" });
      editor = clearEditor(editor);
      if (event.key === "interrupt") effects.push({ type: "interrupt" });
    } else if (!["up", "down"].includes(event.key)) editor = editKey(editor, event.key);
  }
  return { state: { ...state, focus: { kind: "approval", editor } }, effects };
}
function pickerInput(state: InputState, event: Extract<InputEvent, { kind: "text" | "key" }>): InputTransition {
  if (state.focus.kind !== "picker") return { state, effects: [] };
  let focus = state.focus;
  if (event.pasted) focus = { ...focus, editor: { ...focus.editor, tainted: true } };
  const effects: InputEffect[] = [];
  if (event.kind === "text") focus = { ...focus, editor: insertText(focus.editor, event.text, event.pasted), index: 0 };
  else if (!event.pasted) {
    if (["enter", "escape", "interrupt"].includes(event.key)) {
      const value = event.key === "enter" && !(focus.spec.confirmation && focus.editor.tainted)
        ? pickerItems(focus)[focus.index]?.value ?? null : null;
      effects.push({ type: "pick", id: focus.id, value });
    } else if (["up", "down"].includes(event.key)) {
      const count = pickerItems(focus).length;
      focus = { ...focus, index: count ? (focus.index + (event.key === "up" ? count - 1 : 1)) % count : 0 };
    } else {
      const editor = editKey(focus.editor, event.key);
      focus = { ...focus, editor, index: editor.text !== focus.editor.text ? 0 : focus.index };
    }
  }
  return { state: { ...state, focus }, effects };
}
function composerInput(state: InputState, event: Extract<InputEvent, { kind: "text" | "key" }>, busy: boolean, running: boolean): InputTransition {
  let editor = state.composer;
  let dismissed = state.dismissed;
  let menu = state.menu;
  const effects: InputEffect[] = [];
  if (event.kind === "text") { editor = insertText(editor, event.text, event.pasted); dismissed = false; }
  else if (event.pasted) {
    editor = { ...editor, tainted: true };
    if (event.key === "enter") editor = insertText(editor, "\n", true);
  } else if (event.key === "shift-tab") effects.push({ type: "toggle-mode" });
  else if (event.key === "interrupt") {
    if (busy || !editor.text) effects.push({ type: "interrupt" });
    else editor = clearEditor(editor);
  } else if (event.key === "escape") { dismissed = true; menu = closedMenu(); }
  else if (event.key === "tab") {
    const selected = menu.active ? menu.items[menu.selectedIndex] : undefined;
    if (selected) { editor = setText(editor, `${selected.name} `); menu = closedMenu(); }
  } else if (["enter", "shift-enter", "alt-enter"].includes(event.key)) {
    if (!busy || running || editor.text.startsWith("/")) {
      if (menu.active) editor = setText(editor, menu.items[menu.selectedIndex]?.name ?? editor.text);
      if (editor.text.endsWith("\\")) editor = insertText(setText(editor, editor.text.slice(0, -1)), "\n", false);
      else {
        effects.push({ type: "submit", text: editor.text, steer: event.key !== "enter" && running && !editor.text.startsWith("/"), echo: state.prompt + editor.text });
        editor = clearEditor(remember(editor));
        dismissed = true;
        menu = closedMenu();
      }
    }
  } else if (menu.active && ["up", "down"].includes(event.key)) {
    menu = { ...menu, selectedIndex: (menu.selectedIndex + (event.key === "up" ? menu.items.length - 1 : 1)) % menu.items.length };
  } else editor = editKey(editor, event.key);
  if (editor.text !== state.composer.text && !effects.some(effect => effect.type === "submit")) dismissed = false;
  return { state: updateMenu({ ...state, composer: editor, dismissed, menu }), effects };
}

/** Exactly one focus consumes each event; effects run only after state is committed. */
export function reduceInput(state: InputState, event: InputEvent, busy: boolean, running: boolean): InputTransition {
  if (event.kind !== "text" && event.kind !== "key") return { state, effects: [] };
  switch (state.focus.kind) {
    case "approval": return approvalInput(state, event);
    case "picker": return pickerInput(state, event);
    case "composer": return composerInput(state, event, busy, running);
  }
}
