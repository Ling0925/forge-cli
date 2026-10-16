import type { ReactNode } from "react";
import type { Instance } from "ink";
import type { ApprovalRequest, TaskPlan } from "../../shared/schemas";
import { approvalLines, terminalText } from "../format";
import { plainLines } from "../render/rich";
import { terminalColorDepth } from "../palette";
import type { TerminalController, TerminalControllerOptions } from "../terminal-controller";
import type { InputEvent } from "../terminal/decoder";
import type { ComposerContext, PickerSpec, RenderUpdate, RichLine, RunStatus, UIOptions } from "../ui-contract";
import { InputStore } from "./input-store";
import { TerminalModes } from "./terminal-modes";
import { Transcript, ReadingView } from "./transcript";
import type { CommittedOutput } from "./output";
import type { InkViewState } from "./types";

/** Terminal lifecycle/output adapter. Framework owns painting, stores own input/reading. */
export class InkController implements TerminalController {
  busy = false;
  private batching = false;
  get batch(): boolean { return this.batching; }
  set batch(value: boolean) { this.batching = value; this.input.setBatch(value); }
  private readonly input: InputStore;
  private readonly modes: TerminalModes;
  private readonly transcript = new Transcript();
  private readonly reading = new ReadingView();
  private output: CommittedOutput | undefined;
  private outputId = 0;
  private tail: readonly RichLine[] = [];
  private status: RunStatus | null = null;
  private context: ComposerContext | null = null;
  private plan: TaskPlan | null = null;
  private mode: "build" | "plan" = "build";
  private modeToggle: (() => void) | undefined;
  private pendingInput: readonly string[] = [];
  private inputHint: string | null = null;
  private instance: Instance | undefined;
  private renderView: (() => ReactNode) | undefined;
  private mounting: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private configured = false;

