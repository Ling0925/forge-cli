import type { ReactNode } from "react";
import type { Instance } from "ink";
import type { ApprovalRequest, TaskPlan } from "../../shared/schemas";
import { approvalLines, terminalText } from "../format";
import { plainLines } from "../render/rich";
import { SlashMenu } from "../slash-menu";
import type { TerminalController, TerminalControllerOptions } from "../terminal-controller";
import type { InputEvent } from "../terminal/decoder";
import { Editor } from "../terminal/editor";
import type { ComposerContext, PickerSpec, RenderUpdate, RichLine, RunStatus, UIOptions } from "../ui-contract";
import type { InkViewState } from "./types";

/** Ink owns layout, reconciliation and output. The migration bridge owns input only. */
export class InkController implements TerminalController {
  editor = new Editor();
  picker: { spec: PickerSpec; editor: Editor; index: number; resolve(value: string | null): void } | undefined;
  busy = false;
  batch = false;
  fresh = false;
  private readonly menu = new SlashMenu();
  private dismissed = false;
  private savedDraft: Editor | undefined;
  private prompt = "❯ ";
  private history: { id: number; line: RichLine }[] = [];
  private nextId = 0;
  private tail: readonly RichLine[] = [];
  private status: RunStatus | null = null;
  private context: ComposerContext | null = null;
  private plan: TaskPlan | null = null;
  private mode: "build" | "plan" = "build";
  private modeToggle: (() => void) | undefined;
  private pendingInput: readonly string[] = [];
  private inputHint: string | null = null;
  private theme: UIOptions["theme"] = "system";
  private instance: Instance | undefined;
  private renderView: (() => ReactNode) | undefined;
  private mounting: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private configured = false;
  private oldRaw = false;

