import { expect, it } from "vitest";
import { toolPresentation } from "../../src/cli/render/tool-presentation";
const result = (value: unknown) => ({ content: JSON.stringify(value), isError: false });
it("distinguishes conditional read omission from empty file content", () => {
  expect(toolPresentation("read_file", result({ unchanged: true, content: "", total_lines: 40, offset: 0 })).detail).toContain("omit if_version");
});
it("summarizes background and semantic results without dumping captured output", () => {
  expect(toolPresentation("run_command", result({ id: "task", background: true, status: "running" })).detail).toContain("Task task · running");
  expect(toolPresentation("command_task", result({ tasks: [{ id: "task" }], pending_ids: ["task"] })).detail).toBe("1 tasks · 1 pending");
  const failed = toolPresentation("command_task", result({ id: "task", status: "failed", exit_code: 1, output: "PRIVATE OUTPUT", total_chars: 14 }));
  expect(failed.failed).toBe(true); expect(failed.detail).not.toContain("PRIVATE");
  const semantic = toolPresentation("lsp", result({ operation: "hover", path: "a.ts", items: [{ text: "PRIVATE HOVER" }] }));
  expect(semantic.detail).toBe("hover · a.ts · 1 results");
});
it("shows scan and captured-output incompleteness independently from pagination", () => {
  expect(toolPresentation("search_files", result({ matches: [], scan_truncated: true })).warning).toContain("scan incomplete");
  expect(toolPresentation("command_task", result({ id: "task", output_truncated: true })).warning).toContain("captured output incomplete");
});
