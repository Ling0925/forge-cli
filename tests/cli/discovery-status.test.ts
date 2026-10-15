import { describe, expect, it } from "vitest";
import { runCliWithIO } from "../../src/cli/cli";
import type { CliIO } from "../../src/cli/cli";
import type { RunStatus, TerminalUI } from "../../src/cli/ui-contract";
import type { HarnessService } from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  parseSessionId,
  sessionSnapshotSchema,
  sessionSummarySchema,
} from "../../src/shared/schemas";
import type { SessionSummary } from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const snapshot = sessionSnapshotSchema.parse({
  version: 1,
  id,
  title: "chat",
  workspace: process.cwd(),
  model: "test",
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-01-02T03:04:05.000Z",
  status: "completed",
  messages: [],
  events: [],
  changes: [],
});

const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/**
 * Scripted prompt plus a status log. Observations happen inside the pending
 * service call, before the promise settles, so a status painted only after
 * discovery returns cannot pass.
 */
const hostFor = (lines: readonly string[]) => {
  const output: string[] = [];
  const statuses: (RunStatus | null)[] = [];
  const busy: boolean[] = [];
  const prompts: string[] = [];
  let index = 0;
  let interrupt = () => {};
  let close = () => {};
  let disposed = 0;
  const ui: TerminalUI = {
    columns: 80,
    rows: 24,
    configure: async () => {},
    append: (rows) =>
      output.push(
        rows.map((line) => line.map((span) => span.text).join("")).join("\n"),
      ),
    setTail: () => {},
    setStatus: (status) => statuses.push(status),
    setBusy: (value) => busy.push(value),
    choose: async () => null,
    approve: async () => false,
    dispose: () => {
      disposed++;
    },
  };
  const io: CliIO = {
    stdout: () => {},
    stderr: (text) => output.push(text),
    isTTY: true,
    readStdin: async () => {
      throw Error("implicit stdin");
    },
    question: async (prompt, signal) => {
      prompts.push(prompt);
      if (signal?.aborted || index >= lines.length) throw Error("EOF");
      const line = lines[index++];
      if (line === undefined) throw Error("EOF");
      return line;
    },
    onInterrupt: (callback) => {
      interrupt = callback;
      return () => {
        interrupt = () => {};
      };
    },
    onClose: (callback) => {
      close = callback;
      return () => {
        close = () => {};
      };
    },
    ui,
  };
  return {
    io,
    output,
    statuses,
    busy,
    prompts,
    interrupt: () => interrupt(),
    close: () => close(),
    disposed: () => disposed,
  };
};

const base = (
  run: HarnessService["run"] = async () => snapshot,
): HarnessService => ({
  ...extendedService(),
  getSettings: async () => ({ ...defaultPublicSettings, model: "test" }),
  updateSettings: async () => defaultPublicSettings,
  listModels: async () => ["test"],
  listSessions: async () => [],
  createSession: async () => snapshot,
  getSession: async () => snapshot,
  run,
  compactSession: async () => snapshot,
  cancelSession: async () => false,
  forkSession: async () => snapshot,
  renameSession: async () => snapshot,
  archiveSession: async () => snapshot,
  getDiagnostics: async () => ({
    transcriptChars: 0,
    projectedChars: 0,
    messageCount: 0,
    summaryFallback: false,
  }),
  dispose: async () => {},
});

const visible = (status: RunStatus | null | undefined): RunStatus => {
  expect(status).toEqual(
    expect.objectContaining({
      toolCount: 0,
      cancellable: true,
    }),
  );
  if (!status) throw Error("missing loading status");
  expect(Number.isFinite(status.startedAt)).toBe(true);
  expect(status.startedAt).toBeLessThanOrEqual(Date.now());
  return status;
};

