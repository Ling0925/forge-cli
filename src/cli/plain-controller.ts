import type { ApprovalRequest, TaskPlan } from "../shared/schemas";
import { approvalLines, terminalText } from "./format";
import { clearEditor, editKey, emptyEditor, insertText, loadHistory, remember, setText, type InputEditor } from "./ink/input-editor";
import type { TerminalController, TerminalControllerOptions } from "./terminal-controller";
import type { InputEvent } from "./terminal/decoder";
import type { ComposerContext, PickerSpec, RenderUpdate, RichLine, RunStatus, UIOptions } from "./ui-contract";

/** Append-only output. The reader owns the decoder, stream, FIFO and EOF lifecycle. */
export class PlainController implements TerminalController {
  busy = false;
  batch = false;
  private editor: InputEditor = emptyEditor();
  private approvalEditor: InputEditor | undefined;
  private modeToggle: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: TerminalControllerOptions) {}

  get fresh(): boolean { return this.approvalEditor !== undefined; }
  get inputText(): string { return (this.approvalEditor ?? this.editor).text; }
  get columns(): number {
    const columns = (this.options.output as { columns?: number }).columns;
    return typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  }
  get rows(): number {
    const rows = (this.options.output as { rows?: number }).rows;
    return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
  }
  async configure(_options: UIOptions): Promise<void> { if (!this.disposed) this.options.start(); }
  append(lines: readonly RichLine[]): void {
    if (this.disposed) return;
    for (const line of lines) {
      // Never forward styling, control sequences, or spinner markers to this sink.
      this.options.output.write(`${line.map(span => terminalText(span.text)).join("")}\n`);
    }
  }
  setTail(_lines: readonly RichLine[]): void {
    // A replaceable tail cannot be painted without cursor movement. Its committed
    // content arrives through append/update when the renderer finalizes a frame.
  }
  setStatus(_status: RunStatus | null): void {}
  setBusy(busy: boolean): void { this.busy = busy; }
  setPlan(_plan: TaskPlan | null): void {}
  setMode(_mode: "build" | "plan"): void {}
  onModeToggle(callback: () => void): () => void {
    this.modeToggle = callback;
    return () => { if (this.modeToggle === callback) this.modeToggle = undefined; };
  }
  setContext(_context: ComposerContext | null): void {}
  setPendingInput(_lines: readonly string[]): void {}
  setInputHint(_hint: string | null): void {}
  update(update: RenderUpdate): void { this.append(update.append); }
  choose(_spec: PickerSpec, _signal: AbortSignal): Promise<string | null> {
    // Plain output has no interactive picker; never pick a confirmation implicitly.
    return Promise.resolve(null);
  }
  updatePicker(_spec: PickerSpec): void {}
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.disposed || signal.aborted) return Promise.resolve(false);
    this.append(approvalLines(request, this.columns).slice(0, -1));
    return this.options.approval("Approve? [Y/n] ", signal);
  }
  loadHistory(entries: readonly string[]): void {
    if (!this.fresh) this.editor = loadHistory(this.editor, entries);
  }
  clearInput(): void {
    if (this.approvalEditor) this.approvalEditor = clearEditor(this.approvalEditor);
    else this.editor = clearEditor(this.editor);
  }
  begin(prompt: string, fresh: boolean): void {
    if (this.disposed) return;
    if (fresh) this.approvalEditor = emptyEditor();
    // A normal run's TTY approval may never call configure: print every prompt.
    this.options.output.write(terminalText(prompt));
  }
  end(): void { this.approvalEditor = undefined; }
  draw(): void {}
  resize(): void {}

  handle(event: InputEvent): void {
    if (this.disposed || (event.kind !== "text" && event.kind !== "key")) return;
    let editor = this.approvalEditor ?? this.editor;
    const fresh = this.fresh;
    let effect: (() => void) | undefined;
    const submit = (text: string, steer = false): void => {
      effect = () => this.options.submit(text, steer && this.options.runInputActive() && !text.startsWith("/"));
    };
    const finish = (steer = false): void => {
      const text = editor.text;
      editor = clearEditor(remember(editor));
      submit(text, steer);
    };
    if (fresh && (event.pasted || (event.kind === "key" && ["up", "down"].includes(event.key))))
      editor = { ...editor, tainted: true };
    if (event.kind === "text") editor = insertText(editor, event.text, event.pasted);
    else if (event.key === "tab" && !this.options.tty) editor = insertText(editor, "\t", event.pasted);
    else if (event.pasted) {
      // Non-TTY input is line-oriented even when the decoder sees a paste marker.
      if (event.key === "enter" && !fresh) {
        if (this.options.tty) editor = insertText(editor, "\n", true);
        else finish();
      }
    } else if (event.key === "interrupt") {
      if (fresh) effect = () => { this.options.submit("no"); this.options.interrupt(); };
      else if (this.busy || !editor.text) effect = this.options.interrupt;
      else editor = clearEditor(editor);
    } else if (event.key === "escape" && fresh) {
      editor = clearEditor(editor);
      submit("no");
    } else if (event.key === "shift-tab") {
      if (!fresh) effect = () => this.modeToggle?.();
    } else if (["enter", "shift-enter", "alt-enter"].includes(event.key)) {
      if (fresh) {
        submit(editor.tainted || event.key !== "enter" ? "no" : editor.text);
        editor = clearEditor(editor);
      } else if (!this.busy || this.options.runInputActive() || editor.text.startsWith("/")) {
        if (editor.text.endsWith("\\")) editor = insertText(setText(editor, editor.text.slice(0, -1)), "\n", false);
        else finish(event.key !== "enter");
      }
    } else if (!fresh || !["up", "down"].includes(event.key)) editor = editKey(editor, event.key);
    if (fresh) this.approvalEditor = editor;
    else this.editor = editor;
    effect?.();
  }
  dispose(): void {
    this.disposed = true;
    this.modeToggle = undefined;
    this.approvalEditor = undefined;
  }
}
