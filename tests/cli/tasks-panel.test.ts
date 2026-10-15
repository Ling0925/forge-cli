import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "../../src/shared/schemas";
import type { TaskDetail, TaskPage, TaskService, TaskView } from "../../src/shared/task-view";
import type { CliIO } from "../../src/cli/cli";
import { showTasks } from "../../src/cli/interactive/tasks";
import type { PickerSpec, TerminalUI } from "../../src/cli/ui-contract";

const parent = "parent" as SessionId;
const task: TaskView = {
  id: "command-full-id", kind: "command", sessionId: parent, title: "Build",
  status: "running", active: true, controllable: true, historical: false,
  model: "model-id", activity: "run_command", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
};
const page = (tasks: readonly TaskView[] = [task], offset = 0, nextOffset: number | null = null): TaskPage => ({
  tasks, offset, nextOffset, truncated: nextOffset !== null,
});
const detail = (view = task): TaskDetail => ({ task: view, content: "result", offset: 0, nextOffset: null, truncated: false });
function fixture(choices?: (string | null)[]) {
  const specs: PickerSpec[] = [];
  const choose = vi.fn(async (spec: PickerSpec) => { specs.push(spec); return choices?.shift() ?? null; });
  const ui = choices ? { choose } as unknown as TerminalUI : undefined;
  const io: CliIO = {
    ...(ui ? { ui } : {}), isTTY: Boolean(ui), stdout: vi.fn(), stderr: vi.fn(),
    readStdin: vi.fn(), question: vi.fn(), onInterrupt: () => () => {},
  };
  const service: TaskService = {
    listTasks: vi.fn(async () => page()),
    getTask: vi.fn(async () => detail()),
    stopTask: vi.fn(async () => true),
  };
  return { io, service, specs, choose };
}
afterEach(() => vi.useRealTimers());