describe("discovery loading status", () => {
  it("shows a cancellable model status while listModels is still pending, then clears it before the picker", async () => {
    const host = hostFor(["/model", "/quit"]);
    const pending = deferred<readonly string[]>();
    let seen: RunStatus | null | undefined;
    const ui = host.io.ui;
    if (!ui) throw Error("missing ui");
    const running = runCliWithIO(
      ["chat"],
      {
        ...base(),
        listModels: async (signal) => {
          seen = host.statuses.at(-1);
          expect(host.busy.at(-1)).toBe(true);
          expect(signal?.aborted).toBe(false);
          queueMicrotask(() => pending.resolve(["provider/exact"]));
          return pending.promise;
        },
      },
      {
        ...host.io,
        ui: {
          ...ui,
          choose: async (spec) => {
            expect(host.statuses.at(-1)).toBeNull();
            expect(spec.items.map((item) => item.value)).toEqual([
              "provider/exact",
            ]);
            return "provider/exact";
          },
        },
      },
    );
    expect(await running).toBe(0);
    const status = visible(seen);
    expect(status.label).toBe("Loading models");
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.busy.at(-1)).toBe(false);
    expect(host.prompts.at(-1)).toBe("❯ ");
    expect(host.output.join("\n")).toContain("Model: provider/exact");
  });

  it("keeps the draft model when discovery is cancelled and does not run the busy draft", async () => {
    const host = hostFor(["/model", "hello", "/quit"]);
    let model: string | undefined;
    let runs = 0;
    const code = await runCliWithIO(
      ["chat"],
      {
        ...base(async (input) => {
          runs++;
          model = input.model;
          expect(input.prompt).toBe("hello");
          return snapshot;
        }),
        listModels: async (signal) => {
          const status = visible(host.statuses.at(-1));
          expect(status.label).toBe("Loading models");
          expect(host.busy.at(-1)).toBe(true);
          host.interrupt();
          expect(signal?.aborted).toBe(true);
          return new Promise<readonly string[]>(() => {});
        },
      },
      host.io,
    );
    expect(await code).toBe(0);
    expect(model).toBe("test");
    expect(runs).toBe(1);
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.busy.at(-1)).toBe(false);
    expect(
      host.prompts.filter((prompt) => prompt === "❯ ").length,
    ).toBeGreaterThan(1);
  });

  it("clears the model status on catalog error and on an empty catalog", async () => {
    const host = hostFor(["/model", "/model", "hello", "/quit"]);
    const seen: string[] = [];
    let model: string | undefined;
    await runCliWithIO(
      ["chat"],
      {
        ...base(async (input) => {
          model = input.model;
          return snapshot;
        }),
        listModels: async () => {
          seen.push(visible(host.statuses.at(-1)).label);
          if (seen.length === 1) throw Error("catalog offline");
          return [];
        },
      },
      host.io,
    );
    expect(seen).toEqual(["Loading models", "Loading models"]);
    expect(model).toBe("test");
    expect(host.statuses.at(-1)).toBeNull();
    expect(
      host.statuses.filter((status) => status === null).length,
    ).toBeGreaterThanOrEqual(2);
    expect(host.output.join("\n")).toContain("No models available.");
    expect(host.output.join("\n")).toContain("internal:");
  });

  it("shows session discovery, then session load, and clears both before the next prompt", async () => {
    const resumed = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const host = hostFor(["/resume", "still here", "/quit"]);
    const sessions = deferred<readonly SessionSummary[]>();
    const loaded = deferred<typeof snapshot>();
    const labels: string[] = [];
    let prompt: string | undefined;
    const ui = host.io.ui;
    if (!ui) throw Error("missing ui");
    const running = runCliWithIO(
      ["chat"],
      {
        ...base(async (input) => {
          prompt = input.prompt;
          return snapshot;
        }),
        listSessions: async () => {
          labels.push(visible(host.statuses.at(-1)).label);
          expect(host.busy.at(-1)).toBe(true);
          return sessions.promise;
        },
        getSession: async (requested) => {
          if (requested === id) return snapshot;
          labels.push(visible(host.statuses.at(-1)).label);
          expect(requested).toBe(resumed);
          return loaded.promise;
        },
      },
      {
        ...host.io,
        ui: {
          ...ui,
          choose: async (spec) => {
            expect(host.statuses.at(-1)).toBeNull();
            expect(spec.items.map((item) => item.value)).toEqual([resumed]);
            return resumed;
          },
        },
      },
    );
    sessions.resolve([
      sessionSummarySchema.parse({
        version: 1,
        id: resumed,
        title: "Selected",
        workspace: snapshot.workspace,
        model: "resumed-model",
        status: "completed",
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      }),
    ]);
    await Promise.resolve();
    loaded.resolve({ ...snapshot, id: resumed, model: "resumed-model" });
    expect(await running).toBe(0);
    expect(labels).toEqual(["Loading sessions", "Loading session"]);
    expect(prompt).toBe("still here");
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.busy.at(-1)).toBe(false);
  });

  it("keeps an explicit session id unchanged while its load status is pending", async () => {
    const resumed = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const host = hostFor([`/resume ${resumed}`, "/quit"]);
    const loaded = deferred<typeof snapshot>();
    const started = deferred<void>();
    let requested: string | undefined;
    const running = runCliWithIO(
      ["chat"],
      {
        ...base(),
        getSession: async (value) => {
          if (value === id) return snapshot;
          requested = value;
          expect(visible(host.statuses.at(-1)).label).toBe("Loading session");
          started.resolve();
          return loaded.promise;
        },
      },
      host.io,
    );
    await started.promise;
    expect(requested).toBe(resumed);
    loaded.resolve({ ...snapshot, id: resumed, model: "kept-id" });
    expect(await running).toBe(0);
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.output.join("\n")).toContain("已恢复会话。");
  });

  it("clears compact status after cancellation and does not replace a later unrelated run status", async () => {
    const host = hostFor(["/compact", "hello", "/quit"]);
    const compacting = deferred<typeof snapshot>();
    const seenThinking: RunStatus[] = [];
    const ui = host.io.ui;
    if (!ui) throw Error("missing ui");
    const running = runCliWithIO(
      ["chat", "--session", id],
      {
        ...base(async (_input, sink) => {
          sink({
            type: "run_started",
            sessionId: id,
            timestamp: "2026-01-02T03:04:05.000Z",
            model: "test",
            permission: "workspace",
          });
          return snapshot;
        }),
        compactSession: async (_id, signal) => {
          expect(visible(host.statuses.at(-1)).label).toBe(
            "Compacting session",
          );
          host.interrupt();
          expect(signal?.aborted).toBe(true);
          return compacting.promise;
        },
      },
      {
        ...host.io,
        ui: {
          ...ui,
          setStatus: (status) => {
            host.statuses.push(status);
            if (status?.label === "thinking") seenThinking.push(status);
          },
        },
      },
    );
    expect(await running).toBe(0);
    compacting.reject(Error("should lose the race"));
    expect(host.statuses).toContain(null);
    const thinking = seenThinking.at(-1);
    if (!thinking) throw Error("missing thinking status");
    expect(thinking.label).toBe("thinking");
    expect(thinking.toolCount).toBe(0);
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.output.join("\n")).toContain(
      "cancelled: Compaction cancelled.",
    );
  });

  it("clears the loading status when discovery is aborted by EOF", async () => {
    const host = hostFor(["/model", "should-not-run"]);
    let runs = 0;
    let promptsAfterClose = 0;
    let sawClose = false;
    const running = runCliWithIO(
      ["chat"],
      {
        ...base(async () => {
          runs++;
          return snapshot;
        }),
        listModels: async (signal) => {
          expect(visible(host.statuses.at(-1)).label).toBe("Loading models");
          expect(host.busy.at(-1)).toBe(true);
          expect(signal?.aborted).toBe(false);
          const promptsAtClose = host.prompts.length;
          host.close();
          sawClose = true;
          expect(signal?.aborted).toBe(true);
          promptsAfterClose = host.prompts.length - promptsAtClose;
          return new Promise<readonly string[]>(() => {});
        },
      },
      host.io,
    );
    expect(await running).toBe(0);
    expect(sawClose).toBe(true);
    expect(runs).toBe(0);
    expect(promptsAfterClose).toBe(0);
    expect(host.prompts).toEqual(["❯ "]);
    expect(host.statuses.at(-1)).toBeNull();
    expect(host.busy.at(-1)).toBe(false);
    expect(host.disposed()).toBe(1);
    expect(host.output.join("\n")).not.toContain("No models available.");
    expect(host.output.join("\n")).not.toContain("should-not-run");
  });
});
