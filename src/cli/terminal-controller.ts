import type { InputEvent } from "./terminal/decoder";
import type { TerminalUI } from "./ui-contract";

/** Reader accesses input operations, never a controller's mutable editing state. */
export interface TerminalController extends Required<TerminalUI> {
  readonly inputText: string;
  readonly busy: boolean;
  batch: boolean;
  readonly fresh: boolean;
  loadHistory(entries: readonly string[]): void;
  clearInput(): void;
  begin(prompt: string, fresh: boolean): void;
  end(): void;
  draw(): void;
  resize(): void;
  handle(event: InputEvent): void;
}

export interface TerminalControllerOptions {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly tty: boolean;
  readonly start: () => void;
  readonly submit: (text: string, steer?: boolean) => void;
  readonly interrupt: () => void;
  readonly approval: (prompt: string, signal: AbortSignal) => Promise<boolean>;
  readonly runInputActive: () => boolean;
}
