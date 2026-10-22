import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import { TerminalReader } from "../../src/cli/terminal";
import type { HarnessService } from "../../src/shared/contracts";
import { defaultPublicSettings, publicProviderSourceSchema } from "../../src/shared/schemas";
import { reviewSession } from "../fixtures/review-session";
import { extendedService } from "./service-fixture";

const snapshot = reviewSession();
function service(run: HarnessService["run"]): HarnessService {
  return {
    ...extendedService(), run,
    getSettings: async () => ({ ...defaultPublicSettings, model: "configured-model" }),
    updateSettings: async () => defaultPublicSettings, listModels: async () => [], listSessions: async () => [],
    createSession: async () => snapshot, getSession: async () => snapshot,
    compactSession: async () => snapshot, cancelSession: async () => false,
    forkSession: async () => snapshot, renameSession: async () => snapshot, archiveSession: async () => snapshot,
    getDiagnostics: async () => ({ transcriptChars: 0, projectedChars: 0, messageCount: 0, summaryFallback: false }),
    dispose: async () => {},
  };
}
function host(lines: string[]) {
  const out: string[] = [];
  let interrupt = () => {};
  let receive: ((line: string, steer?: boolean) => void) | undefined;
  const io: CliIO = {
    isTTY: true, stdout: text => out.push(text), stderr: text => out.push(text),
    readStdin: async () => { throw Error("unexpected stdin"); },
    question: async () => { const line = lines.shift(); if (line === undefined) throw Error("EOF"); return line; },
    onInterrupt: callback => { interrupt = callback; return () => { interrupt = () => {}; }; },
    onRunInput: callback => { receive = callback; return () => { receive = undefined; }; },
  };
  return { io, out, interrupt: () => interrupt(), send: (text: string) => receive?.(text) };
}

describe("/review CLI", () => {
  it("requires an existing session, without creating one or calling a model", async () => {
    const h = host(["/review", "/quit"]);
    const run = vi.fn(async () => snapshot);
    const createSession = vi.fn(async () => snapshot);
    await runCliWithIO(["chat"], { ...service(run), createSession }, h.io);
    expect(h.out.join("")).toContain("No active session");
    expect(createSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("uses the current picked model/source, denies approvals, streams findings and preserves next-run settings", async () => {
    const h = host(["/model picked-model", "/permission unrestricted", "/mode plan", "/review 检查权限边界", "follow up", "/mode build", "build again", "/quit"]);
    const approveDecisions: boolean[] = [];
    const run = vi.fn<HarnessService["run"]>(async (input, sink, approve, signal) => {
      approveDecisions.push(await approve({ id: snapshot.id, sessionId: snapshot.id, toolCallId: "write", toolName: "write_file", description: "write" }, signal));
      sink({ type: "text_delta", sessionId: snapshot.id, timestamp: snapshot.updatedAt, text: "审查结果：未发现明确问题。" });
      return { ...snapshot, model: input.model ?? snapshot.model };
    });
    const source = publicProviderSourceSchema.parse({ id: "picked-source", label: "Fixture", baseUrl: "https://fixture.invalid", model: "picked-model", hasApiKey: false, revision: 1 });
    const s = { ...service(run), getSettings: async () => ({ ...defaultPublicSettings, model: "configured-model", providerSources: [source] }) };
    expect(await runCliWithIO(["chat", "--session", snapshot.id], s, h.io)).toBe(0);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ sessionId: snapshot.id, model: "picked-model", providerSourceId: "picked-source", permission: "readonly", mode: "build" });
    expect(run.mock.calls[0]?.[0].prompt).toContain("检查权限边界");
    expect(run.mock.calls[0]?.[0].prompt).toContain("src/example.ts");
    expect(run.mock.calls[1]?.[0]).toMatchObject({ prompt: "follow up", mode: "plan", permission: "unrestricted" });
    expect(run.mock.calls[2]?.[0]).toMatchObject({ prompt: "build again", mode: "build", permission: "unrestricted" });
    expect(approveDecisions).toEqual([false, false, true]);
    expect(h.out.join("")).toContain("Review: picked-model (readonly");
    expect(h.out.join("")).toContain("审查结果");
  });

  it("defers a busy /review and fetches the completed session's new changes", async () => {
    const h = host(["make a change", "/quit"]);
    const latest = reviewSession({ changes: [{ path: "just-created.ts", kind: "created" }] });
    const run = vi.fn<HarnessService["run"]>(async (input) => {
      if (input.prompt === "make a change") h.send("/review");
      return latest;
    });
    const getSession = vi.fn(async () => latest);
    await runCliWithIO(["chat"], { ...service(run), getSession }, h.io);
    expect(run).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledWith(snapshot.id);
    expect(run.mock.calls[1]?.[0]).toMatchObject({ model: "configured-model", permission: "readonly" });
    expect(run.mock.calls[1]?.[0].prompt).toContain("just-created.ts");
    expect(h.out.join("")).toContain("will execute after the current run");
  });

  it("cancels preparation without dispatching or replaying a review", async () => {
    const h = host(["/new", "/review", "/help", "/quit"]);
    const run = vi.fn(async () => snapshot);
    const getSession = vi.fn(() => new Promise<typeof snapshot>(() => { queueMicrotask(h.interrupt); }));
    await runCliWithIO(["chat"], { ...service(run), getSession }, h.io);
    expect(run).not.toHaveBeenCalled();
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(h.out.join("")).toContain("cancelled");
    expect(h.out.join("")).toContain("/review");
  });

  it("uses ordinary cancellation while reviewing and does not retry a failed run", async () => {
    const h = host(["/new", "/review", "/review", "/quit"]);
    let attempts = 0;
    const run = vi.fn<HarnessService["run"]>(async (_input, _sink, _approve, signal) => {
      if (++attempts === 1) {
        h.interrupt();
        expect(signal.aborted).toBe(true);
        return { ...snapshot, status: "cancelled" };
      }
      throw Error("review provider unavailable");
    });
    await runCliWithIO(["chat"], service(run), h.io);
    expect(run).toHaveBeenCalledTimes(2);
    // Non-Forge provider errors remain sanitized by the existing CLI handler.
    expect(h.out.join("")).toContain("internal: An unexpected failure occurred.");
  });

  it("completes and submits /review through the rendered terminal input", async () => {
    const input = Object.assign(new PassThrough(), { isRaw: false, setRawMode() { return this; } });
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 24 });
    const chunks: string[] = [];
    output.on("data", chunk => chunks.push(String(chunk)));
    const reader = new TerminalReader({ input, output, isTTY: true });
    try {
      await reader.ui.configure({ theme: "dark" });
      const submitted = reader.question("❯ ", new AbortController().signal);
      input.write("/rev");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(chunks.join("")).toContain("/review");
      input.write("\r");
      expect(await submitted).toBe("/review");
    } finally { reader.dispose(); }
  });
});
