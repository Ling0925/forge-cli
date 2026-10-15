import type { InputEvent } from "./terminal/decoder";
import type { Editor } from "./terminal/editor";
import type { TerminalUI } from "./ui-contract";

/** Input lifecycle shared by the plain reader and the staged Ink migration. */
export interface TerminalController extends Required<TerminalUI> {
  editor: Editor;
  picker: { editor: Editor; resolve(value: string | null): void } | undefined;
  busy: boolean;
  batch: boolean;
  fresh: boolean;
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
