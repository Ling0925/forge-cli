import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runCliWithIO } from "../../src/cli/cli";
import type { CliIO } from "../../src/cli/cli";
import { mcpRegisterInputSchema } from "../../src/mcp/types";
import type { HarnessService } from "../../src/shared/contracts";
import { ForgeError } from "../../src/shared/errors";
import {
  defaultPublicSettings,
  parseSessionId,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type {
  ConfigureInput,
  RunInput,
  SessionStatus,
} from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const timestamp = "2026-01-01T00:00:00.000Z";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "forge-cli-test-"));
  directories.push(path);
  return path;
};
const fixture = (
  workspace: string,
  status: SessionStatus = "completed",
  stdin = "",
) => {
  const output: string[] = [];
  const diagnostics: string[] = [];
  const updates: ConfigureInput[] = [];
  const runs: RunInput[] = [];
  const approvals: boolean[] = [];
  let creates = 0;
  let reads = 0;
  let calls = 0;
  let interrupt: () => void = () => {};
  const snapshot = sessionSnapshotSchema.parse({
    version: 1,
    id,
    title: "Test",
    workspace,
    model: "test-model",
    createdAt: timestamp,
    updatedAt: timestamp,
    status,
    messages: [],
    events: [],
    changes: [],
  });
  const service: HarnessService = {
    ...extendedService(),
    getSettings: async () => {
      calls += 1;
      return defaultPublicSettings;
    },
    updateSettings: async (input) => {
      updates.push(input);
      return defaultPublicSettings;
    },
    listModels: async () => {
      calls += 1;
      return ["test-model"];
    },
    listSessions: async () => {
      calls += 1;
      return [];
    },
    createSession: async () => {
      creates += 1;
      return snapshot;
    },
    getSession: async () => snapshot,
    run: async (input, sink, approve, signal) => {
      runs.push(input);
      sink({
        type: "run_started",
        sessionId: id,
        timestamp,
        model: "test-model",
        permission: input.permission ?? "readonly",
      });
      approvals.push(
        await approve(
          {
            id,
            sessionId: id,
            toolCallId: "call",
            toolName: "exec",
            description: "Execute in workspace",
            command: ["program", "argument with spaces"],
          },
          signal,
        ),
      );
      sink({ type: "text_delta", sessionId: id, timestamp, text: "Hello" });
      sink({
        type: "run_finished",
        sessionId: id,
        timestamp,
        status:
          status === "cancelled"
            ? "cancelled"
            : status === "failed"
              ? "failed"
              : "completed",
        turns: 1,
        toolCalls: 1,
      });
      return snapshot;
    },
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
  };
  const io: CliIO = {
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      diagnostics.push(text);
    },
    isTTY: false,
    readStdin: async () => {
      reads += 1;
      return stdin;
    },
    question: async () => {
      throw new Error("Unexpected interactive approval");
    },
    onInterrupt: (callback) => {
      interrupt = callback;
      return () => {
        interrupt = () => {};
      };
    },
  };
  return {
    service,
    io,
    output,
    diagnostics,
    updates,
    runs,
    approvals,
    snapshot,
    creates: () => creates,
    reads: () => reads,
    calls: () => calls,
    interrupt: () => interrupt(),
  };
};

