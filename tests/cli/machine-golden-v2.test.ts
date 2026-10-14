import { describe, expect, it } from "vitest";
import { type CliIO, runCliWithIO } from "../../src/cli/cli";
import type { HarnessService } from "../../src/shared/contracts";
import {
  type SessionSnapshot,
  defaultPublicSettings,
  parseSessionId,
} from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const timestamp = "2026-01-01T00:00:00.000Z";
type Outcome = "completed" | "failed" | "cancelled";

// Independent protocol literals: deliberately not JSON.stringify(event/session).
const prefix = '{"version":1,"kind":"event","event":';
const goldenStart = `${prefix}{"type":"run_started","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-01-01T00:00:00.000Z","model":"fixed-model","permission":"readonly"}}\n`;
const goldenText = `${prefix}{"type":"text_delta","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-01-01T00:00:00.000Z","text":"Hello\\nworld"}}\n`;
const goldenTool = `${prefix}{"type":"tool_started","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-01-01T00:00:00.000Z","call":{"id":"call-fixed","type":"function","function":{"name":"list_files","arguments":"{}"}}}}\n`;
const golden = (status: Outcome): string =>
  `${
    goldenStart + goldenText + goldenTool
  }${prefix}{"type":"run_finished","sessionId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","timestamp":"2026-01-01T00:00:00.000Z","status":"${status}","turns":1,"toolCalls":1}}\n{"version":1,"kind":"result","session":{"version":1,"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","title":"Fixed session","workspace":"/fixed/workspace","model":"fixed-model","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","status":"${status}","messages":[],"events":[],"changes":[]}}\n`;

function fixture(status: Outcome) {
  const session: SessionSnapshot = {
    version: 1,
    id,
    title: "Fixed session",
    workspace: "/fixed/workspace",
    model: "fixed-model",
    createdAt: timestamp,
    updatedAt: timestamp,
    status,
    messages: [],
    events: [],
    changes: [],
  };
  let output = "";
  let stderr = "";
  let reads = 0;
  let unsubscribed = false;
  let disposed = false;
  const service: HarnessService = {
    ...extendedService(),
    getSettings: async () => defaultPublicSettings,
    updateSettings: async () => defaultPublicSettings,
    listModels: async () => [],
    listSessions: async () => [],
    createSession: async () => {
      throw Error("Must resume fixed session");
    },
    getSession: async (requested) => {
      expect(requested).toBe(id);
      return session;
    },
    run: async (input, sink, _approve, signal) => {
      expect(input.sessionId).toBe(id);
      expect(input.prompt).toBe("fixed prompt");
      expect(signal.aborted).toBe(false);
      sink({
        type: "run_started",
        sessionId: id,
        timestamp,
        model: "fixed-model",
        permission: "readonly",
      });
      sink({
        type: "text_delta",
        sessionId: id,
        timestamp,
        text: "Hello\nworld",
      });
      sink({
        type: "tool_started",
        sessionId: id,
        timestamp,
        call: {
          id: "call-fixed",
          type: "function",
          function: { name: "list_files", arguments: "{}" },
        },
      });
      sink({
        type: "run_finished",
        sessionId: id,
        timestamp,
        status,
        turns: 1,
        toolCalls: 1,
      });
      return session;
    },
    compactSession: async () => session,
    forkSession: async () => session,
    renameSession: async () => session,
    archiveSession: async () => session,
    cancelSession: async () => false,
    getDiagnostics: async () => ({
      transcriptChars: 0,
      projectedChars: 0,
      messageCount: 0,
      summaryFallback: false,
    }),
    dispose: async () => {},
  };
  const io: CliIO = {
    get ui(): never {
      throw Error("Machine path activated UI");
    },
    onClose: () => {
      throw Error("Machine stdin EOF must not subscribe to interactive close");
    },
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    isTTY: false,
    readStdin: async (_limit, signal) => {
      reads++;
      expect(signal.aborted).toBe(false);
      return "fixed prompt";
    },
    question: async () => {
      throw Error("Machine path asked a question");
    },
    onInterrupt: () => () => {
      unsubscribed = true;
    },
    dispose: () => {
      disposed = true;
    },
  };
  return {
    service,
    io,
    output: () => output,
    stderr: () => stderr,
    reads: () => reads,
    cleaned: () => unsubscribed && disposed,
  };
}

describe("machine JSONL independent byte goldens", () => {
  for (const command of ["run", "resume"] as const) {
    for (const [status, code] of [
      ["completed", 0],
      ["failed", 1],
      ["cancelled", 130],
    ] as const) {
      it(`${command} --json preserves ${status} event/result bytes and exit status`, async () => {
        const f = fixture(status);
        const args =
          command === "run"
            ? ["run", "--session", id, "--prompt-stdin", "--json"]
            : ["resume", id, "fixed", "prompt", "--json"];
        expect(await runCliWithIO(args, f.service, f.io)).toBe(code);
        expect(f.output()).toBe(golden(status));
        expect(f.output()).not.toContain("\u001b");
        expect(f.output()).not.toContain("\u009b");
        expect(f.stderr()).toBe("");
        expect(f.reads()).toBe(command === "run" ? 1 : 0);
        expect(f.cleaned()).toBe(true);
      });
    }
  }
});
