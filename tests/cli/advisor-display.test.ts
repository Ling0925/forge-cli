import { expect, it } from "vitest";
import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { InkView } from "../../src/cli/ink/view";
import { initialInput } from "../../src/cli/ink/input-state";
import type { InkViewState } from "../../src/cli/ink/types";
import { stripAnsi } from "../../src/cli/render/width";
import { createEventRenderer } from "../../src/cli/render/events";
import { LiveRun } from "../../src/cli/live-run";
import { createTheme } from "../../src/cli/theme";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import type { RichLine } from "../../src/cli/ui-contract";
import { agentEventSchema, defaultPublicSettings, parseSessionId, sessionSnapshotSchema, type AgentEvent } from "@forge/core/shared/schemas";
import type { AdvisorRequest } from "@forge/core/shared/agent-coordination";
import type { HarnessService } from "@forge/core/shared/contracts";
import { extendedService } from "./service-fixture";

const parentId = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const childId = parseSessionId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const requestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const base = { sessionId: parentId, timestamp: "2026-01-01T00:00:00Z" };
const text = (rows: readonly RichLine[]) => rows.map(row => row.map(span => span.text).join("")).join("\n");
const child = (status: "running" | "completed" = "running"): AgentEvent => ({ ...base, type: "agent_update", childSessionId: childId,
  model: "flash", status, summary: "PRIVATE CHILD OUTPUT", currentTool: { name: "advisor", target: "" } });
const advisor = (status: AdvisorRequest["status"], delivered = false, id = requestId): AgentEvent => agentEventSchema.parse({
  ...base, type: "advisor_update", request: { id, parentSessionId: parentId, childSessionId: childId,
    parentRunId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", toolCallId: "ask", status,
    question: "PRIVATE QUESTION", context: "PRIVATE CONTEXT", createdAt: base.timestamp, updatedAt: base.timestamp, deadlineAt: base.timestamp,
    ...(status === "answered" ? { answer: "PRIVATE ANSWER", nextInstruction: "PRIVATE INSTRUCTION", ...(delivered ? { deliveredAt: base.timestamp } : {}) } : {}),
  },
});
function output() {
  let out = "", err = "";
  const io: CliIO = { isTTY: false, stdout: value => { out += value; }, stderr: value => { err += value; },
    question: async () => "", readStdin: async () => "", onInterrupt: () => () => {} };
  return { io, stdout: () => out, stderr: () => err };
}

it("keeps waiting and delivery states on the child card without changing parent Markdown or tool counts", () => {
  const renderer = createEventRenderer({ width: () => 150 });
  const before = renderer.push({ ...base, type: "text_delta", text: "Parent **draft**" });
  renderer.push(child());
  const pending = renderer.push(advisor("pending"));
  expect(pending.append).toEqual([]);
  expect(text(pending.tail)).toContain("awaiting advisor");
  expect(text(pending.tail)).toContain("Parent");
  expect(pending.status?.toolCount).toBe(before.status?.toolCount);
  expect(text(renderer.push(child()).tail)).toContain("awaiting advisor");
  expect(text(renderer.push(advisor("answered")).tail)).toContain("advisor answered (delivery pending)");
  expect(text(renderer.push(advisor("answered", true)).tail)).toContain("advisor delivered");
  const done = renderer.push(child("completed"));
  expect(text(done.append)).toContain("completed");
  expect(text(done.tail)).not.toContain("Agent");
  const final = renderer.finish();
  expect(text(final.append)).toContain("Parent");
  expect(text([...pending.tail, ...done.append, ...final.append])).not.toContain("PRIVATE");
});

it.each(["expired", "cancelled", "interrupted"] as const)("shows question %s without claiming the child finished, and ignores late events after cancellation", status => {
  const renderer = createEventRenderer({ width: () => 150 });
  // The durable request may arrive before a coalesced agent_update.
  renderer.push(advisor("pending"));
  expect(text(renderer.push(child()).tail)).toContain("awaiting advisor");
  const closed = renderer.push(advisor(status));
  expect(text(closed.tail)).toContain(`advisor ${status}`);
  expect(text(closed.tail)).toContain("running");
  const cancelled = renderer.push({ ...base, type: "state_changed", status: "cancelled" });
  expect(cancelled.tail).toEqual([]);
  expect(renderer.push(advisor("pending")).tail).toEqual([]);
});

