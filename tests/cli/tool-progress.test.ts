import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import type { AgentEvent, ToolCall } from "../../src/shared/schemas";
import { createEventRenderer } from "../../src/cli/render/events";
import { TerminalReader } from "./legacy/reader";
import { LiveRun } from "../../src/cli/live-run";
import { createTheme } from "../../src/cli/theme";
import type { CliIO } from "../../src/cli/cli";
import type { RichLine } from "../../src/cli/ui-contract";

const text = (lines: readonly RichLine[]) => lines.map((line) => line.map((span) => span.text).join("")).join("\n");
const call = (id: string): ToolCall => ({ id, type: "function", function: { name: "run_command", arguments: JSON.stringify({ argv: ["echo", id] }) } });
const ioFixture = (stdout: (text: string) => void, stderr: (text: string) => void): CliIO => ({
  isTTY: true, stdout, stderr,
  readStdin: async () => "", question: async () => "",
  onInterrupt: () => () => undefined,
});

it("reports tool start immediately in append-only fallback without duplicating result stdout", () => {
  let out = "";
  let err = "";
  const run = new LiveRun(ioFixture((value) => { out += value; }, (value) => { err += value; }), createTheme({ isTTY: false }));
  run.event(start("one"));
  expect(err).toContain("run_command echo one · running");
  expect(out).not.toContain("done");
  run.event(finish("one"));
  run.dispose();
  expect(out.match(/run_command/g)).toHaveLength(1);
  expect(out).toContain("done");
  expect(err.match(/running/g)).toHaveLength(1);
  expect(out + err).not.toContain("\u001b");
});

const start = (id: string) => ({ type: "tool_started", call: call(id) }) as AgentEvent;
const finish = (id: string, code = 0) => ({ type: "tool_finished", toolCallId: id, result: { content: JSON.stringify({ exit_code: code }), isError: false } }) as AgentEvent;

it("replaces the transient tool with one done record, leaving concurrent tools running", () => {
  const renderer = createEventRenderer();
  expect(renderer.push(start("one")).append).toEqual([]);
  expect(renderer.push(start("two")).tail).toHaveLength(2);
  const first = renderer.push(finish("two"));
  expect(text(first.append)).toContain("echo two · done");
  expect(text(first.tail)).toContain("echo one · running");
  expect(text(first.tail)).not.toContain("echo two");
  const last = renderer.push(finish("one", 3));
  expect(text(last.append)).toContain("failed · exit 3");
  expect(last.tail).toEqual([]);
  expect(renderer.finish().append).toEqual([]);
});

it("keeps progress through approval/plan events and clears it on cancellation without claiming done", () => {
  const renderer = createEventRenderer();
  renderer.push(start("one"));
  const approval = renderer.push({ type: "approval_requested" } as AgentEvent);
  expect(text(approval.tail)).toContain("running");
  const plan = renderer.push({ type: "plan_updated", plan: { steps: [], explanation: "working" } } as unknown as AgentEvent);
  expect(text(plan.tail)).toContain("running");
  const cancelled = renderer.push({ type: "state_changed", status: "cancelled" } as AgentEvent);
  expect(cancelled.tail).toEqual([]);
  expect(text(cancelled.append)).toContain("cancelled");
  expect(text(cancelled.append)).not.toContain("done");
  expect(renderer.finish().append).toEqual([]);
});

it("finalizes an interrupted tool once on disposal or error", () => {
  for (const error of [false, true]) {
    const renderer = createEventRenderer();
    renderer.push(start("one"));
    const stopped = error ? renderer.push({ type: "error", error: { message: "lost connection" } } as AgentEvent) : renderer.finish();
    expect(stopped.tail).toEqual([]);
    expect(text(stopped.append)).toContain("interrupted");
    expect(text(stopped.append)).not.toContain("done");
    expect(renderer.finish().append).toEqual([]);
  }
});

it("animates while no new events arrive, then stops after completion and disposal", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubEnv("TERM", "xterm-256color");
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let bytes = "";
  output.on("data", (data) => { bytes += data.toString(); });
  const reader = new TerminalReader({ input, output, isTTY: true, onInterrupt: () => undefined });
  try {
    await reader.ui.configure({ theme: "dark" });
    const io = ioFixture(() => { throw Error("unexpected stdout"); }, () => { throw Error("unexpected stderr"); });
    const run = new LiveRun({ ...io, ui: reader.ui }, createTheme({ isTTY: false }));
    bytes = "";
    run.event(start("one"));
    expect(bytes).toContain("⠋");
    expect(bytes).toContain("echo one");
    expect(bytes).toContain("running");
    expect(bytes).not.toContain("done");
    bytes = "";
    vi.advanceTimersByTime(100);
    expect(bytes).toContain("⠙");
    run.event(finish("one"));
    expect(bytes).toContain("done");
    run.dispose();
    reader.ui.setStatus(null);
    bytes = "";
    vi.advanceTimersByTime(1000);
    expect(bytes).toBe("");
    reader.dispose();
    bytes = "";
    vi.advanceTimersByTime(1000);
    expect(bytes).toBe("");
  } finally {
    reader.dispose();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});
