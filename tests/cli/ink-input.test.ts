import { describe, expect, it, vi } from "vitest";
import { clearEditor, editKey, emptyEditor, insertText, loadHistory, remember, setText } from "../../src/cli/ink/input-editor";
import { focusedEditor, initialInput, pickerItems, reduceInput, type InputEffect } from "../../src/cli/ink/input-state";
import { InputStore } from "../../src/cli/ink/input-store";
import type { InputEvent } from "../../src/cli/terminal/decoder";

const key = (value: string, pasted = false): InputEvent => ({ kind: "key", key: value, pasted });
const text = (value: string, pasted = false): InputEvent => ({ kind: "text", text: value, pasted });
const spec = { title: "Tasks", items: [{ value: "a", label: "agent alpha" }, { value: "b", label: "agent beta" }] };
const signal = () => new AbortController().signal;
function fixture() {
  const effects: InputEffect[] = [];
  const store = new InputStore(effect => {
    effects.push(effect);
    if (effect.type === "approval") store.end();
  });
  return { store, effects, send: (event: InputEvent, busy = false, running = false) => store.dispatch(event, busy, running) };
}

describe("immutable Ink input editor", () => {
  it("edits full graphemes without mutating earlier snapshots", () => {
    const original = Object.freeze(setText(emptyEditor(), "中👩‍💻é"));
    const moved = editKey(original, "left");
    expect(moved.cursor).toBe("中👩‍💻".length);
    const removed = editKey(moved, "backspace");
    expect(removed.text).toBe("中é");
    expect(insertText(removed, "文", false).text).toBe("中文é");
    expect(original.text).toBe("中👩‍💻é");
  });
  it("preserves line and word editing commands", () => {
    const state = setText(emptyEditor(), "first\nhello world");
    expect(editKey(state, "word-left").cursor).toBe(12);
    expect(editKey(state, "word").text).toBe("first\nhello ");
    expect(editKey(state, "kill").text).toBe("first\n");
    const home = editKey(state, "home");
    expect(home.cursor).toBe(6);
    expect(editKey(home, "kill-end").text).toBe("first\n");
    expect(editKey(home, "end").cursor).toBe(state.text.length);
  });
  it("bounds history by bytes and entries and restores a draft after navigation", () => {
    const state = loadHistory(setText(emptyEditor(), "draft"), ["one", "two"]);
    expect(editKey(state, "up").text).toBe("two");
    expect(editKey(editKey(state, "up"), "down").text).toBe("draft");
    expect(remember(setText(state, "two")).history).toEqual(["one", "two"]);
    expect(loadHistory(state, Array.from({ length: 1100 }, (_, i) => String(i))).history).toHaveLength(1000);
    expect(loadHistory(state, ["é".repeat(500001), "kept"]).history).toEqual(["kept"]);
    expect(clearEditor(insertText(state, "pasted", true))).toMatchObject({ text: "", tainted: false });
  });
});

