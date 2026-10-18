import { describe, expect, it, vi } from "vitest";
import { type CliIO, runCliWithIO } from "../../src/cli/cli";
import { pickSession } from "../../src/cli/interactive/pickers";
import type { HarnessService } from "../../src/shared/contracts";
import { parseSessionId, sessionSummarySchema } from "../../src/shared/schemas";
import { isPrimarySession } from "../../src/shared/sessions";
import { createSlashActions } from "../../src/shared/slash-actions";

const parentId = parseSessionId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const parent = sessionSummarySchema.parse({
  version: 1, id: parentId, title: "Main session", workspace: "/tmp/project", model: "test",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", status: "completed",
});
const child = sessionSummarySchema.parse({ ...parent,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "Agent: internal task", parentSessionId: parentId,
});
const archived = sessionSummarySchema.parse({ ...parent,
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", title: "Archived main session", archived: true,
});
const sessions = [child, parent, archived];
const service = { listSessions: async () => sessions } as HarnessService;
const host = () => {
  const stdout = vi.fn();
  const io: CliIO = {
    stdout, stderr: vi.fn(), isTTY: false, readStdin: async () => "", question: async () => "",
    onInterrupt: () => () => {},
  };
  return { io, stdout };
};

describe("ordinary session lists", () => {
  it("identifies children by relationship, not title or status", () => {
    expect(sessions.filter(isPrimarySession)).toEqual([parent, archived]);
    const userNamedSession = { ...parent, title: "Agent: user title" };
    expect(isPrimarySession(userNamedSession)).toBe(true);
    expect(sessions).toEqual([child, parent, archived]);
  });

  it.each([[], ["--json"]])("filters the sessions command with flags %j", async (...flags) => {
    const { io, stdout } = host();
    expect(await runCliWithIO(["sessions", ...flags], service, io)).toBe(0);
    const text = stdout.mock.calls.flat().join("");
    expect(text).toContain(parent.title);
    expect(text).toContain(archived.title);
    expect(text).not.toContain(child.title);
  });

  it("filters shared /sessions output without changing the service catalog", async () => {
    expect(await createSlashActions(service).sessions()).toEqual([parent, archived]);
    expect(await service.listSessions()).toEqual(sessions);
  });

  it("filters the resume picker, including its plain-text fallback", async () => {
    const { io, stdout } = host();
    await pickSession(service, io, parentId, new AbortController().signal);
    const text = stdout.mock.calls.flat().join("");
    expect(text).toContain(parentId);
    expect(text).not.toContain(child.id);
  });

  it("shows the empty state when only children exist", async () => {
    const { io, stdout } = host();
    const onlyChildren = { ...service, listSessions: async () => [child] };
    expect(await pickSession(onlyChildren, io, parentId, new AbortController().signal)).toBeNull();
    expect(stdout).toHaveBeenCalledWith("No sessions available.\n");
  });
});
