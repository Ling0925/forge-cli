import { expect, it, vi } from "vitest";
import { MarkdownCache } from "../../src/cli/render/markdown-cache";
import { markdownLines, MarkdownStream } from "../../src/cli/render/markdown";
import { visibleWidth } from "../../src/cli/theme";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (lines: readonly RichLine[]) => lines.map(line => line.map(s => s.text).join("")).join("\n");
const table = "| 功能 | 状态 | 说明 |\n| --- | --- | --- |\n| 高亮 | 完成 | 中文😀 |\n| 表格 | 测试 | 保留 |";
it("bounds cache by entries and cost, updates LRU and isolates returned arrays", () => {
  const cache = new MarkdownCache(2, 500);
  const lines = [[{ text: "original" }]];
  cache.set("a", lines); lines[0]![0]!.text = "mutated";
  cache.set("b", [[{ text: "b" }]]);
  const hit = cache.get("a"); expect(text(hit ?? [])).toBe("original");
  hit?.splice(0); expect(text(cache.get("a") ?? [])).toBe("original");
  cache.set("c", [[{ text: "c" }]]); expect(cache.get("b")).toBeUndefined();
  expect(cache.size).toBe(2); expect(cache.retainedCost).toBeLessThanOrEqual(500);
  cache.set("huge", [[{ text: "x".repeat(1000) }]]); expect(cache.get("huge")).toBeUndefined();
  const bytes = new MarkdownCache(100, 300);
  for (let i = 0; i < 30; i++) bytes.set(String(i), [[{ text: "value" }]]);
  expect(bytes.retainedCost).toBeLessThanOrEqual(300); expect(bytes.size).toBeLessThan(3);
});
it("uses vertical key/value tables when narrow or overly tall without losing cells", () => {
  for (const width of [8, 16, 24]) {
    const lines = markdownLines(table, width);
    expect(text(lines)).toContain("Row 1"); expect(text(lines)).toContain("Row 2");
    expect(text(lines).replaceAll("\n", "")).toContain("中文😀");
    expect(text(lines)).toContain("保留");
    for (const line of lines) expect(visibleWidth(text([line]))).toBeLessThanOrEqual(width);
  }
  expect(text(markdownLines(table, 100))).toContain("┌");
  const tall = `| Name | Value |\n| --- | --- |\n| X | ${"long ".repeat(50)}END |`;
  expect(text(markdownLines(tall, 80))).toContain("Row 1");
  expect(text(markdownLines(tall, 80))).toContain("END");
});
it("keys completed renders by width, skips streaming prefixes and keeps sanitation", () => {
  const set = vi.spyOn(MarkdownCache.prototype, "set");
  try {
    const source = table + "\n\nunique-cache-test\x1b]52;c;bad\x07";
    const stream = new MarkdownStream(() => 24);
    stream.push(source.slice(0, 30)); stream.push(source.slice(30));
    expect(set).not.toHaveBeenCalled();
    const rendered = stream.finish().append; expect(set).toHaveBeenCalledTimes(1);
    expect(rendered).toEqual(markdownLines(source, 24)); expect(set).toHaveBeenCalledTimes(1);
    markdownLines(source, 100); expect(set).toHaveBeenCalledTimes(2);
    expect(text(rendered)).not.toContain("bad"); expect(text(rendered)).not.toContain("\x1b");
  } finally { set.mockRestore(); }
});
