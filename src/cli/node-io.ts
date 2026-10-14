import { ForgeError } from "../shared/errors";
import type { CliIO } from "./cli";
import { TerminalReader } from "./terminal";

const readStdin = (
  limit: number,
  signal: AbortSignal,
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> =>
  new Promise((resolveInput, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (typeof (stream as { pause?: () => void }).pause === "function") {
        (stream as { pause: () => void }).pause();
      }
    };
    const fail = (error: ForgeError): void => {
      cleanup();
      reject(error);
    };
    const onAbort = (): void =>
      fail(new ForgeError("cancelled", "Input cancelled."));
    const onError = (): void =>
      fail(new ForgeError("invalid_input", "Unable to read stdin."));
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        fail(
          new ForgeError("invalid_input", "Stdin exceeds the allowed size."),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      try {
        resolveInput(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        reject(new ForgeError("invalid_input", "Stdin must be valid UTF-8."));
      }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    if ((stream as { readableEnded?: boolean }).readableEnded) {
      resolveInput("");
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    if (typeof (stream as { resume?: () => void }).resume === "function") {
      (stream as { resume: () => void }).resume();
    }
  });

export interface CreateNodeIOOptions {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly isTTY?: boolean;
}

export const createNodeIO = (options: CreateNodeIOOptions = {}): CliIO => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const isTTY =
    options.isTTY ??
    Boolean(
      "isTTY" in stdin &&
        stdin.isTTY &&
        "isTTY" in stdout &&
        stdout.isTTY &&
        "isTTY" in stderr &&
        stderr.isTTY,
    );

  let interruptListeners: (() => void)[] = [];
  const onSigInt = (): void => {
    for (const listener of interruptListeners) {
      listener();
    }
  };

  const closeSubscriptions = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  let inputClosed = false;
  const notifyClose = (): void => {
    inputClosed = true;
    for (const close of [...closeListeners]) close();
  };
  const rich =
    options.isTTY !== false &&
    Boolean(
      "isTTY" in stdin &&
        stdin.isTTY &&
        "isTTY" in stdout &&
        stdout.isTTY &&
        "isTTY" in stderr &&
        stderr.isTTY &&
        process.env.TERM !== "dumb",
    );
  let reader: TerminalReader | undefined;
  const getReader = (): TerminalReader => {
    reader ??= new TerminalReader({
      input: stdin,
      output: stderr,
      isTTY: rich,
      onInterrupt: onSigInt,
      onClose: notifyClose,
    });
    return reader;
  };

  return {
    get ui() {
      return rich ? getReader().ui : undefined;
    },
    stdout: (text) => {
      (stdout as { write: (text: string) => void }).write(text);
    },
    stderr: (text) => {
      (stderr as { write: (text: string) => void }).write(text);
    },
    isTTY,
    readStdin: (limit, signal) => readStdin(limit, signal, stdin),
    question: (text, signal, qOptions) =>
      getReader().question(text, signal, qOptions),
    readApproval: (text, signal) => getReader().readApproval(text, signal),
    onClose: (callback) => {
      let notified = false;
      const close = (): void => {
        if (!notified) {
          notified = true;
          callback();
        }
      };
      const unsubscribe = (): void => {
        stdin.off("end", close);
        stdin.off("error", close);
        closeSubscriptions.delete(unsubscribe);
        closeListeners.delete(close);
      };
      closeListeners.add(close);
      stdin.on("end", close);
      stdin.on("error", close);
      closeSubscriptions.add(unsubscribe);
      if (
        inputClosed ||
        (stdin as { readableEnded?: boolean; destroyed?: boolean })
          .readableEnded ||
        (stdin as { destroyed?: boolean }).destroyed
      )
        close();
      return unsubscribe;
    },
    onInterrupt: (callback) => {
      interruptListeners.push(callback);
      const onProcessSigInt = (): void => {
        callback();
      };
      process.on("SIGINT", onProcessSigInt);
      return () => {
        interruptListeners = interruptListeners.filter((cb) => cb !== callback);
        process.off("SIGINT", onProcessSigInt);
      };
    },
    dispose: () => {
      for (const unsubscribe of closeSubscriptions) unsubscribe();
      reader?.dispose();
      interruptListeners = [];
    },
  };
};

export const nodeIO: CliIO = createNodeIO();