it("does not let an old answer hide a newer pending request", () => {
  const renderer = createEventRenderer({ width: () => 150 });
  renderer.push(advisor("pending"));
  const latest = renderer.push(advisor("pending", false, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"));
  expect(renderer.push(advisor("answered", true)).tail).toEqual(latest.tail);
});

it("announces advisor metadata on append-only stderr and leaves child contents out of the reply", () => {
  const capture = output();
  const live = new LiveRun(capture.io, createTheme({ isTTY: false }));
  live.event({ ...base, type: "text_delta", text: "Parent reply" });
  live.event(advisor("pending"));
  live.event(advisor("answered"));
  live.event(advisor("answered", true));
  live.dispose();
  expect(capture.stderr()).toContain("awaiting advisor");
  expect(capture.stderr()).toContain("advisor answered (delivery pending)");
  expect(capture.stderr()).toContain("advisor delivered");
  expect(capture.stdout()).toContain("Parent reply");
  expect(capture.stdout() + capture.stderr()).not.toContain("PRIVATE");
});

it("paints the waiting-to-delivered transition in real incremental Ink output", async () => {
  const terminal = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 24 });
  let bytes = "";
  terminal.on("data", chunk => { bytes += chunk.toString(); });
  const renderer = createEventRenderer({ width: () => 120 });
  const state: InkViewState = { columns: 120, rows: 24, tail: [], status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: true, pendingInput: [], inputHint: "composer", now: 0, visibleHistory: [] };
  const app = render(createElement(InkView, { state, input: initialInput() }), {
    stdout: terminal as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  try {
    await settle();
    renderer.push(child());
    for (const [event, label] of [[advisor("pending"), "awaiting advisor"], [advisor("answered"), "delivery pending"],
      [advisor("answered", true), "advisor delivered"]] as const) {
      bytes = "";
      const update = renderer.push(event);
      app.rerender(createElement(InkView, { state: { ...state, tail: update.tail, status: update.status ?? null }, input: initialInput() }));
      await settle();
      expect(stripAnsi(bytes)).toContain(label);
      expect(stripAnsi(bytes)).not.toContain("PRIVATE");
    }
  } finally { app.unmount(); app.cleanup(); }
});

it.each([false, true])("handles advisor events in standalone CLI (json=%s)", async json => {
  const capture = output();
  const snapshot = sessionSnapshotSchema.parse({ version: 1, id: parentId, title: "Fixture", workspace: "/fixture", model: "fixture",
    createdAt: base.timestamp, updatedAt: base.timestamp, status: "completed", messages: [], events: [], changes: [] });
  const service: HarnessService = { ...extendedService(), getSettings: async () => defaultPublicSettings,
    updateSettings: async () => defaultPublicSettings, listModels: async () => [], listSessions: async () => [],
    createSession: async () => snapshot, getSession: async () => snapshot, cancelSession: async () => false,
    compactSession: async () => snapshot, forkSession: async () => snapshot, renameSession: async () => snapshot,
    archiveSession: async () => snapshot, getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }),
    dispose: async () => {}, run: async (_input, emit) => {
      emit(advisor("pending")); emit(advisor("answered")); emit(advisor("answered", true));
      emit({ ...base, type: "text_delta", text: "Final parent reply" });
      return snapshot;
    },
  };
  expect(await runCliWithIO(["run", "go", "--session", parentId, ...(json ? ["--json"] : [])], service, capture.io)).toBe(0);
  if (json) {
    const rows = capture.stdout().trim().split("\n").map(row => JSON.parse(row));
    expect(rows.filter(row => row.kind === "event" && row.event.type === "advisor_update")).toHaveLength(3);
    expect(capture.stderr()).toBe("");
  } else {
    expect(capture.stderr()).toContain("awaiting advisor");
    expect(capture.stderr()).toContain("advisor delivered");
    expect(capture.stdout()).toContain("Final parent reply");
    expect(capture.stdout() + capture.stderr()).not.toContain("PRIVATE");
  }
});
