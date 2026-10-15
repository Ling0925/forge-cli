import { expect, it } from "vitest";
import { toolSummaryLines } from "../../src/cli/render/tools";
import type { ToolCall } from "../../src/shared/schemas";

const text = (rows: readonly (readonly { text: string }[])[]) =>
  rows.map((row) => row.map((span) => span.text).join("")).join("\n");
const command = (argv: readonly string[]): ToolCall => ({
  id: "t",
  type: "function",
  function: { name: "run_command", arguments: JSON.stringify({ argv }) },
});
const done = (stdout = "ok", exit_code = 0) => ({
  content: JSON.stringify({ stdout, exit_code }),
  isError: false,
});
const long = [
  "node",
  "scripts/qa-cli-terminal.mjs",
  "--cli",
  "dist/cli.mjs",
  "--suite",
  "v2",
  "--cols",
  "80",
  "--themes",
  "dark",
];

it("wraps a long run_command onto a hanging branch with status and exit on the header", () => {
  for (const width of [80, 40]) {
    const rows = toolSummaryLines(command(long), done(), width);
    const header = text([rows[0]!]);
    expect(header).toContain("run_command");
    expect(header).toContain("done");
    expect(header).toContain("exit 0");
    expect(header).not.toContain("…");
    // The command is split across branch rows instead of being squeezed away.
    const body = text(rows);
    expect(body).toContain("scripts/qa-cli-terminal.mjs");
    expect(body).toContain("--themes dark");
    expect(body.split("\n").length).toBeGreaterThan(2);
    // Every non-header row belongs to the branch: middle rows use │, the last ╰.
    for (const row of rows.slice(1)) {
      const first = row[0]?.text ?? "";
      expect(first.startsWith("  │ ") || first.startsWith("  ╰ ")).toBe(true);
    }
    expect(rows.at(-1)?.[0]?.text.startsWith("  ╰ ")).toBe(true);
  }
});

it("keeps a short run_command on one header line", () => {
  const rows = toolSummaryLines(command(["ls", "-la"]), done(), 80);
  const header = text([rows[0]!]);
  expect(header).toContain("run_command ls -la");
  expect(header.endsWith("· done · exit 0")).toBe(true);
  expect(text(rows)).not.toContain("│ ls");
});

it("falls back to a single compact line on very narrow terminals", () => {
  const rows = toolSummaryLines(command(long), done(), 20);
  expect(rows.length).toBeLessThanOrEqual(3);
  expect(text([rows[0]!])).toContain("…");
});