  constructor(private readonly options: TerminalControllerOptions) {
    this.modes = new TerminalModes(options.input as NodeJS.ReadStream, options.output as NodeJS.WriteStream, () => this.draw());
    this.input = new InputStore(effect => {
      switch (effect.type) {
        case "submit": this.append(plainLines(effect.echo)); this.options.submit(effect.text, effect.steer); break;
        case "approval": this.options.submit(effect.answer); break;
        case "interrupt": this.options.interrupt(); break;
        case "toggle-mode": this.modeToggle?.(); break;
      }
    });
  }
  get fresh(): boolean { return this.input.fresh; }
  get inputText(): string { return this.input.text; }
  loadHistory(entries: readonly string[]): void { this.input.loadHistory(entries); }
  clearInput(): void { this.input.overflow(); }
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
    this.options.start();
    this.configured = true;
    this.modes.configure(options.theme);
    if (this.instance) { this.draw(); return; }
    this.mounting ??= this.mount();
    await this.mounting;
  }
  private async mount(): Promise<void> {
    try {
      const [{ render }, { createElement }, { InkApp }] = await Promise.all([import("ink"), import("react"), import("./app")]);
      if (this.disposed) return;
      this.modes.enterFullscreen();
      this.renderView = () => createElement(InkApp, { state: this.snapshot(), input: this.input });
      this.prepareOutput();
      this.instance = render(this.renderView(), {
        stdin: this.options.input as NodeJS.ReadStream,
        stdout: this.options.output as NodeJS.WriteStream, stderr: this.options.output as NodeJS.WriteStream,
        exitOnCtrlC: false, patchConsole: false, incrementalRendering: true, maxFps: 30,
        isScreenReaderEnabled: this.modes.screenReader,
      });
      if (!this.modes.screenReader) {
        this.timer = setInterval(() => {
          if (this.reading.active) return;
          const focus = this.input.getSnapshot().focus;
          if (this.status || (focus.kind === "picker" && focus.spec.items.some(item => item.active))
            || this.tail.some(line => line.some(span => span.animation))) this.draw();
        }, 80);
        this.timer.unref();
      }
    } catch (error) { this.dispose(); throw error; }
  }
  private prepareOutput(): void {
    if (!this.modes.screenReader) { this.transcript.discardPending(); return; }
    if (this.reading.active) return;
    const depth = terminalColorDepth(this.options.output);
    const chunks = this.transcript.drain(Math.max(1, this.columns - 1), this.modes.theme, process.env.NO_COLOR !== undefined, depth);
    if (chunks.length) this.output = { id: ++this.outputId, chunks };
  }
  private snapshot(): InkViewState {
    return {
      columns: this.columns, rows: this.rows, output: this.output, tail: this.modes.screenReader ? [] : this.tail,
      reading: this.reading.snapshot(), screenReader: this.modes.screenReader,
      visibleHistory: this.modes.screenReader ? [] : this.transcript.recent(Math.max(1, this.columns - 1)),
      status: this.status, context: this.context, plan: this.plan, mode: this.mode,
      theme: this.modes.theme, noColor: process.env.NO_COLOR !== undefined,
      colorDepth: terminalColorDepth(this.options.output),
      pendingInput: this.pendingInput, inputHint: this.inputHint, now: Date.now(),
    };
  }
  draw(): void {
    if (!this.batch && !this.disposed && this.renderView && this.instance) {
      this.prepareOutput();
      this.instance.rerender(this.renderView());
    }
  }
  resize(): void { this.reading.resize(Math.max(1, this.columns - 1)); this.draw(); }
  append(lines: readonly RichLine[]): void {
    this.transcript.append(lines, this.reading.active);
    if (!this.modes.screenReader) this.transcript.discardPending();
    if (this.reading.active) { this.reading.changed(); return; }
    this.draw();
  }
  setTail(lines: readonly RichLine[]): void {
    this.tail = lines;
    if (this.reading.active) { this.reading.changed(); return; }
    this.draw();
  }
  setStatus(status: RunStatus | null): void { this.status = status; if (!this.reading.active) this.draw(); }
  setBusy(busy: boolean): void { this.busy = busy; if (!this.reading.active) this.draw(); }
  setMode(mode: "build" | "plan"): void { this.mode = mode; if (!this.reading.active) this.draw(); }
  setPlan(plan: TaskPlan | null): void { this.plan = plan; if (!this.reading.active) this.draw(); }
  setContext(context: ComposerContext | null): void { this.context = context; if (!this.reading.active) this.draw(); }
  setInputHint(hint: string | null): void { this.inputHint = hint; if (!this.reading.active) this.draw(); }
  setPendingInput(lines: readonly string[]): void { this.pendingInput = lines.slice(0, 2); if (!this.reading.active) this.draw(); }
  onModeToggle(callback: () => void): () => void { this.modeToggle = callback; return () => { if (this.modeToggle === callback) this.modeToggle = undefined; }; }
  update(update: RenderUpdate): void {
    const previous = this.batch;
    this.batch = true;
    try {
      this.transcript.append(update.append, this.reading.active);
      if (!this.modes.screenReader) this.transcript.discardPending();
      this.tail = update.tail;
      if ("status" in update) this.status = update.status ?? null;
    } finally { this.batch = previous; }
    if (this.reading.active) { this.reading.changed(); return; }
    this.draw();
  }
  begin(prompt: string, fresh: boolean): void {
    if (fresh) { this.reading.close(); this.draw(); }
    this.input.begin(prompt, fresh);
    if (!this.configured) this.options.output.write(terminalText(prompt));
  }
  end(): void { this.input.end(); }
  handle(event: InputEvent): void {
    if (this.disposed || this.modes.handle(event)) return;
    const key = event.kind === "key" && !event.pasted ? event.key : "";
    if (event.kind === "mouse") {
      // Clicks never select actions or authorize tools. The decoder suppresses
      // pasted reports; modified gestures are reserved for native selection.
      if (!this.modes.mouseEnabled || event.shift || this.input.getSnapshot().focus.kind !== "composer"
        || (event.action !== "wheel-up" && event.action !== "wheel-down")) return;
      if (!this.reading.active) {
        if (event.action === "wheel-down") return;
        this.reading.open(this.transcript.recent(Math.max(1, this.columns - 1)), this.tail, Math.max(1, this.columns - 1));
      }
      this.reading.move(event.action === "wheel-up" ? -3 : 3, Math.max(1, this.rows - 2));
      const snapshot = this.reading.snapshot();
      if (event.action === "wheel-down" && snapshot && snapshot.end >= snapshot.lines.length) this.reading.close();
      this.draw();
      return;
    }
    if (this.reading.active) {
      if (key === "page-up" || key === "page-down") this.reading.move((key === "page-up" ? -1 : 1) * Math.max(1, this.rows - 3), Math.max(1, this.rows - 2));
      else if (key === "escape" || key === "end" || key === "interrupt") this.reading.close();
      // Text/Enter while reading is never an implicit submission or approval.
      this.draw();
      return;
    }
    if (key === "page-up" && this.configured && !this.modes.screenReader && this.input.getSnapshot().focus.kind === "composer") {
      this.reading.open(this.transcript.recent(Math.max(1, this.columns - 1)), this.tail, Math.max(1, this.columns - 1));
      this.draw();
      return;
    }
    this.input.dispatch(event, this.busy, this.options.runInputActive());
  }
  updatePicker(spec: PickerSpec): void { this.input.updatePicker(spec); }
  choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null> {
    if (this.disposed || signal.aborted || this.fresh) return Promise.resolve(null);
    this.reading.close(); this.draw(); this.options.start();
    return this.input.choose(spec, signal);
  }
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    this.reading.close();
    this.append(approvalLines(request, this.columns).slice(0, -1));
    return this.options.approval("Approve? [Y/n] ", signal);
  }
  dispose(): void {
    if (this.disposed) return;
    this.reading.close();
    this.draw();
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.modeToggle = undefined; this.input.dispose();
    try {
      if (this.instance) { this.instance.rerender(null); this.instance.unmount(); this.instance.cleanup(); this.instance = undefined; }
    } finally { this.modes.dispose(); }
  }
}
