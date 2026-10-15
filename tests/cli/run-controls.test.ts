import { describe, expect, it, vi } from "vitest";
import { type CliIO, runCliWithIO } from "../../src/cli/cli";
import type { HarnessService } from "../../src/shared/contracts";
import { defaultPublicSettings, parseSessionId, sessionSnapshotSchema } from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const snapshot = sessionSnapshotSchema.parse({
  version: 1, id, title: "chat", workspace: process.cwd(), model: "test",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  status: "completed", messages: [], events: [], changes: [],
});
const request = { id, sessionId: id, toolCallId: "call", toolName: "run_command", description: "command", command: ["echo", "test"] };
const service = (run: HarnessService["run"]): HarnessService => ({
  ...extendedService(), getSettings: async () => ({...defaultPublicSettings, model: "test"}),
  updateSettings: async () => defaultPublicSettings, listModels: async () => [],
  listSessions: async () => [], createSession: async () => snapshot, getSession: async () => snapshot,
  run, compactSession: async () => snapshot, cancelSession: async () => false,
  forkSession: async () => snapshot, renameSession: async () => snapshot,
  archiveSession: async () => snapshot, getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }),
  dispose: async () => {},
});
const host = (lines: string[]) => {
  const out: string[] = [];
  let listener: ((line: string, steer?: boolean) => void) | undefined;
  const readApproval = vi.fn(async () => false);
  const io: CliIO = {
    isTTY: true, stdout: text => out.push(text), stderr: text => out.push(text),
    readStdin: async () => { throw Error("unexpected stdin"); },
    question: async () => { const line = lines.shift(); if (line === undefined) throw Error("EOF"); return line; },
    readApproval, onInterrupt: () => () => {},
    onRunInput: callback => { listener = callback; return () => { listener = undefined; }; },
  };
  return { io, out, readApproval, send: (line: string, steer = false) => listener?.(line, steer), listening: () => Boolean(listener) };
};

