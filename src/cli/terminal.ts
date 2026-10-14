import { ForgeError } from "../shared/errors";
import { terminalText } from "./format";
import { Controller } from "./terminal/controller";
import { InputDecoder, type InputEvent } from "./terminal/decoder";
import type { TerminalUI } from "./ui-contract";

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
  private readonly controller: Controller;
  private readonly decoder: InputDecoder;
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly queue: string[] = [];
  private bytes = 0;
  private waiter: Waiter | undefined;
  private error: ForgeError | undefined;
  private readonly notifyClose: (() => void) | undefined;
  private started = false;
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.controller.batch = true;
    this.decoder.feed(chunk);
    this.controller.batch = false;
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
    this.controller = new Controller(
      this.input,
      this.output,
      tty,
      () => this.start(),
      (text) => this.line(text),
      () =>
        options.onInterrupt ? options.onInterrupt() : process.emit("SIGINT"),
      (prompt, signal) => this.readApproval(prompt, signal),
    );
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
      choose: (spec, signal) =>
        this.closed ? Promise.resolve(null) : controller.choose(spec, signal),
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
        Buffer.byteLength(
          this.controller.picker?.editor.text ?? this.controller.editor.text,
        ) +
        this.bytes >
        this.maxBytes
    ) {
      this.overflow();
      return;
    }
    this.controller.handle(event);
    if (
      Buffer.byteLength(
        this.controller.picker?.editor.text ?? this.controller.editor.text,
      ) +
        this.bytes >
      this.maxBytes
    )
      this.overflow();
  }
  private line(raw: string): void {
    const line = terminalText(raw);
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
    if (this.controller.busy) return;
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
  private overflow(): void {
    this.queue.length = 0;
    this.bytes = 0;
    this.controller.editor.clear();
    this.controller.picker?.resolve(null);
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
      return ["y", "yes"].includes(
        (await this.question(prompt, signal, { fresh: true }))
          .trim()
          .toLowerCase(),
      );
    } catch {
      return false;
    }
  }
  private close(error: ForgeError, inputClosed = false): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
    this.controller.dispose();
    this.decoder.dispose();
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onError);
    this.output.off("resize", this.onResize);
    this.input.pause();
    // Cleanup and closed guard precede callbacks, so callback disposal is safe.
    if (inputClosed) this.notifyClose?.();
  }
  dispose(): void {
    this.close(new ForgeError("cancelled", "Input cancelled."));
  }
}
