import type { ReactNode } from "react";
import type { Instance } from "ink";
import type { ApprovalRequest, TaskPlan } from "../../shared/schemas";
import { approvalLines, terminalText } from "../format";
import { plainLines } from "../render/rich";
import type { TerminalController, TerminalControllerOptions } from "../terminal-controller";
import type { InputEvent } from "../terminal/decoder";
import type { ComposerContext, PickerSpec, RenderUpdate, RichLine, RunStatus, UIOptions } from "../ui-contract";
import { InputStore } from "./input-store";
import type { InkViewState } from "./types";

/** Terminal lifecycle and output adapter. Input focus belongs to InputStore. */
export class InkController implements TerminalController {
  busy = false;
  private batching = false;
  get batch(): boolean { return this.batching; }
  set batch(value: boolean) { this.batching = value; this.input.setBatch(value); }
  private readonly input: InputStore;
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

  constructor(private readonly options: TerminalControllerOptions) {
    this.input = new InputStore(effect => {
      switch (effect.type) {
        case "submit":
          this.append(plainLines(effect.echo));
          this.options.submit(effect.text, effect.steer);
          break;
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
      // The decoder is the only stream owner and retains paste provenance.
      this.options.output.write("\x1b[?2004h");
      const [{ render }, { createElement }, { InkApp }] = await Promise.all([
        import("ink"), import("react"), import("./app"),
      ]);
      if (this.disposed) return;
      this.renderView = () => createElement(InkApp, { state: this.snapshot(), input: this.input });
      this.instance = render(this.renderView(), {
        stdin: input, stdout: this.options.output as NodeJS.WriteStream, stderr: this.options.output as NodeJS.WriteStream,
        exitOnCtrlC: false, patchConsole: false, incrementalRendering: true, maxFps: 30,
      });
      this.timer = setInterval(() => {
        const focus = this.input.getSnapshot().focus;
        if (this.status || (focus.kind === "picker" && focus.spec.items.some(item => item.active))
          || this.tail.some(line => line.some(span => span.animation))) this.draw();
      }, 80);
      this.timer.unref();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private snapshot(): InkViewState {
    return {
      columns: this.columns, rows: this.rows, history: this.history, tail: this.tail,
      status: this.status, context: this.context, plan: this.plan, mode: this.mode,
      theme: this.theme, noColor: process.env.NO_COLOR !== undefined,
      pendingInput: this.pendingInput, inputHint: this.inputHint, now: Date.now(),
    };
  }
  draw(): void {
    if (!this.batch && !this.disposed && this.renderView) this.instance?.rerender(this.renderView());
  }
  resize(): void { this.draw(); }
  append(lines: readonly RichLine[]): void {
    if (lines.length) this.history = [...this.history, ...lines.map(line => ({ id: this.nextId++, line }))];
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
    try {
      this.append(update.append);
      this.tail = update.tail;
      if ("status" in update) this.status = update.status ?? null;
    } finally { this.batch = previous; }
    this.draw();
  }
  begin(prompt: string, fresh: boolean): void {
    this.input.begin(prompt, fresh);
    if (!this.configured) this.options.output.write(terminalText(prompt));
  }
  end(): void { this.input.end(); }
  handle(event: InputEvent): void { this.input.dispatch(event, this.busy, this.options.runInputActive()); }
  updatePicker(spec: PickerSpec): void { this.input.updatePicker(spec); }
  choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null> {
    if (this.disposed || signal.aborted || this.fresh) return Promise.resolve(null);
    this.options.start();
    return this.input.choose(spec, signal);
  }
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    this.append(approvalLines(request, this.columns).slice(0, -1));
    return this.options.approval("Approve? [Y/n] ", signal);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.modeToggle = undefined;
    this.input.dispose();
    try {
      if (this.instance) {
        this.instance.rerender(null);
        this.instance.unmount();
        this.instance.cleanup();
        this.instance = undefined;
      }
    } finally {
      if (this.configured) {
        this.options.output.write("\x1b[?2004l");
        (this.options.input as NodeJS.ReadStream).setRawMode?.(this.oldRaw);
      }
    }
  }
}
