import type { ApprovalRequest, TaskPlan } from "../../../src/shared/schemas";
import { approvalLines, terminalText } from "../../../src/cli/format";
import { SlashMenu } from "../../../src/cli/slash-menu";
import { createTheme, resolveTheme } from "../../../src/cli/theme";
import type {
  ComposerContext,
  PickerSpec,
  RenderUpdate,
  RichLine,
  RunStatus,
  TerminalUI,
  UIOptions,
} from "../../../src/cli/ui-contract";
import type { InputEvent } from "../../../src/cli/terminal/decoder";
import { Editor } from "./editor";
import { handle } from "./keys";
import { Screen, plain } from "./screen";
import { type Picker, draw } from "./view";

export class Controller implements TerminalUI {
  editor = new Editor();
  get inputText(): string { return this.picker?.editor.text ?? this.editor.text; }
  loadHistory(entries: readonly string[]): void { if (!this.fresh) this.editor.loadHistory(entries); }
  clearInput(): void { this.editor.clear(); this.picker?.resolve(null); }
  readonly menu = new SlashMenu(8);
  readonly screen: Screen;
  busy = false;
  batch = false;
  prompt = "";
  fresh = false;
  tail: readonly RichLine[] = [];
  status: RunStatus | null = null;
  inputHint: string | null = null;
  pendingInput: readonly string[] = [];
  context: ComposerContext | null = null;
  dismissed = false;
  private savedDraft: Editor | undefined;
  picker: Picker | undefined;
  private setting: UIOptions["theme"] = "system";
  background: "light" | "dark" | "unknown" = "unknown";
  probe: ReturnType<typeof setTimeout> | undefined;
  private oldRaw = false;
  private configured = false;
  private queried = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  notice: string | null = null;
  toggleNativeSelection(): void {
    if (!this.screen.enabled || !this.screen.fixed || this.fresh || this.picker) return;
    if (this.screen.nativeSelection) {
      this.screen.nativeSelection = false;
      this.output.write("\x1b[?1002h\x1b[?1006h");
      this.notify("Live view resumed · Ctrl+G for terminal-native copy");
    } else {
      this.screen.clearSelection();
      this.notify("Native selection · terminal Copy / Ctrl+Shift+C · Ctrl+G resume");
      this.screen.nativeSelection = true;
      this.output.write("\x1b[?1002l\x1b[?1006l");
    }
  }
  resumeNativeSelection(): void {
    if (!this.screen.nativeSelection) return;
    this.screen.nativeSelection = false;
    this.output.write("\x1b[?1002h\x1b[?1006h");
  }
  notify(text: string): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice = null; this.noticeTimer = undefined; this.draw(); }, 1500);
    this.noticeTimer.unref();
    this.draw();
  }
  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly tty: boolean,
    private readonly start: () => void,
    readonly submit: (text: string, steer?: boolean) => void,
    readonly interrupt: () => void,
    private readonly approval: (
      prompt: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly runInputEnabled: () => boolean = () => false,
    private readonly inline = false,
  ) {
    this.screen = new Screen(output, () => this, createTheme({ isTTY: false }));
  }
  get columns(): number {
    return Math.max(
      1,
      "columns" in this.output && typeof this.output.columns === "number"
        ? this.output.columns
        : 80,
    );
  }
  get rows(): number {
    return Math.max(
      1,
      "rows" in this.output && typeof this.output.rows === "number"
        ? this.output.rows
        : 24,
    );
  }
  theme(): void {
    this.screen.theme = resolveTheme({
      setting: this.setting,
      background: this.background,
      colorDepth:
        "getColorDepth" in this.output &&
        typeof this.output.getColorDepth === "function"
          ? Number(this.output.getColorDepth())
          : 4,
      noColor: process.env.NO_COLOR !== undefined,
      dumb: !this.screen.enabled,
    });
  }
  async configure(options: UIOptions): Promise<void> {
    this.setting = options.theme;
    const color = Number(process.env.COLORFGBG?.split(";").at(-1));
    if (this.background === "unknown" && Number.isFinite(color))
      this.background = color >= 7 ? "light" : "dark";
    this.start();
    if (!this.configured) {
      this.configured = true;
      this.screen.enabled = this.tty && process.env.TERM !== "dumb";
      if (this.screen.enabled) {
        if ("isRaw" in this.input) this.oldRaw = Boolean(this.input.isRaw);
        if (
          "setRawMode" in this.input &&
          typeof this.input.setRawMode === "function"
        )
          this.input.setRawMode(true);
        this.screen.fixed = !this.inline;
        this.output.write(this.inline ? "\x1b[?2004h\x1b[?25h" : "\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?25h");
        let lastSecond = Math.floor(Date.now() / 1000);
        let lastFrame = Math.floor(Date.now() / 80);
        // Streaming draws remain immediate. Timer-only work runs once per visible
        // animation frame, not once per 22ms tick when the frame is unchanged.
        this.timer = setInterval(() => {
          const now = Date.now();
          const second = Math.floor(now / 1000);
          const frame = Math.floor(now / 80);
          if (frame === lastFrame && second === lastSecond) return;
          const animated = this.tail.some((line) => line.some((span) => span.animation === "spinner"));
          const activePicker = this.picker && this.filtered().some(item => item.active);
          if ((frame !== lastFrame && (animated || activePicker || this.status?.cancellable || this.status?.observing))
            || (this.status && second !== lastSecond)) this.draw();
          lastSecond = second;
          lastFrame = frame;
        }, 22);
        this.timer.unref();
      }
    }
    this.theme();
    if (!this.prompt) this.prompt = "❯ ";
    this.draw();
    if (
      this.screen.enabled &&
      this.setting === "system" &&
      this.background === "unknown" &&
      !this.queried
    ) {
      this.queried = true;
      this.output.write("\x1b]11;?\x07");
      this.probe = setTimeout(() => {
        this.probe = undefined;
      }, 200);
    }
  }
  append(lines: readonly RichLine[]): void {
    this.screen.append(lines);
    this.draw();
  }
  setTail(lines: readonly RichLine[]): void {
    this.tail = lines;
    this.draw();
  }
  setStatus(status: RunStatus | null): void {
    this.status = status;
    this.draw();
  }
  plan: TaskPlan | null = null;
  setPlan(plan: TaskPlan | null): void { this.plan = plan; this.draw(); }
  mode: "build" | "plan" = "build";
  modeToggle: (() => void) | undefined;
  setMode(mode: "build" | "plan"): void { this.mode = mode; this.draw(); }
  onModeToggle(callback: () => void): () => void {
    this.modeToggle = callback;
    return () => { if (this.modeToggle === callback) this.modeToggle = undefined; };
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.draw();
  }
  setInputHint(hint: string | null): void {
    this.inputHint = hint === null ? null : terminalText(hint);
    this.draw();
  }
  setPendingInput(lines: readonly string[]): void {
    this.pendingInput = lines.slice(0, 2).map(line => terminalText(line).replaceAll("\n", " ↵ "));
    this.draw();
  }
  setContext(context: ComposerContext | null): void {
    this.context = context === null ? null : {
      ...context,
      model: terminalText(context.model),
      ...(context.reasoningEffort ? { reasoningEffort: terminalText(context.reasoningEffort) } : {}),
      ...(context.sessionTitle ? { sessionTitle: terminalText(context.sessionTitle) } : {}),
    };
    this.draw();
  }
  update(update: RenderUpdate): void {
    const previous = this.batch;
    this.batch = true;
    try {
      if (update.append.length) this.screen.append(update.append);
      this.tail = update.tail;
      if ("status" in update) this.status = update.status ?? null;
    } finally {
      this.batch = previous;
    }
    this.draw();
  }
  runInputActive(): boolean {
    return this.runInputEnabled();
  }
  begin(prompt: string, fresh: boolean): void {
    if (fresh) this.picker?.resolve(null);
    this.prompt = terminalText(prompt);
    this.fresh = fresh;
    this.dismissed = false;
    this.menu.close();
    if (fresh) {
      this.resumeNativeSelection();
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = undefined;
        this.screen.invalidate();
      }
      // Approval must be visible even if the user was selecting old output.
      this.screen.clearSelection();
      this.screen.scroll(-Number.MAX_SAFE_INTEGER);
      this.savedDraft = this.editor;
      this.editor = new Editor();
    }
    if (!this.screen.enabled) this.output.write(this.prompt);
    this.draw();
  }
  end(): void {
    if (this.savedDraft) {
      this.editor = this.savedDraft;
      this.savedDraft = undefined;
    }
    this.fresh = false;
    this.prompt = this.configured ? "❯ " : "";
    this.menu.close();
    this.draw();
  }
  resize(): void {
    this.screen.clearSelection();
    if (this.resizeTimer) return;
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.screen.invalidate();
      this.draw();
    }, 16);
    this.resizeTimer.unref();
  }
  handle(event: InputEvent): void {
    // Taint before dispatch: some keys (e.g. Shift+Tab) return early in keys.ts.
    if (this.picker?.spec.confirmation && (event.kind === "text" || event.kind === "key") && event.pasted) {
      this.picker.editor.tainted = true;
    }
    handle(this, event);
  }
  finish(steer = false): void {
    const text = this.editor.text;
    this.editor.remember();
    this.editor.clear();
    this.menu.close();
    this.dismissed = true;
    if (this.screen.enabled) this.screen.append([plain(this.prompt + text)]);
    this.submit(text, steer && this.runInputActive() && !text.startsWith("/"));
  }
  filtered() {
    const picker = this.picker;
    if (!picker) return [];
    const query = picker.editor.text.toLocaleLowerCase();
    return picker.spec.items.filter((item) =>
      `${item.label} ${item.detail ?? ""} ${item.value}`
        .toLocaleLowerCase()
        .includes(query),
    );
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
    if (signal.aborted || this.fresh) return null;
    this.start();
    this.picker?.resolve(null);
    return new Promise((resolve) => {
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
      this.picker = {
        spec,
        editor,
        index: Math.max(
          0,
          spec.items.findIndex((item) => item.value === spec.selected),
        ),
        resolve: finish,
      };
      signal.addEventListener("abort", abort, { once: true });
      this.draw();
    });
  }
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const card = approvalLines(request, this.columns);
    this.append(card.slice(0, -1));
    return this.approval("Approve? [Y/n] ", signal);
  }
  draw(): void {
    if (!this.batch && !this.resizeTimer) draw(this);
  }
  dispose(): void {
    this.picker?.resolve(null);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.resizeTimer = undefined;
    this.noticeTimer = undefined;
    this.modeToggle = undefined;
    if (this.timer) clearInterval(this.timer);
    if (this.probe) clearTimeout(this.probe);
    this.screen.clear();
    if (this.screen.enabled) {
      this.output.write("\x1b[?1002l\x1b[?1006l\x1b[?2004l\x1b[?2026l\x1b[?1049l\x1b[?25h");
      if (
        "setRawMode" in this.input &&
        typeof this.input.setRawMode === "function"
      )
        this.input.setRawMode(this.oldRaw);
    }
    this.screen.enabled = false;
  }
}
