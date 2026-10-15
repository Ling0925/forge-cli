import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNodeIO } from "../../src/cli/cli";
import { runCliWithIO } from "../../src/cli/cli";
import type { CliIO } from "../../src/cli/cli";
import { sessionDetail } from "../../src/cli/interactive/pickers";
import type { ComposerContext, RunStatus } from "../../src/cli/ui-contract";
import type { HarnessService } from "../../src/shared/contracts";
import {
  defaultPublicSettings,
  parseSessionId,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const snapshot = sessionSnapshotSchema.parse({
  version: 1,
  id,
  title: "chat",
  workspace: process.cwd(),
  model: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "completed",
  messages: [],
  events: [],
  changes: [],
});
const service = (run: HarnessService["run"]): HarnessService => ({
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
const consoleIO = (lines: readonly string[], tty = true) => {
  const out: string[] = [];
  const err: string[] = [];
  let index = 0;
  let interrupt = () => {};
  const io: CliIO = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    isTTY: tty,
    readStdin: async () => {
      throw Error("implicit stdin");
    },
    question: async (_prompt, signal) => {
      if (signal.aborted || index >= lines.length) throw Error("EOF");
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
  };
  return { io, out, err, interrupt: () => interrupt() };
};
describe("interactive CLI", () => {
  it("streams turns, handles multiline and slash commands without leaking terminal controls", async () => {
    const prompts: string[] = [];
    const host = consoleIO([
      "/permission readonly",
      "hello\\",
      "world",
      "/sessions",
      "/quit",
    ]);
    const code = await runCliWithIO(
      ["chat", "--workspace", process.cwd()],
      service(async (input, sink) => {
        prompts.push(input.prompt);
        sink({
          type: "text_delta",
          sessionId: id,
          timestamp: new Date().toISOString(),
          text: "hi\u001b[31m!",
        });
        return snapshot;
      }),
      host.io,
    );
    expect(code).toBe(0);
    expect(prompts).toEqual(["hello\nworld"]);
    expect(host.out.join("")).toContain("hi!");
    expect(host.out.join("")).not.toContain("\u001b[2J");
    expect(host.out.join("")).not.toContain("Forge chat:");
  });
  it("validates and saves direct reasoning commands, and lists choices in plain mode", async () => {
    const host = consoleIO([
      "/reasoning",
      "/reasoning high",
      "/reasoning unknown",
      "/reasoning default",
      "/quit",
    ]);
    const updateSettings = vi.fn(async () => defaultPublicSettings);
    expect(
      await runCliWithIO(
        ["chat"],
        { ...service(async () => snapshot), updateSettings },
        host.io,
      ),
    ).toBe(0);
    expect(updateSettings.mock.calls).toEqual([
      [{ settings: { reasoningEffort: "high" } }],
      [{ settings: { reasoningEffort: "default" } }],
    ]);
    expect(host.out.join("")).toContain("Reasoning Effort");
    expect(host.err.join("")).not.toBe("");
  });
  it("does not open stdin on nonTTY and rejects explicit chat", async () => {
    const host = consoleIO([], false);
    expect(
      await runCliWithIO(
        [],
        service(async () => snapshot),
        host.io,
      ),
    ).toBe(0);
    expect(
      await runCliWithIO(
        ["chat"],
        service(async () => snapshot),
        host.io,
      ),
    ).toBe(1);
  });
  it("denies approvals on EOF", async () => {
    const host = consoleIO(["/approval manual", "test"]);
    let denied = false;
    const code = await runCliWithIO(
      ["chat"],
      service(async (_input, _sink, approve) => {
        denied = !(await approve(
          {
            id,
            sessionId: id,
            toolCallId: "x",
            toolName: "exec",
            description: "run",
            command: ["echo"],
          },
          new AbortController().signal,
        ));
        return snapshot;
      }),
      host.io,
    );
    expect(code).toBe(0);
    expect(denied).toBe(true);
  });
  it("cancels deferred compaction on interrupt, returns to prompt, then exits on idle interrupt", async () => {
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let captured: AbortSignal | undefined;
    let compactCalls = 0;
    const host = consoleIO(["/new", "/compact", "/sessions"]);
    const base = service(async () => snapshot);
    const run = runCliWithIO(
      ["chat"],
      {
        ...base,
        compactSession: async (_id, signal) => {
          compactCalls += 1;
          captured = signal;
          start();
          return new Promise(() => {});
        },
        listSessions: async () => {
          host.interrupt();
          return [];
        },
      },
      host.io,
    );
    await started;
    expect(captured?.aborted).toBe(false);
    host.interrupt();
    expect(await run).toBe(0);
    expect(captured?.aborted).toBe(true);
    expect(compactCalls).toBe(1);
    expect(host.out.join("")).toMatch(/No past sessions|暂无|没有/);
    // User cancellation must surface as cancellation, not an internal failure.
    const stderr = host.err.join("");
    expect(stderr).toContain("cancelled: Compaction cancelled.");
    expect(stderr).not.toContain("internal");
  });
  it("repeated interrupts settle pending compaction and exit", async () => {
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const host = consoleIO(["/new", "/compact"]);
    const base = service(async () => snapshot);
    const run = runCliWithIO(
      ["chat"],
      {
        ...base,
        compactSession: async () => {
          start();
          return new Promise(() => {});
        },
      },
      host.io,
    );
    await started;
    host.interrupt();
    host.interrupt();
    expect(await run).toBe(0);
  });
  it("passes plan mode and child approval provenance through chat", async () => {
    const host = consoleIO(["/mode plan", "hello", "/quit"]);
    const prompts: string[] = [];
    const io: CliIO = {
      ...host.io,
      question: async (prompt, signal) => {
        prompts.push(prompt);
        return host.io.question(prompt, signal);
      },
    };
    let mode: string | undefined;
    const code = await runCliWithIO(
      ["chat"],
      service(async (input, _sink, approve, signal) => {
        mode = input.mode;
        await approve(
          {
            id: "10000000-0000-4000-8000-000000000001",
            sessionId: id,
            childSessionId: parseSessionId(
              "10000000-0000-4000-8000-000000000002",
            ),
            toolCallId: "call",
            toolName: "exec",
            description: "Run child",
          },
          signal,
        );
        return snapshot;
      }),
      io,
    );
    expect(code).toBe(0);
    expect(mode).toBe("plan");
    expect(prompts.join("")).not.toContain("Approve?");
  });
  it("displays available models when /model is called without args", async () => {
    const host = consoleIO(["/model", "/quit"]);
    let listModelsCalled = false;
    const base = service(async () => snapshot);
    const code = await runCliWithIO(
      ["chat"],
      {
        ...base,
        listModels: async () => {
          listModelsCalled = true;
          return ["gpt-4o", "claude-3-5-sonnet"];
        },
      },
      host.io,
    );
    expect(code).toBe(0);
    expect(listModelsCalled).toBe(true);
    const out = host.out.join("");
    expect(out).toContain("Available Models");
    expect(out).toContain("gpt-4o");
  });
  it("displays categorized help on /help", async () => {
    const host = consoleIO(["/help", "/quit"]);
    const code = await runCliWithIO(
      ["chat"],
      service(async () => snapshot),
      host.io,
    );
    expect(code).toBe(0);
    const out = host.out.join("");
    expect(out).toContain("Forge 命令");
    expect(out).toContain("/model");
    expect(out).toContain("/permission");
  });
});

describe("rich integration adapters", () => {
  const richHost = (lines: string[], choices: (string | null)[]) => {
    const host = consoleIO(lines);
    const output: string[] = [];
    const busy: boolean[] = [];
    const statuses: (RunStatus | null)[] = [];
    const contexts: (ComposerContext | null)[] = [];
    const specs: import("../../src/cli/ui-contract").PickerSpec[] = [];
    const ui: import("../../src/cli/ui-contract").TerminalUI = {
      columns: 80,
      rows: 24,
      configure: async () => {},
      append: (lines) =>
        output.push(
          lines
            .map((line) => line.map((span) => span.text).join(""))
            .join("\n"),
        ),
      setTail: () => {},
      setStatus: (status) => statuses.push(status),
      setBusy: (value) => busy.push(value),
      setContext: (value) => contexts.push(value),
      choose: async (spec) => {
        specs.push(spec);
        return choices.shift() ?? null;
      },
      approve: async () => false,
      dispose: () => {},
    };
    return { ...host, io: { ...host.io, ui }, output, busy, statuses, specs, contexts };
  };
  it("refreshes context footer for runtime projection, model changes, session resets and compaction", async () => {
    const host = richHost(["hello", "/model changed", "/compact", "/new", "/quit"], []);
    const usage = { windowTokens: 1000, usedTokens: 200, estimated: true, basis: "projected" as const, parts: { instructions: 50, memory: 0, conversation: 100, tools: 50 } };
    const updated = { ...snapshot, messages: [{ role: "user" as const, content: "hello" }, { role: "assistant" as const, content: "answer" }] };
    const compacted = { ...updated, contextSummary: { content: "memory", boundary: 2, fallback: false, createdAt: new Date().toISOString() } };
    const base = service(async (_input, sink) => {
      sink({ type: "context_usage", sessionId: id, timestamp: new Date().toISOString(), usage });
      const count = host.contexts.length;
      sink({ type: "context_usage", sessionId: parseSessionId("10000000-0000-4000-8000-000000000002"), timestamp: new Date().toISOString(), usage: { ...usage, usedTokens: 999 } });
      expect(host.contexts.length).toBe(count);
      return updated;
    });
    expect(await runCliWithIO(["chat"], { ...base, compactSession: async () => compacted }, host.io)).toBe(0);
    expect(host.err).toEqual([]);
    expect(host.contexts[0]).toMatchObject({ model: "test", estimated: true });
    expect(host.contexts).toContainEqual({ model: "test", reasoningEffort: "default", usage: { ...usage, budgetTokens: 800 }, estimated: true });
    expect(host.contexts.some((value) => value?.model === "changed" && value.estimated)).toBe(true);
    expect(host.contexts.some((value) => (value?.usage?.parts.memory ?? 0) > 0)).toBe(true);
    expect(host.contexts.at(-1)).toMatchObject({ model: "changed", estimated: true, usage: { usedTokens: 0, windowTokens: null } });
  });

it("Shift+Tab callback shares /mode state without changing active-run approval scope", async () => {
  const host = richHost(["hello", "/quit"], []);
  let toggle: (() => void) | undefined;
  const modes: string[] = [];
  const ui = host.io.ui; if (!ui) throw Error("Missing UI fixture");
  const base = service(async (input, _sink, approve, signal) => {
    expect(input.mode).toBe("build");
    toggle?.();
    expect(await approve({id: "approval", sessionId: id, toolCallId: "call", toolName: "run_command", description: "test", command: ["node", "--version"]}, signal)).toBe(true);
    return snapshot;
  });
  await runCliWithIO(["chat", "--approval", "auto"], base, {...host.io, ui: {...ui, setMode: mode => modes.push(mode), onModeToggle: callback => {toggle = callback; return () => {toggle = undefined;};}}});
  expect(modes).toEqual(["build", "plan"]);
  expect(host.output.join("\n")).toContain("next run only; current run unchanged");
  expect(toggle).toBeUndefined();
});

  it("renders persisted messages on chat --session and /resume before the next prompt", async () => {
    const previous = { ...snapshot, title: "Earlier", messages: [
      { role: "system" as const, content: "private-system" },
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer", tool_calls: [{
        id: "tool-1", type: "function" as const,
        function: { name: "read_file", arguments: JSON.stringify({ path: "note.txt", offset: 2 }) },
      }] },
      { role: "tool" as const, tool_call_id: "tool-1", content: JSON.stringify({ content: "saved tool result" }) },
    ] };
    for (const [args, commands] of [
      [["chat", "--session", id], ["/tools 1", "/quit"]],
      [["chat"], [`/resume ${id}`, "/tools 1", "/quit"]],
      [["chat", "--session", id], ["/fork", "/tools 1", "/quit"]],
    ] as const) {
      const host = richHost([...commands], []);
      const code = await runCliWithIO([...args], {
        ...service(async () => snapshot), getSession: async () => previous,
        forkSession: async () => previous,
      }, host.io);
      expect(code).toBe(0);
      const rendered = host.output.join("\n");
      expect(rendered).toContain("earlier question");
      expect(rendered).toContain("earlier answer");
      expect(rendered).toContain("saved tool result");
      expect(rendered).not.toContain("details: /tools 1");
      expect(rendered).toContain("offset: 2");
      expect(rendered.indexOf("End of history")).toBeLessThan(rendered.indexOf("Tool #1"));
      expect(rendered).not.toContain("private-system");
      expect(rendered).not.toContain("· running");
    }
  });

  it("uses exact picked model and resumed session on the next run and routes output", async () => {
    const resumed = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const host = richHost(
      ["/resume", "/model", "hello", "/quit"],
      [resumed, "provider/exact"],
    );
    let received: unknown;
    const base = service(async (input) => {
      received = input;
      return snapshot;
    });
    const code = await runCliWithIO(
      ["chat"],
      {
        ...base,
        listModels: async () => ["provider/exact"],
        listSessions: async () => [
          { ...snapshot, id: resumed, title: "Selected" },
        ],
        getSession: async (id) => ({ ...snapshot, id, model: "resumed-model" }),
      },
      host.io,
    );
    expect(code).toBe(0);
    expect(received).toMatchObject({
      sessionId: resumed,
      model: "provider/exact",
      prompt: "hello",
    });
    expect(host.specs[0]?.items[0]).toMatchObject({
      value: resumed,
      label: "Selected",
    });
    expect(host.specs[0]?.items[0]?.detail).toBe(
      sessionDetail(snapshot.status, snapshot.workspace, snapshot.updatedAt),
    );
    expect(host.busy).toContain(true);
    expect(host.busy.at(-1)).toBe(false);
    expect(host.out).toEqual([]);
    expect(host.err).toEqual([]);
    expect(host.output.join("\n")).toContain("Forge");
  });
  it("offers reasoning after model selection and independently, preserving cancelled choices", async () => {
    const host = richHost(
      ["/model", "/reasoning", "/model manual/exact", "hello", "/quit"],
      ["provider/exact", "high", null, null],
    );
    let settings = {
      ...defaultPublicSettings,
      reasoningEffort: "low" as "low" | "high",
    };
    const updateSettings = vi.fn<HarnessService["updateSettings"]>(
      async (input) => {
        settings = { ...settings, ...input.settings } as typeof settings;
        return settings;
      },
    );
    let received: unknown;
    await runCliWithIO(
      ["chat"],
      {
        ...service(async (input) => {
          received = input;
          return snapshot;
        }),
        getSettings: async () => settings,
        updateSettings,
        listModels: async () => ["provider/exact"],
      },
      host.io,
    );
    expect(host.specs.map((spec) => spec.title)).toEqual([
      "Available Models",
      "Reasoning Effort",
      "Reasoning Effort",
      "Reasoning Effort",
    ]);
    expect(host.specs[1]?.selected).toBe("low");
    expect(host.specs[2]?.selected).toBe("high");
    expect(host.specs[1]?.items.map((item) => item.value)).toEqual([
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(updateSettings.mock.calls).toEqual([
      [{ settings: { reasoningEffort: "high" } }],
    ]);
    expect(received).toMatchObject({ model: "manual/exact", prompt: "hello" });
    expect(host.busy.at(-1)).toBe(false);
  });
  it("keeps selection on picker cancellation and does not substitute on catalog failure", async () => {
    const host = richHost(["/model", "/model", "hello", "/quit"], [null]);
    let calls = 0;
    let model: string | undefined;
    const base = service(async (input) => {
      model = input.model;
      return snapshot;
    });
    await runCliWithIO(
      ["chat"],
      {
        ...base,
        listModels: async () => {
          if (++calls === 2) throw Error("catalog offline");
          return ["another-model"];
        },
      },
      host.io,
    );
    expect(model).toBe("test");
    expect(host.specs).toHaveLength(1);
    expect(host.output.join("\n")).toContain("internal:");
  });
  it("passes structured child approval only through the callback and aborts active work", async () => {
    const host = richHost(["work", "/quit"], []);
    let decisions = 0;
    let aborted = false;
    const child = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const io: CliIO = {
      ...host.io,
      ui: {
        ...host.io.ui,
        approve: async (request, signal) => {
          decisions++;
          expect(request.childSessionId).toBe(child);
          expect(request.description).toContain("/actual/cwd");
          host.interrupt();
          expect(signal.aborted).toBe(true);
          return false;
        },
      },
    };
    const base = service(async (_input, _sink, approve, signal) => {
      expect(
        await approve(
          {
            id: "approval",
            sessionId: id,
            toolCallId: "call",
            toolName: "run_command",
            description: "cwd /actual/cwd",
            command: ["pwd"],
            childSessionId: child,
          },
          signal,
        ),
      ).toBe(false);
      aborted = signal.aborted;
      return snapshot;
    });
    expect(await runCliWithIO(["chat", "--approval", "manual"], base, io)).toBe(0);
    expect(decisions).toBe(1);
    expect(aborted).toBe(true);
    expect(host.busy.at(-1)).toBe(false);
  });
  it("cancels delayed catalog discovery and returns to a usable prompt without changing model", async () => {
    const host = richHost(["/model", "hello", "/quit"], []);
    let seen: AbortSignal | undefined;
    let model: string | undefined;
    let runs = 0;
    const base = service(async (input) => {
      runs++;
      model = input.model;
      return snapshot;
    });
    await runCliWithIO(
      ["chat"],
      {
        ...base,
        listModels: async (signal) => {
          seen = signal;
          expect(host.busy.at(-1)).toBe(true);
          queueMicrotask(() => host.interrupt());
          return new Promise(() => {});
        },
      },
      host.io,
    );
    expect(seen?.aborted).toBe(true);
    expect(model).toBe("test");
    expect(runs).toBe(1);
    expect(host.specs).toHaveLength(0);
    expect(host.busy.at(-1)).toBe(false);
  });

  for (const event of ["end", "error"] as const) {
    it(`aborts active work and pending approval on input ${event}`, async () => {
      const input = new PassThrough();
      const node = createNodeIO({
        stdin: input,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        isTTY: true,
      });
      const host = richHost(["work"], []);
      let runSignal: AbortSignal | undefined;
      let approvalSignal: AbortSignal | undefined;
      let disposed = false;
      const io: CliIO = {
        ...host.io,
        onClose: (callback) => node.onClose?.(callback) ?? (() => {}),
        ui: {
          ...host.io.ui,
          dispose: () => {
            disposed = true;
          },
          approve: async (_request, signal) => {
            approvalSignal = signal;
            queueMicrotask(() =>
              input.emit(
                event,
                ...(event === "error" ? [Error("input failed")] : []),
              ),
            );
            return new Promise<boolean>((resolve) =>
              signal.addEventListener("abort", () => resolve(false), {
                once: true,
              }),
            );
          },
        },
      };
      const base = service(async (_input, _sink, approve, signal) => {
        runSignal = signal;
        await approve(
          {
            id: "approval",
            sessionId: id,
            toolCallId: "call",
            toolName: "run_command",
            description: "actual cwd",
          },
          signal,
        );
        expect(signal.aborted).toBe(true);
        return snapshot;
      });
      expect(await runCliWithIO(["chat", "--approval", "manual"], base, io)).toBe(0);
      expect(runSignal?.aborted).toBe(true);
      expect(approvalSignal?.aborted).toBe(true);
      expect(disposed).toBe(true);
      expect(input.listenerCount("end")).toBe(0);
      expect(input.listenerCount("error")).toBe(0);
      node.dispose?.();
    });
  }
});

describe("raw terminal EOF integration", () => {
  function terminal() {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(value: boolean) {
        this.isRaw = value;
        return this;
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    output.on("data", () => {});
    return {
      input,
      output,
      io: createNodeIO({ stdin: input, stdout: output, stderr: output }),
    };
  }

  for (const phase of ["runtime", "approval", "discovery"] as const) {
    it(`raw Ctrl+D aborts ${phase} and restores terminal without stream EOF`, async () => {
      vi.stubEnv("TERM", "xterm-256color");
      const host = terminal();
      let ready: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let signalSeen: AbortSignal | undefined;
      let effects = 0;
      let closes = 0;
      const off = host.io.onClose?.(() => {
        closes++;
      });
      const base = service(async (_input, _sink, approve, signal) => {
        signalSeen = signal;
        if (phase === "approval") {
          const pending = approve(
            {
              id: "approval",
              sessionId: id,
              toolCallId: "call",
              toolName: "run_command",
              description: "cwd /actual",
            },
            signal,
          );
          ready();
          expect(await pending).toBe(false);
        } else {
          ready();
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        if (!signal.aborted) effects++;
        return snapshot;
      });
      const running = runCliWithIO(
        ["chat"],
        {
          ...base,
          listModels: async (signal) => {
            signalSeen = signal;
            ready();
            return new Promise<string[]>((resolve) =>
              signal?.addEventListener("abort", () => resolve([]), {
                once: true,
              }),
            );
          },
        },
        host.io,
      );
      try {
        await vi.waitFor(() => expect(host.input.isRaw).toBe(true));
        host.input.write(phase === "discovery" ? "/model\r" : "work\r");
        await started;
        host.input.write("\x04");
        expect(await running).toBe(0);
        expect(signalSeen?.aborted).toBe(true);
        expect(effects).toBe(0);
        expect(closes).toBe(1);
        expect(host.input.readableEnded).toBe(false);
        expect(host.input.isRaw).toBe(false);
        expect(host.input.listenerCount("data")).toBe(0);
        expect(host.input.listenerCount("end")).toBe(0);
        expect(host.input.listenerCount("error")).toBe(0);
        expect(host.output.listenerCount("resize")).toBe(0);
        host.io.dispose?.();
        expect(closes).toBe(1);
      } finally {
        off?.();
        host.io.dispose?.();
        vi.unstubAllEnvs();
      }
    });
  }

  it("EOF callback can dispose reentrantly and is delivered only once", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const host = terminal();
    let closes = 0;
    try {
      host.io.onClose?.(() => {
        closes++;
        host.io.dispose?.();
      });
      await host.io.ui?.configure({ theme: "dark" });
      host.input.write("\x04");
      host.input.emit("end");
      host.io.dispose?.();
      expect(closes).toBe(1);
      expect(host.input.isRaw).toBe(false);
      expect(host.input.listenerCount("data")).toBe(0);
      expect(host.input.listenerCount("end")).toBe(0);
    } finally {
      host.io.dispose?.();
      vi.unstubAllEnvs();
    }
  });

  it("ordinary disposal is not an input EOF notification", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const host = terminal();
    let closes = 0;
    try {
      host.io.onClose?.(() => {
        closes++;
        host.io.dispose?.();
      });
      await host.io.ui?.configure({ theme: "dark" });
      expect(host.input.isRaw).toBe(true);
      host.io.dispose?.();
      host.io.dispose?.();
      expect(closes).toBe(0);
      expect(host.input.isRaw).toBe(false);
      expect(host.input.listenerCount("data")).toBe(0);
      expect(host.input.listenerCount("end")).toBe(0);
    } finally {
      host.io.dispose?.();
      vi.unstubAllEnvs();
    }
  });
});

describe("lazy session lifecycle", () => {
  it.each([["/quit"], [], [" ", "/help", "/mode plan", "/permission readonly", "/sessions", "/context", "/fork", "/quit"]])("does not create for startup, EOF or commands: %j", async (...lines: string[]) => {
    const host = consoleIO(lines);
    const createSession = vi.fn(async () => snapshot);
    await runCliWithIO(["chat"], { ...service(async () => snapshot), createSession }, host.io);
    expect(createSession).not.toHaveBeenCalled();
  });
  it("creates only at the first real prompt and preserves selected model", async () => {
    const host = consoleIO(["/model chosen", "first message", "second", "/quit"]);
    const createSession = vi.fn(async () => ({...snapshot, model: "chosen"}));
    const run = vi.fn(async () => snapshot);
    await runCliWithIO(["chat"], {...service(run), createSession}, host.io);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({workspace: process.cwd(), model: "chosen"});
    expect(run.mock.calls).toHaveLength(2);
  });
  it("keeps explicit /new immediate", async () => {
    const host = consoleIO(["/new", "/quit"]);
    const createSession = vi.fn(async () => snapshot);
    await runCliWithIO(["chat"], {...service(async () => snapshot), createSession}, host.io);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
