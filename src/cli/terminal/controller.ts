import type { ApprovalRequest } from "../../shared/schemas";
import { approvalLines, terminalText } from "../format";
import { SlashMenu } from "../slash-menu";
import { createTheme, resolveTheme } from "../theme";
import type {
  PickerSpec,
  RichLine,
  RunStatus,
  TerminalUI,
  UIOptions,
} from "../ui-contract";
import type { InputEvent } from "./decoder";
import { Editor } from "./editor";
import { handle } from "./keys";
import { Screen, plain } from "./screen";
import { type Picker, draw } from "./view";

export class Controller implements TerminalUI {
  editor = new Editor();
  readonly menu = new SlashMenu(8);
  readonly screen: Screen;
  busy = false;
  batch = false;
  prompt = "";
  fresh = false;
  tail: readonly RichLine[] = [];
  status: RunStatus | null = null;
  dismissed = false;
  navigated = false;
  private savedDraft: Editor | undefined;
  picker: Picker | undefined;
  private setting: UIOptions["theme"] = "system";
  background: "light" | "dark" | "unknown" = "unknown";
  probe: ReturnType<typeof setTimeout> | undefined;
  private oldRaw = false;
  private configured = false;
  private queried = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly tty: boolean,
    private readonly start: () => void,
    readonly submit: (text: string) => void,
    readonly interrupt: () => void,
    private readonly approval: (
      prompt: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
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
        this.output.write("\x1b[?2004h\x1b[?25h");
        this.timer = setInterval(() => {
          if (this.status) this.draw();
        }, 1000);
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
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.draw();
  }
  begin(prompt: string, fresh: boolean): void {
    this.prompt = terminalText(prompt);
    this.fresh = fresh;
    this.dismissed = false;
    this.menu.close();
    if (fresh) {
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
    this.screen.invalidate();
    this.draw();
  }
  handle(event: InputEvent): void {
    handle(this, event);
  }
  finish(): void {
    const text = this.editor.text;
    this.editor.remember();
    this.editor.clear();
    this.menu.close();
    this.dismissed = true;
    if (this.screen.enabled) this.screen.append([plain(this.prompt + text)]);
    this.submit(text);
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
  async choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null> {
    if (signal.aborted) return null;
    this.start();
    this.picker?.resolve(null);
    return new Promise((resolve) => {
      const abort = () => finish(null);
      const finish = (value: string | null) => {
        signal.removeEventListener("abort", abort);
        this.picker = undefined;
        this.draw();
        resolve(value);
      };
      this.picker = {
        spec,
        editor: new Editor(),
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
    return this.approval("Approve? [y/N] ", signal);
  }
  draw(): void {
    if (!this.batch) draw(this);
  }
  dispose(): void {
    this.picker?.resolve(null);
    if (this.timer) clearInterval(this.timer);
    if (this.probe) clearTimeout(this.probe);
    this.screen.clear();
    if (this.screen.enabled) {
      this.output.write("\x1b[?2004l\x1b[?25h");
      if (
        "setRawMode" in this.input &&
        typeof this.input.setRawMode === "function"
      )
        this.input.setRawMode(this.oldRaw);
    }
    this.screen.enabled = false;
  }
}
