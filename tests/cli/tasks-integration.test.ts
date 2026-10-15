import { expect, it, vi } from "vitest";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import type { HarnessService } from "../../src/shared/contracts";
import { defaultPublicSettings, parseSessionId, sessionSnapshotSchema } from "../../src/shared/schemas";
import type { TaskService } from "../../src/shared/task-view";
import type { TerminalUI } from "../../src/cli/ui-contract";
import { extendedService } from "./service-fixture";
const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const snapshot = sessionSnapshotSchema.parse({ version: 1, id, title: "task test", workspace: process.cwd(), model: "test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", status: "completed", messages: [], events: [], changes: [] });
const emptyTasks = (): TaskService => ({ listTasks: vi.fn(async () => ({ tasks: [], offset: 0, nextOffset: null, truncated: false })), getTask: async () => { throw Error("unused"); }, stopTask: async () => false });
function service(run: HarnessService["run"], tasks?: TaskService): HarnessService {
  return { ...extendedService(), ...(tasks ? { tasks } : {}), getSettings: async () => ({ ...defaultPublicSettings, model: "test" }),
    updateSettings: async () => defaultPublicSettings, listModels: async () => [], listSessions: async () => [], createSession: async () => snapshot,
    getSession: async () => snapshot, run, compactSession: async () => snapshot, cancelSession: async () => false, forkSession: async () => snapshot,
    renameSession: async () => snapshot, archiveSession: async () => snapshot, getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }), dispose: async () => {} };
}
function host(lines: string[], ui?: TerminalUI) {
  let send: ((line: string) => void) | undefined;
  const out: string[] = [];
  const io: CliIO = { ...(ui ? { ui } : {}), isTTY: true, stdout: s => out.push(s), stderr: s => out.push(s),
    question: async () => lines.shift() ?? "/quit", readStdin: async () => { throw Error("unexpected stdin"); }, onInterrupt: () => () => {},
    onRunInput: callback => { send = callback; return () => { send = undefined; }; } };
  return { io, out, send: (value: string) => send?.(value) };
}
it("/tasks without a session does not create one or call a model", async () => {
  const tasks = emptyTasks(); const run = vi.fn(async () => snapshot);
  const s = service(run, tasks); const create = vi.spyOn(s, "createSession");
  const h = host(["/tasks", "/quit"]);
  expect(await runCliWithIO(["chat"], s, h.io)).toBe(0);
  expect(run).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(tasks.listTasks).not.toHaveBeenCalled();
  expect(h.out.join("")).toContain("No active session");
});
it("/tasks runs immediately during an active model turn rather than being queued", async () => {
  const tasks = emptyTasks(); const h = host(["work", "/quit"]);
  const s = service(async (_input, _events, _approve, signal) => {
    h.send("/tasks");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tasks.listTasks).toHaveBeenCalledWith(id, expect.anything(), expect.anything());
    expect(signal.aborted).toBe(false);
    return snapshot;
  }, tasks);
  expect(await runCliWithIO(["chat"], s, h.io)).toBe(0);
  expect(h.out.join("")).not.toContain("Command accepted; will execute");
});
it("manual approvals close the live panel first without cancelling the run", async () => {
  let opened = () => {}; const ready = new Promise<void>(resolve => { opened = resolve; });
  let panelClosed = false;
  const ui: TerminalUI = { columns: 80, rows: 24, configure: async () => {}, append: () => {}, setTail: () => {}, setStatus: () => {}, setBusy: () => {}, dispose: () => {},
    choose: async (_spec, signal) => { opened(); return new Promise(resolve => { const close = () => { panelClosed = true; resolve(null); }; signal.addEventListener("abort", close, { once: true }); if (signal.aborted) close(); }); },
    approve: async () => { expect(panelClosed).toBe(true); return false; } };
  const tasks = emptyTasks(); tasks.listTasks = async () => ({ tasks: [{ id: "child", kind: "agent", sessionId: id, title: "child", status: "running", active: true, controllable: true, historical: false }], offset: 0, nextOffset: null, truncated: false });
  const h = host(["work", "/quit"], ui);
  const s = service(async (_input, _events, approve, signal) => {
    h.send("/tasks"); await ready;
    const approved = await approve({ id, sessionId: id, toolCallId: "t", toolName: "run_command", description: "test", command: ["test"] }, signal);
    expect(approved).toBe(false); expect(signal.aborted).toBe(false); return snapshot;
  }, tasks);
  expect(await runCliWithIO(["chat", "--approval", "manual"], s, h.io)).toBe(0);
});
