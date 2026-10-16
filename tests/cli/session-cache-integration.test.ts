import { expect, it } from "vitest";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import { contextFooter } from "../../src/cli/terminal/context-footer";
import { defaultPublicSettings, parseSessionId, sessionSnapshotSchema, type AgentEvent, type SessionSnapshot } from "../../src/shared/schemas";
import type { HarnessService } from "../../src/shared/contracts";
import type { ComposerContext, TerminalUI } from "../../src/cli/ui-contract";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const other = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const timestamp = "2026-01-01T00:00:00Z";
function report(prompt: number, cached: number, projected = false): AgentEvent {
  return { type: "context_usage", sessionId: id, timestamp, usage: {
    windowTokens: 10000, usedTokens: prompt, promptTokens: prompt, cachedPromptTokens: cached, estimated: true,
    basis: projected ? "projected" : "request-with-output", parts: { instructions: 0, memory: 0, conversation: prompt, tools: 0 },
  } };
}
function end(prompt: number, cached: number): AgentEvent {
  return { type: "run_finished", sessionId: id, timestamp, status: "completed", turns: 1, toolCalls: 0,
    usage: { promptTokens: prompt, cachedPromptTokens: cached, completionTokens: 0, totalTokens: prompt }, usageComplete: true };
}
const start = (): AgentEvent => ({ type: "run_started", sessionId: id, timestamp, model: "test", permission: "workspace" });
const initial = (): SessionSnapshot => sessionSnapshotSchema.parse({ version: 1, id, title: "Task", workspace: process.cwd(), model: "test",
  createdAt: timestamp, updatedAt: timestamp, status: "completed", messages: [], changes: [], events: [start(), report(100, 0), end(100, 0)] });

it("refreshes the session average on each request, survives model/compact/resume, and resets only for a new session", async () => {
  let stored = initial();
  const contexts: ComposerContext[] = [];
  const questions: { command: string; cache: ComposerContext["sessionCache"] }[] = [];
  const commands = ["first", "/model changed", "/compact", "second", `/resume ${id}`, "/new", "/quit"];
  let current: ComposerContext | null = null;
  let runs = 0;
  const ui: TerminalUI = { columns: 100, rows: 24, configure: async () => {}, append: () => {}, setTail: () => {}, setStatus: () => {},
    setBusy: () => {}, setContext: value => { current = value; if (value) contexts.push(value); }, choose: async () => null, approve: async () => false, dispose: () => {} };
  const io: CliIO = { isTTY: true, ui, stdout: () => {}, stderr: text => { throw new Error(text); }, readStdin: async () => "",
    onInterrupt: () => () => {}, question: async () => {
      const command = commands.shift() ?? "/quit";
      questions.push({ command, cache: current?.sessionCache });
      return command;
    } };
  const service = {
    ...extendedService(), getSettings: async () => ({ ...defaultPublicSettings, model: "test" }),
    getSession: async () => stored, listSessions: async () => [stored],
    createSession: async () => ({ ...initial(), id: other, events: [] }),
    compactSession: async () => stored,
    cancelSession: async () => false, updateSettings: async () => defaultPublicSettings,
    listModels: async () => [], forkSession: async () => ({ ...initial(), id: other, events: [] }),
    renameSession: async () => stored, archiveSession: async () => stored,
    getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }),
    run: async (_input, sink) => {
      const emit = (event: AgentEvent) => { stored = { ...stored, events: [...stored.events, event] }; sink(event); };
      emit(start());
      emit(report(99999, 0, true));
      expect(current?.sessionCache?.cachedPromptTokens).toBe(runs === 0 ? 0 : 900);
      if (runs++ === 0) {
        emit(report(900, 900));
        expect(current?.sessionCache).toEqual({ promptTokens: 1000, cachedPromptTokens: 900, partial: false });
        emit(report(1000, 1000, true));
        expect(current?.sessionCache?.promptTokens).toBe(1000);
        emit(end(900, 900));
      } else {
        emit(report(1000, 0));
        expect(current?.sessionCache).toEqual({ promptTokens: 2000, cachedPromptTokens: 900, partial: false });
        emit(end(1000, 0));
      }
      return stored;
    }, dispose: async () => {},
  } as HarnessService;
  expect(await runCliWithIO(["resume", id], service, io)).toBe(0);
  expect(questions.find(q => q.command === "second")?.cache).toEqual({ promptTokens: 1000, cachedPromptTokens: 900, partial: false });
  expect(questions.find(q => q.command === "/new")?.cache).toEqual({ promptTokens: 2000, cachedPromptTokens: 900, partial: false });
  expect(questions.at(-1)?.cache).toEqual({ promptTokens: 0, cachedPromptTokens: 0, partial: false });
  const footers = contexts.map(context => contextFooter(context, 100)[0]!.map(span => span.text).join(""));
  expect(footers.some(text => text.includes("R90%"))).toBe(true);
  expect(footers.some(text => text.includes("R45%"))).toBe(true);
  expect(footers.join("\n")).not.toContain("R—");
});
