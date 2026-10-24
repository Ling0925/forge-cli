import { expect, it } from "vitest";
import { toolPresentation } from "../../src/cli/render/tool-presentation";
const result = (value: unknown) => ({ content: JSON.stringify(value), isError: false });
it("distinguishes conditional read omission from empty file content", () => {
  expect(toolPresentation("read_file", result({ unchanged: true, content: "", total_lines: 40, offset: 0 })).detail).toContain("省略 if_version");
});
it("summarizes background and semantic results without dumping captured output", () => {
  expect(toolPresentation("run_command", result({ id: "task", background: true, status: "running" })).detail).toContain("任务 task · running");
  expect(toolPresentation("command_task", result({ tasks: [{ id: "task" }], pending_ids: ["task"] })).detail).toBe("1 个任务 · 1 个待完成");
  const failed = toolPresentation("command_task", result({ id: "task", status: "failed", exit_code: 1, output: "PRIVATE OUTPUT", total_chars: 14 }));
  expect(failed.failed).toBe(true); expect(failed.detail).not.toContain("PRIVATE");
  const semantic = toolPresentation("lsp", result({ operation: "hover", path: "a.ts", items: [{ text: "PRIVATE HOVER" }] }));
  expect(semantic.detail).toBe("hover · a.ts · 1 条结果");
});
it("shows scan and captured-output incompleteness independently from pagination", () => {
  expect(toolPresentation("search_files", result({ matches: [], scan_truncated: true })).warning).toContain("扫描不完整");
  expect(toolPresentation("command_task", result({ id: "task", output_truncated: true })).warning).toContain("捕获输出不完整");
});
