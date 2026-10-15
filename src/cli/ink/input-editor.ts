import { graphemes } from "../render/width";

/** Immutable editing state; no terminal, React, or input-stream ownership. */
export interface InputEditor {
  readonly text: string;
  readonly cursor: number;
  readonly tainted: boolean;
  readonly history: readonly string[];
  readonly index: number;
  readonly draft: string;
}
export const emptyEditor = (): InputEditor => ({ text: "", cursor: 0, tainted: false, history: [], index: 0, draft: "" });
export const setText = (state: InputEditor, text: string): InputEditor => ({ ...state, text, cursor: text.length });
export const clearEditor = (state: InputEditor): InputEditor => ({ ...state, text: "", cursor: 0, tainted: false });
export function insertText(state: InputEditor, text: string, pasted: boolean): InputEditor {
  return { ...state, text: state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    cursor: state.cursor + text.length, tainted: state.tainted || pasted };
}
export function loadHistory(state: InputEditor, entries: readonly string[]): InputEditor {
  const history = entries.slice(-1000);
  let bytes = history.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  while (bytes > 1_000_000 && history.length) bytes -= Buffer.byteLength(history.shift()!);
  return { ...state, history, index: history.length, draft: "" };
}
export function remember(state: InputEditor): InputEditor {
  const history = state.text && state.history.at(-1) !== state.text ? [...state.history, state.text] : state.history;
  return loadHistory(state, history);
}
export function editKey(state: InputEditor, key: string): InputEditor {
  const { text, cursor } = state;
  const before = text.slice(0, cursor);
  const left = graphemes(before).at(-1)?.length ?? 0;
  const right = graphemes(text.slice(cursor))[0]?.length ?? 0;
  switch (key) {
    case "left": return { ...state, cursor: cursor - left };
    case "right": return { ...state, cursor: cursor + right };
    case "home": return { ...state, cursor: before.lastIndexOf("\n") + 1 };
    case "end": {
      const end = text.indexOf("\n", cursor);
      return { ...state, cursor: end < 0 ? text.length : end };
    }
    case "backspace": return { ...state, text: text.slice(0, cursor - left) + text.slice(cursor), cursor: cursor - left };
    case "delete": return { ...state, text: before + text.slice(cursor + right) };
    case "kill": {
      const start = before.lastIndexOf("\n") + 1;
      return { ...state, text: text.slice(0, start) + text.slice(cursor), cursor: start };
    }
    case "kill-end": {
      const end = text.indexOf("\n", cursor);
      return { ...state, text: before + (end < 0 ? "" : text.slice(end)) };
    }
    case "word-left": return { ...state, cursor: before.replace(/\S+\s*$/, "").length };
    case "word-right": return { ...state, cursor: cursor + (/^\s*\S+/.exec(text.slice(cursor))?.[0].length ?? text.length - cursor) };
    case "word": {
      const keep = before.replace(/\S+\s*$/, "");
      return { ...state, text: keep + text.slice(cursor), cursor: keep.length };
    }
    case "up":
    case "down": {
      const draft = state.index === state.history.length ? text : state.draft;
      const index = Math.max(0, Math.min(state.history.length, state.index + (key === "up" ? -1 : 1)));
      return setText({ ...state, index, draft }, state.history[index] ?? draft);
    }
    default: return state;
  }
}
