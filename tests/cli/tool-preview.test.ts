import { expect, it } from "vitest";
import { LiveRun } from "../../src/cli/live-run";
import { createEventRenderer } from "../../src/cli/render/events";
import { createTheme } from "../../src/cli/theme";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import type { AgentEvent, SessionSnapshot } from "../../src/shared/schemas";
import { defaultPublicSettings, sessionSnapshotSchema } from "../../src/shared/schemas";
import type { HarnessService } from "../../src/shared/contracts";
import { extendedService } from "./service-fixture";
import type { RichLine } from "../../src/cli/ui-contract";

const text = (lines: readonly RichLine[]) => lines.map(line => line.map(span => span.text).join("")).join("\n");
const base = { sessionId: "12345678-1234-4234-8234-123456789abc", timestamp: "2026-01-01T00:00:00.000Z" };
const preview = (id = "1:0:0", chars = 5) => ({ ...base, type: "tool_call_preview", previewId: id, name: "write_file", argumentsChars: chars }) as AgentEvent;
const call = { id: "call", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"ok"}' } } as const;
const start = { ...base, type: "tool_started", call, previewId: "1:0:0" } as AgentEvent;
const finish = { ...base, type: "tool_finished", toolCallId: "call", result: { content: "ok", isError: false } } as AgentEvent;

it("updates one preparing row without counting or committing a tool and replaces it with running", () => {
  const renderer = createEventRenderer();
  renderer.push({ ...base, type: "text_delta", text: "Answer stays" } as AgentEvent);
  const preparing = renderer.push(preview());
  expect(text(preparing.tail)).toContain("Answer stays");
  expect(text(preparing.tail)).toContain("生成参数中");
  expect(preparing.status?.toolCount).toBe(0);
  expect(preparing.append).toEqual([]);
  const update = renderer.push(preview("1:0:0", 123));
  expect(text(update.tail).match(/生成参数中/g)).toHaveLength(1);
  expect(text(update.tail)).toContain("123");
  const running = renderer.push(start);
  expect(text(running.tail)).toContain("running");
  expect(text(running.tail)).not.toContain("生成参数中");
  expect(running.status?.toolCount).toBe(1);
  const completed = renderer.push(finish);
  expect(text(completed.append)).toContain("done");
  expect(completed.tail).toEqual([]);
});

it.each([
  { ...base, type: "tool_preview_reset" }, { ...base, type: "retry_reset" },
  { ...base, type: "run_finished", status: "cancelled", turns: 1, toolCalls: 0 },
  { ...base, type: "state_changed", status: "cancelled" },
  { ...base, type: "error", error: { code: "provider", message: "failed", retryable: false } },
])("clears display-only preparation on $type", raw => {
  const renderer = createEventRenderer();
  renderer.push(preview());
  const update = renderer.push(raw as AgentEvent);
  expect(text(update.tail)).not.toContain("生成参数中");
  expect(text(update.append)).not.toContain("done");
  expect(text(renderer.finish().append)).not.toContain("生成参数中");
});

it("prints one immediate preparation notice per call in append-only mode, not one per chunk", () => {
  let out = "", err = "";
  const io: CliIO = { isTTY: false, stdout: t => { out += t; }, stderr: t => { err += t; },
    question: async () => "", readStdin: async () => "", onInterrupt: () => () => {} };
  const live = new LiveRun(io, createTheme({ isTTY: false }));
  live.event(preview());
  for (let i = 6; i < 100; i++) live.event(preview("1:0:0", i));
  expect(err.match(/生成参数中/g)).toHaveLength(1);
  expect(out).toBe("");
  live.event(start); live.event(finish);
  live.event({ ...base, type: "retry_reset" } as AgentEvent);
  live.event(preview());
  expect(err.match(/生成参数中/g)).toHaveLength(2);
  expect(out.match(/done/g)).toHaveLength(1);
  live.dispose();
});

it("handles the new events in the standalone plain CLI without flooding or losing final output", async () => {
  let out = "", err = "";
  const snapshot: SessionSnapshot = sessionSnapshotSchema.parse({ version: 1, id: base.sessionId, title: "Test", workspace: "/tmp", model: "test",
    createdAt: base.timestamp, updatedAt: base.timestamp, status: "completed", messages: [], events: [], changes: [] });
  const service: HarnessService = { ...extendedService(), getSettings: async () => defaultPublicSettings,
    updateSettings: async () => defaultPublicSettings, listModels: async () => [], listSessions: async () => [],
    createSession: async () => snapshot, getSession: async () => snapshot, cancelSession: async () => false,
    compactSession: async () => snapshot, forkSession: async () => snapshot, renameSession: async () => snapshot,
    archiveSession: async () => snapshot, getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }),
    dispose: async () => {}, run: async (_input, emit) => {
      emit(preview()); emit(preview("1:0:0", 123)); emit(start); emit(finish);
      emit({ ...base, type: "tool_preview_reset" } as AgentEvent);
      return snapshot;
    } };
  const io: CliIO = { isTTY: false, stdout: t => { out += t; }, stderr: t => { err += t; }, question: async () => "",
    readStdin: async () => "", onInterrupt: () => () => {} };
  const code = await runCliWithIO(["run", "go", "--workspace", "/tmp"], service, io);
  expect(code).toBe(0);
  expect(err.match(/生成参数中/g)).toHaveLength(1);
  expect(out).toContain("finished");
});