describe("Forge CLI", () => {
  it("configures explicit local LSP servers without starting or installing them", async () => {
    const f = fixture("/unused");
    const servers = [{ id: "typescript", command: "typescript-language-server", args: ["--stdio"], extensions: [".ts", ".tsx"] }];
    expect(await runCliWithIO(["config", "set", "--lsp-servers", JSON.stringify(servers)], f.service, f.io)).toBe(0);
    expect(f.updates.at(-1)?.settings?.lspServers).toEqual(servers);
    expect(await runCliWithIO(["config", "set", "--lsp-servers", "[]"], f.service, f.io)).toBe(0);
    expect(f.updates.at(-1)?.settings?.lspServers).toEqual([]);
    const count = f.updates.length;
    for (const value of ["not-json", "{}", JSON.stringify([...servers, ...servers]), JSON.stringify([{ ...servers[0], extensions: ["ts"] }])]) {
      expect(await runCliWithIO(["config", "set", "--lsp-servers", value], f.service, f.io)).toBe(1);
    }
    expect(f.updates).toHaveLength(count);
    expect(f.runs).toHaveLength(0);
    expect(f.reads()).toBe(0);
  });

  it("help does not touch the service or stdin", async () => {
    const f = fixture("/unused");
    expect(await runCliWithIO(["--help"], f.service, f.io)).toBe(0);
    expect(f.calls()).toBe(0);
    expect(f.reads()).toBe(0);
  });

  it.each([
    ["resume", id],
    ["chat", "--session", id],
  ])("%j opens saved history and continues multiple turns without creating a session", async (...argv) => {
    const f = fixture(await directory());
    const snapshot = { ...f.snapshot, messages: [{ role: "assistant" as const, content: "Saved history marker" }] };
    f.service.getSession = async requested => {
      expect(requested).toBe(id);
      return snapshot;
    };
    const lines = ["first follow-up", "second follow-up", "/quit"];
    let questions = 0;
    const code = await runCliWithIO(argv, f.service, {
      ...f.io, isTTY: true,
      question: async () => {
        if (questions++ === 0) {
          expect(f.output.join("")).toContain("Saved history marker");
          expect(f.output.join("")).toContain(snapshot.workspace);
          expect(f.runs).toHaveLength(0);
        }
        return lines.shift() ?? "/quit";
      },
    });
    expect(code).toBe(0);
    expect(f.creates()).toBe(0);
    expect(f.reads()).toBe(0);
    expect(f.runs.map(run => [run.sessionId, run.model, run.prompt])).toEqual([
      [id, snapshot.model, "first follow-up"], [id, snapshot.model, "second follow-up"],
    ]);
    expect(f.diagnostics).toEqual([]);
  });

  it("resume accepts chat approval/thinking flags and opening alone never executes", async () => {
    const f = fixture(await directory());
    expect(await runCliWithIO(["resume", id, "--approval", "manual", "--thinking"], f.service, {
      ...f.io, isTTY: true, question: async () => "/quit",
    })).toBe(0);
    expect(f.output.join("")).toContain("MANUAL:");
    expect(f.runs).toHaveLength(0);
    expect(f.creates()).toBe(0);
    expect(f.reads()).toBe(0);
  });

  it.each([
    ["resume"], ["resume", "not-a-uuid"], ["resume", id, "old one-shot prompt"],
    ["resume", id, "--json"], ["resume", id, "--prompt-stdin"],
    ["resume", id, "--prompt-file", "task.txt"], ["resume", id, "--session", id],
    ["resume", id, "--workspace", "/tmp"], ["resume", id, "--permission", "unrestricted", "--yes"],
  ])("rejects invalid/old resume syntax %j without executing or reading stdin", async (...argv) => {
    const f = fixture("/unused");
    expect(await runCliWithIO(argv, f.service, { ...f.io, isTTY: true })).toBe(1);
    expect(f.calls()).toBe(0);
    expect(f.creates()).toBe(0);
    expect(f.runs).toHaveLength(0);
    expect(f.reads()).toBe(0);
  });

  it("rejects non-TTY resume with migration guidance and no implicit stdin", async () => {
    const f = fixture("/unused");
    expect(await runCliWithIO(["resume", id], f.service, f.io)).toBe(1);
    expect(f.diagnostics.join("")).toContain("forge run --session UUID");
    expect(f.calls()).toBe(0);
    expect(f.reads()).toBe(0);
    expect(f.runs).toHaveLength(0);
  });

  it("reports a missing session instead of silently creating one", async () => {
    const f = fixture("/unused");
    f.service.getSession = async () => { throw new ForgeError("not_found", "Session not found."); };
    expect(await runCliWithIO(["resume", id], f.service, { ...f.io, isTTY: true })).toBe(1);
    expect(f.diagnostics.join("")).toContain("not_found");
    expect(f.creates()).toBe(0);
    expect(f.runs).toHaveLength(0);
  });

  it("resume help describes interactive recovery without touching the service", async () => {
    const f = fixture("/unused");
    expect(await runCliWithIO(["resume", "--help"], f.service, f.io)).toBe(0);
    expect(f.output.join("")).toContain("forge resume UUID [--approval");
    expect(f.output.join("")).not.toContain("forge resume <id> [prompt...]");
    expect(f.calls()).toBe(0);
    expect(f.reads()).toBe(0);
  });

  it("configures token windows per model, preserves others and supports auto", async () => {
    const f = fixture("/unused");
    f.service.getSettings = async () => ({ ...defaultPublicSettings, model: "current", modelContextWindows: { other: 32000 } });
    expect(await runCliWithIO(["config", "set", "--context-tokens", "128000"], f.service, f.io)).toBe(0);
    expect(f.updates.at(-1)?.settings?.modelContextWindows).toEqual({ other: 32000, current: 128000 });
    expect(await runCliWithIO(["config", "set", "--model", "alias", "--context-tokens", "auto"], f.service, f.io)).toBe(0);
    expect(f.updates.at(-1)?.settings?.modelContextWindows).toEqual({ other: 32000, alias: null });
    const count = f.updates.length;
    for (const invalid of ["-1", "0", "1.5", "foo", "10000001"]) {
      expect(await runCliWithIO(["config", "set", "--context-tokens", invalid], f.service, f.io)).toBe(1);
    }
    expect(f.updates).toHaveLength(count);
  });

  it("forwards reasoning effort and rejects invalid values before updating", async () => {
    const f = fixture("/unused");
    for (const effort of [
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      expect(
        await runCliWithIO(
          ["config", "set", "--reasoning-effort", effort],
          f.service,
          f.io,
        ),
      ).toBe(0);
      expect(f.updates.at(-1)).toEqual({
        settings: { reasoningEffort: effort },
      });
    }
    expect(
      await runCliWithIO(
        ["config", "set", "--reasoning-effort", "unknown"],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(f.updates).toHaveLength(8);
  });

  it("forwards valid API mode and rejects invalid mode before updating settings", async () => {
    const f = fixture("/unused");
    expect(
      await runCliWithIO(
        ["config", "set", "--api-mode", "responses"],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.updates[0]).toEqual({ settings: { apiMode: "responses" } });
    expect(
      await runCliWithIO(
        ["config", "set", "--api-mode", "unknown"],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(f.updates).toHaveLength(1);
  });

  it("configures Anthropic and validates the output token limit", async () => {
    const f = fixture("/unused");
    expect(await runCliWithIO(["config", "set", "--api-mode", "anthropic", "--max-output-tokens", "4096"], f.service, f.io)).toBe(0);
    expect(f.updates).toEqual([{ settings: { apiMode: "anthropic", maxOutputTokens: 4096 } }]);
    expect(await runCliWithIO(["config", "set", "--max-output-tokens", "0"], f.service, f.io)).toBe(1);
    expect(f.updates).toHaveLength(1);
  });

  it("dispatches context, skills, MCP and checkpoint actions to the shared service", async () => {
    const f = fixture("/unused");
    const calls: string[] = [];
    const catalog = {
      workspace: "/tmp",
      instructionSources: [],
      skills: [
        {
          id: "one",
          name: "One",
          description: "Skill",
          version: null,
          sourceDirectory: "/tmp/one",
          provenance: "user" as const,
        },
      ],
      warnings: [],
      counts: { instructions: 0, skills: 1, warnings: 0 },
    };
    const service: HarnessService = {
      ...f.service,
      getProjectContext: async (session) => {
        expect(session).toBe(id);
        calls.push("context");
        return catalog;
      },
      registerMcpServer: async (raw) => {
        calls.push("register");
        const input = mcpRegisterInputSchema.parse(raw);
        expect(input.args).toEqual(["--flag", "with space"]);
        return {
          id: input.id,
          label: input.label,
          command: input.command,
          args: input.args,
          enabled: true,
          requestTimeoutMs: 15000,
          envNameCount: 0,
          hasPrivateEnv: false,
        };
      },
      setMcpEnabled: async (server, enabled) => {
        calls.push(`enable:${server}:${enabled}`);
        return {
          id: server,
          label: server,
          command: "node",
          args: [],
          enabled,
          requestTimeoutMs: 15000,
          envNameCount: 0,
          hasPrivateEnv: false,
        };
      },
      getMcpHealth: async (server) => {
        calls.push(`health:${server}`);
        return {
          id: server,
          enabled: true,
          connected: true,
          negotiatedProtocolVersion: "2025-11-25",
          lastError: undefined,
        };
      },
      listCheckpoints: async (session) => {
        expect(session).toBe(id);
        calls.push("checkpoints");
        return [];
      },
      getCheckpointDiff: async (session, checkpoint) => {
        expect(session).toBe(id);
        expect(checkpoint).toBe(id);
        calls.push("diff");
        return "diff";
      },
      restoreCheckpoint: async (session, checkpoint) => {
        expect(session).toBe(id);
        expect(checkpoint).toBe(id);
        calls.push("restore");
        return f.snapshot;
      },
    };
    for (const argv of [
      ["context", id],
      ["skills", id],
      [
        "mcp",
        "register",
        "server",
        "Server",
        "node",
        "--",
        "--flag",
        "with space",
      ],
      ["mcp", "enable", "server"],
      ["mcp", "health", "server"],
      ["checkpoints", "list", id],
      ["checkpoints", "diff", id, id],
      ["checkpoints", "restore", id, id],
    ])
      expect(await runCliWithIO(argv, service, f.io)).toBe(0);
    expect(calls).toEqual([
      "context",
      "context",
      "register",
      "enable:server:true",
      "health:server",
      "checkpoints",
      "diff",
      "restore",
    ]);
    expect(f.output.join("")).toContain('"name": "One"');
  });

  it("preserves an omitted key and never prints configuration input", async () => {
    const f = fixture("/unused", "completed", "sample-test-value \n");
    expect(
      await runCliWithIO(
        ["config", "set", "--theme", "dark", "--timeout-ms", "2000"],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.updates[0]).toEqual({
      settings: { theme: "dark", requestTimeoutMs: 2000 },
    });
    expect(
      await runCliWithIO(["config", "set", "--api-key-stdin"], f.service, f.io),
    ).toBe(0);
    expect(f.updates[1]?.apiKey).toBe("sample-test-value ");
    expect(f.output.join("") + f.diagnostics.join("")).not.toContain(
      "sample-test-value",
    );
    expect(
      await runCliWithIO(
        ["config", "set", "--api-key", "sample-test-value"],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(f.diagnostics.join("")).not.toContain("sample-test-value");
  });

  it("empty stdin explicitly clears a key; embedded newlines are rejected safely", async () => {
    const empty = fixture("/unused", "completed", "\n");
    expect(
      await runCliWithIO(
        ["config", "set", "--api-key-stdin"],
        empty.service,
        empty.io,
      ),
    ).toBe(0);
    expect(empty.updates[0]?.apiKey).toBe("");
    const bad = fixture("/unused", "completed", "first\nsecond\n");
    expect(
      await runCliWithIO(
        ["config", "set", "--api-key-stdin"],
        bad.service,
        bad.io,
      ),
    ).toBe(1);
    expect(bad.updates).toHaveLength(0);
    expect(bad.diagnostics.join("")).not.toContain("first");
  });

  it("validates prompt and workspace before creating a session", async () => {
    const workspace = await directory();
    const f = fixture(workspace);
    expect(
      await runCliWithIO(["run", "--workspace", workspace], f.service, f.io),
    ).toBe(1);
    expect(
      await runCliWithIO(
        ["run", "task", "--prompt-stdin", "--workspace", workspace],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(
      await runCliWithIO(
        ["run", "task", "--workspace", join(workspace, "missing")],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(f.creates()).toBe(0);
    expect(f.reads()).toBe(0);
  });

  it("denies non-TTY workspace approval even with --yes and emits ordered JSONL", async () => {
    const workspace = await directory();
    const f = fixture(workspace);
    expect(
      await runCliWithIO(
        [
          "run",
          "fix",
          "the",
          "tests",
          "--workspace",
          workspace,
          "--permission",
          "workspace",
          "--yes",
          "--json",
        ],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.runs[0]?.prompt).toBe("fix the tests");
    expect(f.approvals).toEqual([false]);
    expect(f.diagnostics.join("")).toContain("--permission unrestricted --yes");
    const envelope = z.discriminatedUnion("kind", [
      z.object({
        version: z.literal(1),
        kind: z.literal("event"),
        event: z.object({ type: z.string() }).passthrough(),
      }),
      z.object({
        version: z.literal(1),
        kind: z.literal("result"),
        session: sessionSnapshotSchema,
      }),
    ]);
    const lines = f.output
      .join("")
      .trim()
      .split("\n")
      .map((line) => envelope.parse(JSON.parse(line)));
    expect(
      lines.map((line) =>
        line.kind === "event" ? line.event.type : line.kind,
      ),
    ).toEqual(["run_started", "text_delta", "run_finished", "result"]);
  });

  it("runs an existing session with a prompt file and explicit unrestricted approval", async () => {
    const workspace = await directory();
    const path = join(workspace, "prompt.txt");
    await writeFile(path, "Implement the owned task.\n");
    const f = fixture(workspace);
    expect(
      await runCliWithIO(
        [
          "run",
          "--session",
          id,
          "--prompt-file",
          path,
          "--model",
          "new-model",
          "--permission",
          "unrestricted",
          "--yes",
        ],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.creates()).toBe(0);
    expect(f.runs[0]).toEqual({
      sessionId: id,
      prompt: "Implement the owned task.",
      model: "new-model",
      permission: "unrestricted",
    });
    expect(f.approvals).toEqual([true]);
    const alias = fixture(workspace);
    expect(
      await runCliWithIO(
        ["run", "continue", "--session", id],
        alias.service,
        alias.io,
      ),
    ).toBe(0);
    expect(alias.creates()).toBe(0);
  });

  it.each([
    ["completed", 0],
    ["failed", 1],
    ["cancelled", 130],
  ] as const)("maps %s to exit %i", async (status, code) => {
    const f = fixture(await directory(), status);
    expect(
      await runCliWithIO(["run", "--session", id, "continue"], f.service, f.io),
    ).toBe(code);
  });

  it("SIGINT aborts the call and waits for settlement before returning", async () => {
    const f = fixture(await directory());
    let settled = false;
    const service: HarnessService = {
      ...extendedService(),
      ...f.service,
      run: async (_input, _sink, _approve, signal) => {
        const cancelled = new Promise<void>((resolveCancellation) =>
          signal.addEventListener("abort", () => resolveCancellation(), {
            once: true,
          }),
        );
        f.interrupt();
        await cancelled;
        await Promise.resolve();
        settled = true;
        return { ...f.snapshot, status: "cancelled" };
      },
    };
    expect(await runCliWithIO(["run", "--session", id, "continue"], service, f.io)).toBe(
      130,
    );
    expect(settled).toBe(true);
  });

  it("configures browser origins and executable with clear validation", async () => {
    const f = fixture("/unused");
    expect(
      await runCliWithIO(
        [
          "config",
          "set",
          "--browser-origins",
          "http://127.0.0.1:4173, https://example.invalid",
          "--browser-executable",
          "/usr/bin/chromium",
        ],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.updates[0]).toEqual({
      settings: {
        browserAllowedOrigins: [
          "http://127.0.0.1:4173",
          "https://example.invalid",
        ],
        browserExecutablePath: "/usr/bin/chromium",
      },
    });
    expect(
      await runCliWithIO(
        ["config", "set", "--browser-origins", "", "--browser-executable", ""],
        f.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.updates[1]).toEqual({
      settings: { browserAllowedOrigins: [], browserExecutablePath: "" },
    });
  });

  it.each([
    ["*"],
    ["https://*"],
    ["https://*.example.invalid"],
    ["https://user:pass@example.invalid"],
    ["https://example.invalid/path"],
    ["https://example.invalid?x=1"],
    ["https://example.invalid#x"],
    ["ftp://example.invalid"],
    ["example.invalid"],
    ["https://example.invalid,,https://b.invalid"],
  ])("rejects masquerading browser origin %s", async (value) => {
    const f = fixture("/unused");
    expect(
      await runCliWithIO(
        ["config", "set", "--browser-origins", value],
        f.service,
        f.io,
      ),
    ).toBe(1);
    expect(f.updates).toHaveLength(0);
    expect(f.diagnostics.join("")).not.toContain("user:pass");
  });

  it("provider errors are safe and go only to stderr", async () => {
    const f = fixture("/unused");
    const service: HarnessService = {
      ...extendedService(),
      ...f.service,
      listModels: async () => {
        throw new Error("private upstream detail");
      },
    };
    expect(await runCliWithIO(["models", "--json"], service, f.io)).toBe(1);
    expect(f.output).toHaveLength(0);
    expect(f.diagnostics.join("")).not.toContain("private upstream detail");
    const expected: HarnessService = {
      ...f.service,
      listModels: async () => {
        throw new ForgeError("provider", "Model discovery failed.");
      },
    };
    expect(await runCliWithIO(["models"], expected, f.io)).toBe(1);
    expect(f.diagnostics.join("")).toContain("Model discovery failed.");
  });
});

it("keeps machine catalog JSON byte-exact without touching UI", async () => {
  const f = fixture(process.cwd());
  const io: CliIO = {
    ...f.io,
    get ui(): never {
      throw Error("machine touched UI");
    },
  };
  expect(await runCliWithIO(["models", "--json"], f.service, io)).toBe(0);
  expect(f.output.join("")).toBe('["test-model"]\n');
});

it("configures and clears an explicit token budget without changing the model window", async () => {
  const f = fixture("/workspace");
  expect(await runCliWithIO(["config", "set", "--context-budget-tokens", "64000"], f.service, f.io)).toBe(0);
  expect(f.updates.at(-1)?.settings).toEqual({ contextBudgetTokens: 64000 });
  expect(await runCliWithIO(["config", "set", "--context-budget-tokens", "auto"], f.service, f.io)).toBe(0);
  expect(f.updates.at(-1)?.settings).toEqual({ contextBudgetTokens: null });
  for (const value of ["0", "NaN", "1.5", "2000"]) {
    expect(await runCliWithIO(["config", "set", "--context-budget-tokens", value], f.service, f.io)).not.toBe(0);
  }
  expect(f.updates).toHaveLength(2);
});
