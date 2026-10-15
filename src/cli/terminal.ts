import { ForgeError } from "../shared/errors";
import { parseApprovalAnswer } from "./approval-policy";
import { terminalText } from "./format";
import { PlainController } from "./plain-controller";
import { InkController } from "./ink/controller";
import { InputDecoder, type InputEvent } from "./terminal/decoder";
import type { TerminalUI } from "./ui-contract";
import type { TerminalController, TerminalControllerOptions } from "./terminal-controller";

export const DEFAULT_MAX_QUEUE_LINES = 1_000;
export const DEFAULT_MAX_QUEUE_BYTES = 1_000_000;
export interface QuestionOptions {
  readonly fresh?: boolean;
}
export interface TerminalReaderOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
  readonly maxLines?: number;
  readonly maxBytes?: number;
  readonly onInterrupt?: () => void;
  /** Actual input EOF/error (including raw Ctrl+D), never ordinary disposal. */
  readonly onClose?: () => void;
  readonly createController?: (options: TerminalControllerOptions) => TerminalController;
}
interface Waiter {
  resolve(line: string): void;
  reject(error: unknown): void;
}

/** One input protocol owner and one screen owner for the complete CLI lifecycle. */
export class TerminalReader {
  readonly ui: TerminalUI;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly controller: TerminalController;
  private readonly decoder: InputDecoder;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly queue: string[] = [];
  private bytes = 0;
  private waiter: Waiter | undefined;
  private runInput: ((line: string, steer?: boolean) => void) | undefined;
  private error: ForgeError | undefined;
  private readonly notifyClose: (() => void) | undefined;
  private started = false;
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.controller.batch = true;
    try { this.decoder.feed(chunk); }
    finally { this.controller.batch = false; }
    this.controller.draw();
  };
  private readonly onEnd = (): void =>
    this.close(new ForgeError("invalid_input", "Input closed (EOF)."), true);
  private readonly onError = (): void =>
    this.close(new ForgeError("invalid_input", "Input stream failed."), true);
  private readonly onResize = (): void => this.controller.resize();
  constructor(options: TerminalReaderOptions = {}) {
    this.notifyClose = options.onClose;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_QUEUE_LINES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_QUEUE_BYTES);
    const tty =
      options.isTTY ??
      Boolean(
        "isTTY" in this.input &&
          this.input.isTTY &&
          "isTTY" in this.output &&
          this.output.isTTY,
      );
    const controls: TerminalControllerOptions = {
      input: this.input, output: this.output, tty,
      start: () => this.start(),
      submit: (text, steer) => this.line(text, steer),
      interrupt: () => { options.onInterrupt ? options.onInterrupt() : process.emit("SIGINT"); },
      approval: (prompt, signal) => this.readApproval(prompt, signal),
      runInputActive: () => this.runInput !== undefined,
    };
    this.controller = options.createController?.(controls) ?? (tty && process.env.TERM !== "dumb"
      ? new InkController(controls) : new PlainController(controls));
    const controller = this.controller;
    this.ui = {
      get columns() {
        return controller.columns;
      },
      get rows() {
        return controller.rows;
      },
      configure: (options) =>
        this.closed ? Promise.resolve() : controller.configure(options),
      append: (lines) => {
        if (!this.closed) controller.append(lines);
      },
      setTail: (lines) => {
        if (!this.closed) controller.setTail(lines);
      },
      setStatus: (status) => {
        if (!this.closed) controller.setStatus(status);
      },
      setBusy: (busy) => {
        if (!this.closed) controller.setBusy(busy);
      },
      setMode: (mode) => {
        if (!this.closed) controller.setMode(mode);
      },
      onModeToggle: (callback) =>
        this.closed ? () => {} : controller.onModeToggle(callback),
      setPlan: (plan) => {
        if (!this.closed) controller.setPlan(plan);
      },
      setContext: (context) => {
        if (!this.closed) controller.setContext(context);
      },
      setPendingInput: (lines) => {
        if (!this.closed) controller.setPendingInput(lines);
      },
      setInputHint: (hint) => {
        if (!this.closed) controller.setInputHint(hint);
      },
      update: (update) => {
        if (!this.closed) controller.update(update);
      },
      choose: (spec, signal) =>
        this.closed ? Promise.resolve(null) : controller.choose(spec, signal),
      updatePicker: (spec) => {
        if (!this.closed) controller.updatePicker(spec);
      },
      approve: (request, signal) =>
        this.closed
          ? Promise.resolve(false)
          : controller.approve(request, signal),
      dispose: () => this.dispose(),
    };
    this.decoder = new InputDecoder((event) => this.event(event));
  }
  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("error", this.onError);
    this.output.on("resize", this.onResize);
    this.input.resume();
  }
  private event(event: InputEvent): void {
    if (this.closed) return;
    if (event.kind === "key" && event.key === "eof" && !event.pasted) {
      this.onEnd();
      return;
    }
    if (
      event.kind === "text" &&
      Buffer.byteLength(event.text) +
        Buffer.byteLength(this.controller.inputText) +
        this.bytes >
        this.maxBytes
    ) {
      this.overflow();
      return;
    }
    this.controller.handle(event);
    if (Buffer.byteLength(this.controller.inputText) + this.bytes > this.maxBytes)
      this.overflow();
  }
  private historyListener: ((text: string) => void) | undefined;
  setHistory(entries: readonly string[], listener?: (text: string) => void): void {
    if (this.closed || this.controller.fresh) return;
    this.controller.loadHistory(entries);
    this.historyListener = listener;
  }
  private line(raw: string, steer = false): void {
    const line = terminalText(raw);
    if (!this.controller.fresh) this.historyListener?.(line);
    if (Buffer.byteLength(line) > this.maxBytes) {
      this.overflow();
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(line);
      return;
    }
    if (this.runInput) {
      this.runInput(line, steer);
      return;
    }
    // Retain commands entered during a non-run operation for the next prompt;
    // ordinary drafts still stay in the editor.
    if (this.controller.busy && !line.startsWith("/")) return;
    if (
      this.queue.length >= this.maxLines ||
      this.bytes + Buffer.byteLength(line) > this.maxBytes
    ) {
      this.overflow();
      return;
    }
    this.queue.push(line);
    this.bytes += Buffer.byteLength(line);
  }
  onRunInput(callback: (line: string, steer?: boolean) => void): () => void {
    if (this.runInput || this.waiter)
      throw new ForgeError("invalid_input", "Run input already has an owner.");
    if (this.closed) return () => undefined;
    this.runInput = callback;
    // Transfer previously submitted typeahead before accepting new stream data.
    while (this.queue.length && this.runInput === callback) {
      const line = this.queue.shift() ?? "";
      this.bytes -= Buffer.byteLength(line);
      callback(line);
    }
    this.start();
    return () => {
      if (this.runInput === callback) this.runInput = undefined;
    };
  }
  private overflow(): void {
    this.queue.length = 0;
    this.bytes = 0;
    this.controller.clearInput();
    const error = new ForgeError(
      "invalid_input",
      "Buffered input exceeds the allowed size.",
    );
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.reject(error);
    } else this.error = error;
    this.controller.draw();
  }
  async question(
    prompt: string,
    signal: AbortSignal,
    options?: QuestionOptions,
  ): Promise<string> {
    if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
    this.start();
    if (options?.fresh) {
      this.queue.length = 0;
      this.bytes = 0;
    }
    if (this.error) {
      const error = this.error;
      this.error = undefined;
      throw error;
    }
    if (!options?.fresh && this.queue.length) {
      const line = this.queue.shift() ?? "";
      this.bytes -= Buffer.byteLength(line);
      return line;
    }
    if (this.closed)
      throw new ForgeError("invalid_input", "Input closed (EOF).");
    this.waiter?.reject(new ForgeError("cancelled", "Input superseded."));
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        if (this.waiter === waiter) this.waiter = undefined;
        waiter.reject(new ForgeError("cancelled", "Input cancelled."));
        this.controller.draw();
      };
      const finish = (): void => {
        signal.removeEventListener("abort", abort);
        this.controller.end();
      };
      const waiter: Waiter = {
        resolve: (line) => {
          finish();
          resolve(line);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      };
      this.waiter = waiter;
      signal.addEventListener("abort", abort, { once: true });
      this.controller.begin(prompt, Boolean(options?.fresh));
    });
  }
  async readApproval(prompt: string, signal: AbortSignal): Promise<boolean> {
    try {
      const answer = await this.question(prompt, signal, { fresh: true });
      return !signal.aborted && !this.closed && parseApprovalAnswer(answer);
    } catch {
      return false;
    }
  }
  private close(error: ForgeError, inputClosed = false): void {
    if (this.closed) return;
    this.closed = true;
    this.runInput = undefined;
    const waiter = this.waiter;
    this.waiter = undefined;
    try {
      waiter?.reject(error);
      this.controller.dispose();
    } finally {
      this.decoder.dispose();
      this.input.off("data", this.onData);
      this.input.off("end", this.onEnd);
      this.input.off("error", this.onError);
      this.output.off("resize", this.onResize);
      this.input.pause();
      if (inputClosed) this.notifyClose?.();
    }
  }
  dispose(): void {
    this.close(new ForgeError("cancelled", "Input cancelled."));
  }
}