  constructor(private readonly options: TerminalControllerOptions) {}
  get columns(): number {
    const value = (this.options.output as { columns?: number }).columns;
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 80;
  }
  get rows(): number {
    const value = (this.options.output as { rows?: number }).rows;
    return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 24;
  }
  async configure(options: UIOptions): Promise<void> {
    if (this.disposed) return;
    const background = Number(process.env.COLORFGBG?.split(";").at(-1));
    this.theme = options.theme === "system" && Number.isFinite(background)
      ? background >= 7 ? "light" : "dark" : options.theme;
    if (this.instance) { this.draw(); return; }
    this.mounting ??= this.mount();
    await this.mounting;
  }
  private async mount(): Promise<void> {
    this.options.start();
    const input = this.options.input as NodeJS.ReadStream;
    this.oldRaw = Boolean(input.isRaw);
    this.configured = true;
    try {
      input.setRawMode?.(true);
      // InputDecoder remains the sole input owner during the first migration stage.
      this.options.output.write("\x1b[?2004h");
      // Non-interactive commands must not load Ink or install its exit hooks.
      const [{ render }, { createElement }, { InkView }] = await Promise.all([
        import("ink"), import("react"), import("./view"),
      ]);
      if (this.disposed) return;
      this.renderView = () => createElement(InkView, { state: this.snapshot() });
      this.instance = render(this.renderView(), {
        stdin: input,
        stdout: this.options.output as NodeJS.WriteStream,
        stderr: this.options.output as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
        maxFps: 30,
      });
      this.timer = setInterval(() => {
        if (this.status || this.picker?.spec.items.some(item => item.active)
          || this.tail.some(line => line.some(span => span.animation))) this.draw();
      }, 80);
      this.timer.unref();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private snapshot(): InkViewState {
    const editor = this.picker?.editor ?? this.editor;
    return {
      columns: this.columns, rows: this.rows, history: this.history, tail: this.tail,
      status: this.status, context: this.context, plan: this.plan, mode: this.mode,
      theme: this.theme, noColor: process.env.NO_COLOR !== undefined,
      prompt: this.prompt, text: editor.text, cursor: editor.cursor, fresh: this.fresh,
      pendingInput: this.pendingInput, inputHint: this.inputHint, menu: this.menu.state,
      picker: this.picker ? { spec: this.picker.spec, items: this.filtered(), index: this.picker.index } : null,
      now: Date.now(),
    };
  }
  draw(): void {
    if (!this.batch && !this.disposed && this.renderView) this.instance?.rerender(this.renderView());
  }
  resize(): void { this.draw(); }
  append(lines: readonly RichLine[]): void {
    this.history = [...this.history, ...lines.map(line => ({ id: this.nextId++, line }))];
    this.draw();
  }
  setTail(lines: readonly RichLine[]): void { this.tail = lines; this.draw(); }
  setStatus(status: RunStatus | null): void { this.status = status; this.draw(); }
  setBusy(busy: boolean): void { this.busy = busy; this.draw(); }
  setMode(mode: "build" | "plan"): void { this.mode = mode; this.draw(); }
  setPlan(plan: TaskPlan | null): void { this.plan = plan; this.draw(); }
  setContext(context: ComposerContext | null): void { this.context = context; this.draw(); }
  setInputHint(hint: string | null): void { this.inputHint = hint; this.draw(); }
  setPendingInput(lines: readonly string[]): void { this.pendingInput = lines.slice(0, 2); this.draw(); }
  onModeToggle(callback: () => void): () => void {
    this.modeToggle = callback;
    return () => { if (this.modeToggle === callback) this.modeToggle = undefined; };
  }
  update(update: RenderUpdate): void {
    const previous = this.batch;
    this.batch = true;
    this.append(update.append);
    this.tail = update.tail;
    if ("status" in update) this.status = update.status ?? null;
    this.batch = previous;
    this.draw();
  }
  begin(prompt: string, fresh: boolean): void {
    if (fresh) this.picker?.resolve(null);
    this.prompt = terminalText(prompt);
    this.fresh = fresh;
    this.dismissed = false;
    this.menu.close();
    if (fresh) { this.savedDraft = this.editor; this.editor = new Editor(); }
    if (!this.configured) this.options.output.write(this.prompt);
    this.draw();
  }
  end(): void {
    if (this.savedDraft) { this.editor = this.savedDraft; this.savedDraft = undefined; }
    this.fresh = false;
    this.prompt = "❯ ";
    this.menu.close();
    this.draw();
  }
  private finish(steer = false): void {
    const text = this.editor.text;
    this.editor.remember();
    this.editor.clear();
    this.menu.close();
    this.dismissed = true;
    this.append(plainLines(this.prompt + text));
    this.options.submit(text, steer && this.options.runInputActive() && !text.startsWith("/"));
  }
  handle(event: InputEvent): void {
    if (this.disposed || event.kind === "mouse" || event.kind === "background") return;
    const editor = this.picker?.editor ?? this.editor;
    if (event.pasted && (this.fresh || this.picker?.spec.confirmation)) editor.tainted = true;
    if (event.kind === "key" && this.fresh && ["up", "down"].includes(event.key)) editor.tainted = true;
    const previousText = editor.text;
    if (event.kind === "text") {
      editor.insert(event.text, event.pasted);
      this.dismissed = false;
      if (this.picker) this.picker.index = 0;
    } else if (event.pasted) {
      editor.tainted = true;
      if (event.key === "enter" && !this.fresh && !this.picker) editor.insert("\n", true);
    } else if (event.key === "shift-tab") {
      if (!this.fresh && !this.picker) this.modeToggle?.();
    } else if (event.key === "interrupt") {
      if (this.picker) this.picker.resolve(null);
      else if (this.fresh) { this.options.submit("no"); this.options.interrupt(); }
      else if (this.busy || !editor.text) this.options.interrupt();
      else editor.clear();
    } else if (event.key === "escape") {
      if (this.picker) this.picker.resolve(null);
      else if (this.fresh) { editor.clear(); this.options.submit("no"); }
      else { this.dismissed = true; this.menu.close(); }
    } else if (event.key === "tab") {
      const selected = !this.fresh && !this.picker ? this.menu.getSelected() : undefined;
      if (selected) { editor.set(`${selected.name} `); this.menu.close(); }
    } else if (["enter", "shift-enter", "alt-enter"].includes(event.key)) {
      if (this.picker) {
        if (event.key === "enter") this.picker.resolve(this.filtered()[this.picker.index]?.value ?? null);
      } else if (this.fresh) {
        const answer = editor.tainted || event.key !== "enter" ? "no" : editor.text;
        editor.clear();
        this.options.submit(answer);
      } else if (!this.busy || this.options.runInputActive() || editor.text.startsWith("/")) {
        if (this.menu.isActive) editor.set(this.menu.getSelected()?.name ?? editor.text);
        if (editor.text.endsWith("\\")) {
          editor.set(editor.text.slice(0, -1));
          editor.insert("\n");
        } else this.finish(event.key !== "enter");
      }
    } else if (this.picker && ["up", "down"].includes(event.key)) {
      const length = this.filtered().length;
      this.picker.index = length ? (this.picker.index + (event.key === "up" ? length - 1 : 1)) % length : 0;
    } else if (this.menu.isActive && ["up", "down"].includes(event.key)) {
      if (event.key === "up") this.menu.moveUp(); else this.menu.moveDown();
    } else if (!this.fresh || !["up", "down"].includes(event.key)) editor.key(event.key);
    if (editor.text !== previousText) this.dismissed = false;
    if (!this.fresh && !this.picker && !this.dismissed && editor.cursor === editor.text.length) this.menu.update(editor.text);
    else this.menu.close();
    this.draw();
  }
  private filtered() {
    const picker = this.picker;
    if (!picker) return [];
    const query = picker.editor.text.toLocaleLowerCase();
    return picker.spec.items.filter(item => `${item.label} ${item.detail ?? ""} ${item.value}`.toLocaleLowerCase().includes(query));
  }
  updatePicker(spec: PickerSpec): void {
    const picker = this.picker;
    if (!picker || picker.spec.title !== spec.title || this.fresh) return;
    const selected = this.filtered()[picker.index]?.value;
    picker.spec = spec;
    const items = this.filtered();
    const index = items.findIndex(item => item.value === selected);
    picker.index = index >= 0 ? index : Math.max(0, Math.min(picker.index, items.length - 1));
    this.draw();
  }
  async choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null> {
    if (this.disposed || signal.aborted || this.fresh) return null;
    this.options.start();
    this.picker?.resolve(null);
    this.menu.close();
    return new Promise(resolve => {
      const editor = new Editor();
      let settled = false;
      const abort = () => finish(null);
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        this.picker = undefined;
        this.draw();
        resolve(spec.confirmation && editor.tainted ? null : value);
      };
      this.picker = { spec, editor, index: Math.max(0, spec.items.findIndex(item => item.value === spec.selected)), resolve: finish };
      signal.addEventListener("abort", abort, { once: true });
      this.draw();
    });
  }
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    this.append(approvalLines(request, this.columns).slice(0, -1));
    return this.options.approval("Approve? [Y/n] ", signal);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.picker?.resolve(null);
    if (this.timer) clearInterval(this.timer);
    this.modeToggle = undefined;
    if (this.instance) {
      // Remove the transient composer without discarding committed scrollback.
      this.instance.rerender(null);
      this.instance.unmount();
      this.instance.cleanup();
      this.instance = undefined;
    }
    if (this.configured) {
      this.options.output.write("\x1b[?2004l");
      (this.options.input as NodeJS.ReadStream).setRawMode?.(this.oldRaw);
    }
  }
}
