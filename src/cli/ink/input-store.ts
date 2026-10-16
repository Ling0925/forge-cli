import { terminalText } from "../format";
import { uiSymbols } from "../symbols";
import type { InputEvent } from "../terminal/decoder";
import type { PickerSpec } from "../ui-contract";
import { clearEditor, emptyEditor, loadHistory } from "./input-editor";
import { closedMenu, focusedEditor, initialInput, pickerItems, reduceInput, type InputEffect, type InputState } from "./input-state";

/** Synchronous external store: React subscribes, but effects never wait for a render. */
export class InputStore {
  private state = initialInput();
  private readonly listeners = new Set<() => void>();
  private pending: { id: number; finish(value: string | null): void } | undefined;
  private nextPicker = 0;
  private disposed = false;
  private batching = false;
  private dirty = false;
  setBatch(value: boolean): void {
    this.batching = value;
    if (!value && this.dirty) this.notify();
  }
  private notify(): void {
    if (this.disposed) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }
  readonly getSnapshot = (): InputState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  constructor(private readonly effect: (effect: Exclude<InputEffect, { type: "pick" }>) => void) {}
  private commit(state: InputState): void {
    if (this.disposed || state === this.state) return;
    this.state = state;
    if (this.batching) this.dirty = true;
    else this.notify();
  }
  get fresh(): boolean { return this.state.focus.kind === "approval"; }
  get text(): string { return focusedEditor(this.state).text; }
  dispatch(event: InputEvent, busy: boolean, running: boolean): void {
    if (this.disposed) return;
    const transition = reduceInput(this.state, event, busy, running);
    this.commit(transition.state);
    for (const effect of transition.effects) {
      if (this.disposed) break;
      if (effect.type === "pick") {
        if (this.pending?.id === effect.id) this.pending.finish(effect.value);
      } else this.effect(effect);
    }
  }
  begin(prompt: string, fresh: boolean): void {
    if (this.disposed) return;
    if (fresh) this.pending?.finish(null);
    this.commit({ ...this.state, prompt: terminalText(prompt), menu: closedMenu(), dismissed: false,
      focus: fresh ? { kind: "approval", editor: emptyEditor() } : this.state.focus.kind === "approval" ? { kind: "composer" } : this.state.focus });
  }
  end(): void {
    this.commit({ ...this.state, prompt: `${uiSymbols().prompt} `, menu: closedMenu(),
      focus: this.fresh ? { kind: "composer" } : this.state.focus });
  }
  loadHistory(entries: readonly string[]): void {
    if (!this.fresh) this.commit({ ...this.state, composer: loadHistory(this.state.composer, entries) });
  }
  overflow(): void {
    if (this.fresh) {
      this.commit({ ...this.state, focus: { kind: "approval", editor: clearEditor(focusedEditor(this.state)) } });
    } else {
      this.commit({ ...this.state, composer: clearEditor(this.state.composer), menu: closedMenu() });
      this.pending?.finish(null);
    }
  }
  choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null> {
    if (this.disposed || signal.aborted || this.fresh) return Promise.resolve(null);
    this.pending?.finish(null);
    return new Promise(resolve => {
      const id = ++this.nextPicker;
      let settled = false;
      const abort = () => finish(null);
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        const focus = this.state.focus;
        const tainted = focus.kind === "picker" && focus.id === id && focus.spec.confirmation && focus.editor.tainted;
        if (this.pending?.id === id) this.pending = undefined;
        if (focus.kind === "picker" && focus.id === id)
          this.commit({ ...this.state, focus: { kind: "composer" }, menu: closedMenu() });
        resolve(tainted ? null : value);
      };
      this.pending = { id, finish };
      this.commit({ ...this.state, menu: closedMenu(), focus: { kind: "picker", id, spec, editor: emptyEditor(),
        index: Math.max(0, spec.items.findIndex(item => item.value === spec.selected)) } });
      if (signal.aborted) finish(null);
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
  updatePicker(spec: PickerSpec): void {
    const focus = this.state.focus;
    if (focus.kind !== "picker" || focus.spec.title !== spec.title) return;
    const selected = pickerItems(focus)[focus.index]?.value;
    // Refresh cannot downgrade an already-open explicit confirmation.
    const next = { ...focus, spec: focus.spec.confirmation ? { ...spec, confirmation: true } : spec };
    const items = pickerItems(next);
    const index = items.findIndex(item => item.value === selected);
    this.commit({ ...this.state, focus: { ...next, index: index >= 0 ? index : Math.max(0, Math.min(focus.index, items.length - 1)) } });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending?.finish(null);
    this.state = { ...this.state, focus: { kind: "composer" }, menu: closedMenu() };
    this.listeners.clear();
  }
}