describe("interactive run controls", () => {
  it.each(["/quit", "/exit"])("%s exits at the prompt without starting another run", async (command) => {
    const h = host([command, "must not run"]);
    const run = vi.fn(async () => snapshot);
    expect(await runCliWithIO(["chat"], service(run), h.io)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(h.out.join("")).not.toContain("Unknown");
  });

  it.each(["/quit", "/exit"])("%s cancels the active run and does not dispatch queued input", async (command) => {
    const h = host(["work", "must not run"]);
    let aborted = false;
    const run = vi.fn<HarnessService["run"]>(async (_i, _e, _a, signal) => {
      h.send("queued work");
      h.send(command);
      aborted = signal.aborted;
      return { ...snapshot, status: "cancelled" as const };
    });
    expect(await runCliWithIO(["chat"], service(run), h.io)).toBe(0);
    expect(aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.listening()).toBe(false);
  });
  it("opts into command auto approval without approving other tools or plan calls", async () => {
    const h = host(["work", "/mode plan", "plan work", "/approval ask", "ask work", "/quit"]);
    const decisions: boolean[] = [];
    const s = service(async (_input, _sink, approve, signal) => {
      decisions.push(await approve(request, signal));
      decisions.push(await approve({ ...request, toolName: "mcp__demo__tool" }, signal));
      decisions.push(await approve({ ...request, childSessionId: id }, signal));
      return snapshot;
    });
    expect(await runCliWithIO(["chat", "--approval", "auto"], s, h.io)).toBe(0);
    expect(decisions).toEqual([true, false, false, false, false, false, false, false, false]);
    expect(h.readApproval).toHaveBeenCalledTimes(2);
    expect(h.out.join("")).toContain("not sandboxed");
  });

  it("defaults to full access, rejects invalid mode and preserves manual on session change", async () => {
    const h = host(["work", "/approval manual", "manual work", "/new", "new work", "/quit"]);
    const decisions: boolean[] = [];
    expect(await runCliWithIO(["chat"], service(async (_i, _e, approve, signal) => {
      decisions.push(await approve(request, signal)); return snapshot;
    }), h.io)).toBe(0);
    expect(decisions).toEqual([true, false, false]);
    const run = vi.fn(async () => snapshot);
    expect(await runCliWithIO(["chat", "--approval", "invalid"], service(run), host([]).io)).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("queues follow-ups FIFO without overlapping runs and steers only the active run", async () => {
    const h = host(["first", "/quit"]);
    const prompts: string[] = [];
    const steering: readonly string[][] = [];
    const modes: string[] = [];
    let running = false;
    expect(await runCliWithIO(["chat"], service(async (input, _e, _approve, _signal, control) => {
      expect(running).toBe(false); running = true;
      prompts.push(input.prompt);
      modes.push(input.mode ?? "build");
      expect(h.listening()).toBe(true);
      if (input.prompt === "first") {
        h.send("second"); h.send("改为只做测试", true); h.send("third"); h.send("/mode plan");
        expect(h.out.join("")).toContain("Mode: plan");
        (steering as string[][]).push([...(control?.drainSteering() ?? [])]);
      }
      running = false; return snapshot;
    }), h.io)).toBe(0);
    expect(prompts).toEqual(["first", "second", "third"]);
    expect(steering).toEqual([["改为只做测试"]]);
    expect(modes).toEqual(["build", "plan", "plan"]);
    expect(h.listening()).toBe(false);
    expect(h.out.join("")).toContain("Mode: plan");
  });

  it("routes /steer with ordinary Enter into the active run, not a later prompt", async () => {
    const h = host(["first", "/quit"]);
    const prompts: string[] = [];
    let delivered: readonly string[] | undefined;
    await runCliWithIO(["chat"], service(async (input, _e, _a, _s, control) => {
      prompts.push(input.prompt);
      h.send("/steer 先停下改动\n只检查测试");
      delivered = control?.drainSteering();
      return snapshot;
    }), h.io);
    expect(delivered).toEqual(["先停下改动\n只检查测试"]);
    expect(prompts).toEqual(["first"]);
    expect(h.out.join("")).not.toContain("Command accepted");
    expect(h.out.join("")).toContain("Steer handed to the active run (1)");
  });

  it("rejects empty and idle /steer without starting a run", async () => {
    const h = host(["/steer adjust", "first", "/quit"]);
    const prompts: string[] = [];
    await runCliWithIO(["chat"], service(async (input, _e, _a, _s, control) => {
      prompts.push(input.prompt);
      h.send("/steer");
      expect(control?.drainSteering()).toEqual([]);
      return snapshot;
    }), h.io);
    expect(prompts).toEqual(["first"]);
    expect(h.out.join("")).toContain("requires an active run");
    expect(h.out.join("")).toContain("Expected /steer <message>");
  });

  it("shows and clears pending messages including steering, without dispatching them", async () => {
    const h = host(["first", "/quit"]);
    const prompts: string[] = [];
    await runCliWithIO(["chat"], service(async (input, _e, _a, _s, control) => {
      prompts.push(input.prompt);
      h.send("follow-up"); h.send("adjust", true); h.send("/queue"); h.send("/queue clear");
      expect(control?.drainSteering()).toEqual([]);
      return snapshot;
    }), h.io);
    expect(prompts).toEqual(["first"]);
    expect(h.out.join("")).toContain("follow-up");
    expect(h.out.join("")).toContain("adjust");
    expect(h.out.join("")).toContain("Queue cleared");
  });

  it("does not auto-dispatch queued messages after failure; explicit queue run resumes them", async () => {
    const h = host(["first", "/queue", "/queue run", "/quit"]);
    const prompts: string[] = [];
    await runCliWithIO(["chat"], service(async (input) => {
      prompts.push(input.prompt);
      if (input.prompt === "first") { h.send("second"); throw Error("provider failed"); }
      return snapshot;
    }), h.io);
    expect(prompts).toEqual(["first", "second"]);
    expect(h.out.join("")).toContain("paused");
  });

  it("retains late steering and dispatches it only as literal input after explicit resume", async () => {
    const h = host(["first", "/queue run", "/quit"]);
    const prompts: string[] = [];
    await runCliWithIO(["chat"], service(async (input) => {
      prompts.push(input.prompt);
      if (input.prompt === "first") h.send("late adjustment", true);
      return snapshot;
    }), h.io);
    expect(prompts).toEqual(["first", "late adjustment"]);
    expect(h.out.join("")).toContain("paused");
  });

  it("does not resume a failed queue just because a new manual prompt succeeds", async () => {
    const h = host(["first", "manual", "/queue clear", "/quit"]);
    const prompts: string[] = [];
    await runCliWithIO(["chat"], service(async (input) => {
      prompts.push(input.prompt);
      if (input.prompt === "first") { h.send("pending"); throw Error("failed"); }
      return snapshot;
    }), h.io);
    expect(prompts).toEqual(["first", "manual"]);
  });

  it("bounds the combined message queue and ignores empty steering", async () => {
    const h = host(["first", "/queue clear", "/quit"]);
    let calls = 0;
    await runCliWithIO(["chat"], service(async (_i, _e, _a, _s, control) => {
      calls++;
      h.send("   ", true); h.send("x".repeat(600_000)); h.send("y".repeat(600_000));
      h.send("z".repeat(600_000), true);
      expect(control?.drainSteering()).toEqual([]);
      return { ...snapshot, status: "cancelled" };
    }), h.io);
    expect(calls).toBe(1);
    expect(h.out.join("")).toContain("Queue limit");
  });
});

it("default full access audits all requests and live manual switch applies to subsequent calls", async () => {
  const h = host(["work", "/quit"]); const results: boolean[] = [];
  await runCliWithIO(["chat"], service(async (_i, _e, approve, signal) => {
    results.push(await approve(request, signal));
    results.push(await approve({...request, toolName: "mcp_call_tool", childSessionId:id}, signal));
    h.send("/approval manual"); results.push(await approve(request, signal));
    h.send("/approval full-access"); results.push(await approve(request, signal));
    return snapshot;
  }), h.io);
  expect(results).toEqual([true,true,false,true]);
  expect(h.readApproval).toHaveBeenCalledTimes(1);
  expect(h.out.join("")).toContain("FULL ACCESS");
  expect(h.out.join("")).toContain("3 tool request(s) auto-approved this run");
  expect(h.out.join("")).toContain("Auto-approved · run_command");
  expect(h.out.join("")).not.toContain("Auto-approved · mcp_call_tool");
  expect(h.out.join("")).not.toContain(`child ${id}`);
  expect(h.out.join("")).not.toContain(`Auto-approved run_command: [`);
});

it("manual fallback approves fresh Enter, rejects other input, and ask is an alias", async () => {
  const h = host(["work", "", "work", "maybe", "work", "no", "/quit"]);
  const {readApproval: _unused, ...plainIO} = h.io;
  const decisions: boolean[] = [];
  await runCliWithIO(["chat", "--approval", "ask"], service(async (_i, _e, approve, signal) => {
    decisions.push(await approve(request, signal)); return snapshot;
  }), plainIO);
  expect(decisions).toEqual([true,false,false]);
  expect(h.out.join("")).toContain("MANUAL");
});

it("readonly ceiling rejects full-access without asking or elevating permission", async () => {
  const h = host(["work", "/quit"]); const decisions: boolean[] = [];
  const base = service(async (_i, _e, approve, signal) => { decisions.push(await approve(request, signal)); return snapshot; });
  await runCliWithIO(["chat", "--session", id], {...base, getSession: async () => ({...snapshot, permissionCeiling: "readonly"})}, h.io);
  expect(decisions).toEqual([false]); expect(h.readApproval).not.toHaveBeenCalled();
});