describe("local tasks panel", () => {
  it("prints bounded plain lists, usage and explicit full-ID instructions without input", async () => {
    const { io, service } = fixture();
    vi.mocked(service.listTasks).mockResolvedValue(page(Array.from({ length: 30 }, (_, n) => ({ ...task, id: `id-${n}` }))));
    await showTasks(service, io, parent, new AbortController().signal);
    const text = vi.mocked(io.stdout).mock.calls.map(call => call[0]).join("");
    expect(text).toContain("id-19"); expect(text).not.toContain("id-20");
    expect(text).toContain("usage: 10 in / 5 out");
    expect(text).toContain("/tasks stop agent|command ID");
    expect(io.question).not.toHaveBeenCalled();
  });

  it("rejects unknown syntax and mismatched/abbreviated IDs", async () => {
    const { io, service } = fixture();
    await showTasks(service, io, parent, new AbortController().signal, "resolve command-full-id");
    expect(service.getTask).not.toHaveBeenCalled();
    await showTasks(service, io, parent, new AbortController().signal, "command command");
    expect(io.stderr).toHaveBeenLastCalledWith(expect.stringContaining("exact full ID"));
    expect(service.stopTask).not.toHaveBeenCalled();
  });

  it("uses active-first rows, list pagination and bounded result pages", async () => {
    const { io, service, specs } = fixture([":next", `command ${task.id}`, ":result", ":next", ":result", ":back", ":close"]);
    const historical = { ...task, id: "old", active: false, controllable: false, historical: true };
    vi.mocked(service.listTasks).mockImplementation(async (_parent, offset = 0) => offset ? page([task], 20) : page([historical, task], 0, 20));
    vi.mocked(service.getTask).mockImplementation(async (_parent, _kind, _id, offset = 0) => ({
      ...detail(), content: offset ? "second page" : "x".repeat(9000), offset,
      nextOffset: offset ? null : 6000, truncated: !offset,
    }));
    await showTasks(service, io, parent, new AbortController().signal);
    expect(specs[0]?.items[0]?.value).toBe(`command ${task.id}`);
    expect(specs[0]?.items[1]?.detail).toContain("historical");
    expect(service.listTasks).toHaveBeenCalledWith(parent, 20, 20);
    expect(service.getTask).toHaveBeenCalledWith(parent, "command", task.id, 6000, 6000);
    const text = vi.mocked(io.stdout).mock.calls.map(call => call[0]).join("");
    expect(text).toContain("second page"); expect(text).not.toContain("x".repeat(6001));
  });

  it("requires a second, default-cancel picker and revalidates before stopping", async () => {
    const { io, service, specs } = fixture([":stop"]);
    await showTasks(service, io, parent, new AbortController().signal, `stop command ${task.id}`);
    expect(specs[0]).toMatchObject({ confirmation: true, selected: ":cancel" });
    expect(specs[0]?.items[0]?.value).toBe(":cancel");
    expect(service.getTask).toHaveBeenCalledTimes(2);
    expect(service.stopTask).toHaveBeenCalledWith(parent, "command", task.id);
    expect(io.question).not.toHaveBeenCalled();
  });

  it("never stops on cancel, historical tasks, plain adapters or stale control state", async () => {
    for (const mode of ["cancel", "historical", "plain", "stale"] as const) {
      const { io, service } = fixture(mode === "plain" ? undefined : [mode === "cancel" ? ":cancel" : ":stop"]);
      if (mode === "historical") vi.mocked(service.getTask).mockResolvedValue(detail({ ...task, historical: true }));
      if (mode === "stale") vi.mocked(service.getTask).mockResolvedValueOnce(detail()).mockResolvedValue(detail({ ...task, controllable: false }));
      await showTasks(service, io, parent, new AbortController().signal, `stop command ${task.id}`);
      expect(service.stopTask).not.toHaveBeenCalled();
    }
  });

  it("panel abort does not wait for an in-flight stop/join and observes late rejection", async () => {
    const { io, service } = fixture([":stop"]);
    const controller = new AbortController();
    let rejectStop!: (reason: Error) => void;
    let started!: () => void;
    const stopping = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(service.stopTask).mockImplementation(() => {
      started(); return new Promise((_resolve, reject) => { rejectStop = reject; });
    });
    const work = showTasks(service, io, parent, controller.signal, `stop command ${task.id}`);
    await stopping;
    controller.abort();
    await work;
    rejectStop(new Error("late host join failure"));
    await Promise.resolve();
    expect(io.stderr).not.toHaveBeenCalled();
    expect(io.stdout).not.toHaveBeenCalled();
  });

  it("refreshes serially and ignores late refresh results after closing", async () => {
    vi.useFakeTimers();
    const { io, service } = fixture([]);
    let finish!: (choice: string | null) => void;
    let late!: (value: TaskPage) => void;
    const updatePicker = vi.fn();
    const ui = {
      choose: vi.fn((_spec: PickerSpec, signal: AbortSignal) => new Promise<string | null>(resolve => {
        finish = resolve; signal.addEventListener("abort", () => resolve(null), { once: true });
      })), updatePicker,
    } as unknown as TerminalUI;
    vi.mocked(service.listTasks).mockResolvedValueOnce(page()).mockImplementation(() => new Promise(resolve => { late = resolve; }));
    const work = showTasks(service, { ...io, ui }, parent, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.listTasks).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.listTasks).toHaveBeenCalledTimes(2);
    late(page([{ ...task, status: "completed" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(updatePicker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.listTasks).toHaveBeenCalledTimes(3);
    finish(null); await work;
    late(page()); await vi.advanceTimersByTimeAsync(5000);
    expect(updatePicker).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abort closes the panel and cleans polling, refresh error also closes", async () => {
    vi.useFakeTimers();
    for (const fail of [false, true]) {
      const { io, service } = fixture([]);
      const controller = new AbortController();
      const ui = { choose: vi.fn((_spec: PickerSpec, signal: AbortSignal) => new Promise<null>(resolve => {
        signal.addEventListener("abort", () => resolve(null), { once: true });
      })), updatePicker: vi.fn() } as unknown as TerminalUI;
      if (fail) vi.mocked(service.listTasks).mockResolvedValueOnce(page()).mockRejectedValue(new Error("discovery failed"));
      const work = showTasks(service, { ...io, ui }, parent, controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (fail) await vi.advanceTimersByTimeAsync(1000); else controller.abort();
      await work;
      expect(vi.getTimerCount()).toBe(0);
      if (fail) expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("discovery failed"));
    }
  });
});
