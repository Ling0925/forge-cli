/**
 * Legacy terminal test fixture.
 *
 * The hand-written screen controller (`./controller`) is no longer used by
 * production; it is kept here so legacy behaviour stays covered by tests.
 * `LegacyTerminalReader` reuses the production `TerminalReader` lifecycle
 * (decoder, stream, FIFO, EOF, approval) and only injects the legacy controller
 * factory through the standard `createController` seam.
 */
import {
  DEFAULT_MAX_QUEUE_BYTES,
  DEFAULT_MAX_QUEUE_LINES,
  TerminalReader,
} from "../../../src/cli/terminal";
import type {
  QuestionOptions,
  TerminalReaderOptions,
} from "../../../src/cli/terminal";
import type { TerminalControllerOptions } from "../../../src/cli/terminal-controller";
import { Controller as LegacyController } from "./controller";

export { DEFAULT_MAX_QUEUE_BYTES, DEFAULT_MAX_QUEUE_LINES };
export { LegacyTerminalReader as TerminalReader };
export type { QuestionOptions, TerminalReaderOptions };

/** Production reader bound to the legacy hand-written screen controller. */
export class LegacyTerminalReader extends TerminalReader {
  constructor(options: TerminalReaderOptions & { inline?: boolean } = {}) {
    super({
      ...options,
      createController:
        options.createController ??
        ((controls: TerminalControllerOptions) =>
          new LegacyController(
            controls.input,
            controls.output,
            controls.tty,
            controls.start,
            controls.submit,
            controls.interrupt,
            controls.approval,
            controls.runInputActive,
            options.inline ?? false,
          )),
    });
  }
}
