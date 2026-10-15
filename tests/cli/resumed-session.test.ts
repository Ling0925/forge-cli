import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { watchResumedSession } from "../../src/cli/interactive/resumed-session";
import { pickSession } from "../../src/cli/interactive/pickers";
import { Controller } from "./legacy/controller";
import { sessionSnapshotSchema } from "../../src/shared/schemas";
import type { CliIO } from "../../src/cli/cli";
import type { HarnessService } from "../../src/shared/contracts";
import type { PickerSpec } from "../../src/cli/ui-contract";
const snapshot = sessionSnapshotSchema.parse({
  version: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Active task", workspace: "/tmp",
  model: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: "running", messages: [], events: [], changes: [],
});
afterEach(() => vi.useRealTimers());

it("marks running and approval sessions as active in the resume picker", async () => {
  const choose = vi.fn(async (_spec: PickerSpec, _signal: AbortSignal) => null);
  await pickSession({ listSessions: async () => [snapshot, { ...snapshot, status: "awaiting_approval" }, { ...snapshot, status: "completed" }] } as HarnessService,
    { ui: { setStatus: () => {}, choose } } as unknown as CliIO, "", new AbortController().signal);
  expect(choose.mock.calls[0]?.[0].items.map(item => item.active === true)).toEqual([true, true, false]);
});

it("polls sequentially, updates state, and stops when a resumed run finishes", async () => {
  vi.useFakeTimers();
  const getSession = vi.fn().mockResolvedValueOnce({ ...snapshot, status: "awaiting_approval" }).mockResolvedValue({ ...snapshot, status: "completed" });
  const update = vi.fn();
  const failed = vi.fn();
  const stop = watchResumedSession(snapshot, { getSession }, new AbortController().signal, update, failed);
  await vi.advanceTimersByTimeAsync(5000);
  expect(getSession).toHaveBeenCalledTimes(2);
  expect(update.mock.calls.map(call => call[0].status)).toEqual(["awaiting_approval", "completed"]);
  expect(failed).not.toHaveBeenCalled();
  stop();
});
it("never overlaps slow polling reads", async () => {
  vi.useFakeTimers();
  const getSession = vi.fn(() => new Promise<typeof snapshot>(() => {}));
  const stop = watchResumedSession(snapshot, { getSession }, new AbortController().signal, vi.fn(), vi.fn());
  await vi.advanceTimersByTimeAsync(10000);
  expect(getSession).toHaveBeenCalledTimes(1);
  stop();
});
it("discards a late read after cancellation without repainting a different session", async () => {
  vi.useFakeTimers();
  let resolve!: (value: typeof snapshot) => void;
  const getSession = vi.fn(() => new Promise<typeof snapshot>(done => { resolve = done; }));
  const update = vi.fn();
  const abort = new AbortController();
  watchResumedSession(snapshot, { getSession }, abort.signal, update, vi.fn());
  await vi.advanceTimersByTimeAsync(1100);
  abort.abort();
  resolve(snapshot);
  await vi.advanceTimersByTimeAsync(5000);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(update).not.toHaveBeenCalled();
});
it("stops polling on read failure rather than leaving a false live animation", async () => {
  vi.useFakeTimers();
  const getSession = vi.fn().mockRejectedValue(new Error("fixture"));
  const failed = vi.fn();
  watchResumedSession(snapshot, { getSession }, new AbortController().signal, vi.fn(), failed);
  await vi.advanceTimersByTimeAsync(5000);
  expect(getSession).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledTimes(1);
});
it("repaints active picker and observed statuses without advertising cancellation or fake metrics", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  const controller = new Controller(input, output, true, () => {}, () => {}, () => {}, async () => false);
  try {
    await controller.configure({ theme: "dark" });
    const paint = vi.spyOn(controller.screen, "paint");
    const choice = controller.choose({ title: "Resume", items: [{ value: "a", label: "Task", active: true }] }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    expect(paint.mock.calls.at(-1)?.[0].flat().map(span => span.text).join("")).toContain("⠙ Task");
    controller.picker?.resolve(null);
    await choice;
    for (const fixed of [true, false]) {
      controller.screen.fixed = fixed;
      controller.setStatus({ label: "会话仍在运行", startedAt: 0, toolCount: 0, cancellable: false, observing: true });
      await vi.advanceTimersByTimeAsync(100);
      const text = paint.mock.calls.at(-1)?.[0].flat().map(span => span.text).join("") ?? "";
      expect(text).toContain("会话仍在运行");
      expect(text).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      expect(text).not.toContain("Ctrl+C cancel");
      expect(text).not.toContain("tokens");
    }
  } finally { controller.dispose(); }
});
