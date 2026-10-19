import { expect, it } from "vitest";
import { runCliWithIO, type CliIO } from "../../src/cli/cli";
import { planLines } from "../../src/cli/format";
import { extendedService } from "./service-fixture";
import { defaultPublicSettings, sessionSnapshotSchema } from "../../src/shared/schemas";

it("lists all independent plans through /plan with titles and IDs", async () => {
  const first = { id: "plan-a", title: "First task", explanation: "A", steps: [{ step: "A done", status: "completed" }] };
  const second = { id: "plan-b", title: "Second task", explanation: "B", steps: [{ step: "B work", status: "in_progress" }] };
  const snapshot = sessionSnapshotSchema.parse({ version: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Plans", workspace: process.cwd(), model: "fixture", status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [], events: [], changes: [], plans: [first, second], plan: second,
  });
  const input = ["/plan", "/quit"];
  const output: string[] = [];
  const errors: string[] = [];
  const io: CliIO = { isTTY: true, stdout: text => output.push(text), stderr: text => errors.push(text),
    readStdin: async () => "", question: async () => { const line = input.shift(); if (!line) throw Error("EOF"); return line; },
    onInterrupt: () => () => {},
  };
  const result = await runCliWithIO(["chat", "--session", snapshot.id], {
    ...extendedService(), getSettings: async () => ({ ...defaultPublicSettings, model: "fixture" }),
    getSession: async () => snapshot, listSessions: async () => [snapshot], run: async () => snapshot,
  }, io);
  expect(result).toBe(0);
  expect(errors).toEqual([]);
  for (const value of ["First task", "Second task", "plan-a", "plan-b", "A done", "B work"])
    expect(output.join("")).toContain(value);
  expect(planLines(null, 80).flat().map(span => span.text).join("")).toContain("No active execution plan");
});