describe("exclusive input focus", () => {
  it("approval preempts a picker and restores the exact composer cursor/history", async () => {
    const f = fixture();
    f.store.loadHistory(["older"]);
    f.send(text("draft中")); f.send(key("left"));
    const draft = f.store.getSnapshot().composer;
    const pick = f.store.choose(spec, signal());
    f.send(text("beta"));
    f.store.begin("Approve? ", true);
    expect(await pick).toBeNull();
    expect(f.store.getSnapshot().focus.kind).toBe("approval");
    expect(await f.store.choose(spec, signal())).toBeNull();
    f.send(key("shift-tab")); f.send(text("y")); f.send(key("enter"));
    expect(f.effects).toEqual([{ type: "approval", answer: "y" }]);
    expect(f.store.getSnapshot().composer).toBe(draft);
    expect(f.store.getSnapshot().focus.kind).toBe("composer");
    f.send(text("Z")); expect(f.store.text).toBe("draftZ中");
    f.store.dispose();
  });

  it("ignores a superseded picker's late abort and removes abort listeners", async () => {
    const f = fixture();
    const old = new AbortController();
    const removed = vi.spyOn(old.signal, "removeEventListener");
    const first = f.store.choose(spec, old.signal);
    const second = f.store.choose({ ...spec, title: "Models" }, signal());
    expect(await first).toBeNull();
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    old.abort();
    expect(f.store.getSnapshot().focus).toMatchObject({ kind: "picker", spec: { title: "Models" } });
    f.send(key("down")); f.send(key("enter"));
    expect(await second).toBe("b");
    expect(f.effects).toEqual([]);
    f.store.dispose();
  });

  it.each([key("shift-tab", true), key("enter", true), text("beta", true), key("up")])("tainted approval cannot authorize with %j", event => {
    const f = fixture();
    f.store.begin("Approve? ", true);
    f.send(event); f.send(key("enter"));
    expect(f.effects).toEqual([{ type: "approval", answer: "no" }]);
    f.store.dispose();
  });

  it("keeps confirmation taint and policy across task refresh", async () => {
    const f = fixture();
    const pending = f.store.choose({ ...spec, confirmation: true }, signal());
    f.send(text("beta", true));
    f.store.updatePicker({ ...spec, items: [...spec.items].reverse() });
    f.send(key("enter"));
    expect(await pending).toBeNull();
    f.store.dispose();
  });

  it("preserves selection by value on refresh and resets selection after editing the query", async () => {
    const f = fixture();
    const pending = f.store.choose(spec, signal());
    f.send(key("down"));
    f.store.updatePicker({ ...spec, items: [...spec.items].reverse() });
    let focus = f.store.getSnapshot().focus;
    expect(focus.kind === "picker" && pickerItems(focus)[focus.index]?.value).toBe("b");
    f.send(text("agent")); f.send(key("down")); f.send(key("backspace"));
    focus = f.store.getSnapshot().focus;
    expect(focus).toMatchObject({ kind: "picker", index: 0 });
    f.send(key("escape"));
    expect(await pending).toBeNull();
    expect(f.effects).toEqual([]);
    f.store.dispose();
  });

  it("commits state before side effects and batches notifications without losing successive submissions", () => {
    const f = fixture();
    const notify = vi.fn(); f.store.subscribe(notify);
    f.store.setBatch(true);
    f.send(text("first")); f.send(key("enter")); f.send(text("second")); f.send(key("alt-enter"), true, true);
    expect(notify).not.toHaveBeenCalled();
    expect(f.effects.filter(effect => effect.type === "submit")).toMatchObject([
      { text: "first", steer: false }, { text: "second", steer: true },
    ]);
    expect(f.store.text).toBe("");
    f.store.setBatch(false);
    expect(notify).toHaveBeenCalledOnce();
    f.store.dispose();
  });

  it("does not overwrite a new focus opened synchronously by a submit callback", () => {
    let store: InputStore;
    store = new InputStore(effect => {
      if (effect.type === "submit") {
        expect(store.text).toBe("");
        store.begin("Approve? ", true);
      }
    });
    store.dispatch(text("run"), false, false);
    store.dispatch(key("enter"), false, false);
    expect(store.getSnapshot().focus.kind).toBe("approval");
    expect(store.getSnapshot().composer.history).toEqual(["run"]);
    store.dispose();
  });

  it("suppresses typing and notifications after disposal and resolves a picker only once", async () => {
    const f = fixture();
    const abort = new AbortController();
    const pending = f.store.choose(spec, abort.signal);
    const notify = vi.fn(); f.store.subscribe(notify);
    f.store.dispose(); f.store.dispose(); abort.abort(); f.send(text("ignored")); f.send(key("enter"));
    expect(await pending).toBeNull();
    expect(f.effects).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    expect(await f.store.choose(spec, signal())).toBeNull();
  });

  it("keeps a paused busy draft but lets active runs queue and steer", () => {
    const f = fixture();
    f.send(text("draft")); f.send(key("enter"), true, false);
    expect(f.store.text).toBe("draft"); expect(f.effects).toEqual([]);
    f.send(key("enter"), true, true);
    f.send(text("/tasks")); f.send(key("alt-enter"), true, true);
    expect(f.effects).toMatchObject([{ type: "submit", text: "draft", steer: false }, { type: "submit", text: "/tasks", steer: false }]);
    f.store.dispose();
  });

  it("returns immutable reducer output with no hidden side effects", () => {
    const initial = Object.freeze(initialInput());
    const typed = reduceInput(initial, text("/mod"), false, false);
    const completed = reduceInput(typed.state, key("tab"), false, false);
    expect(initial.composer.text).toBe("");
    expect(typed.state.composer.text).toBe("/mod");
    expect(focusedEditor(completed.state).text).toBe("/model ");
    expect(completed.effects).toEqual([]);
  });
});
