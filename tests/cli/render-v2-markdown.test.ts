import { expect, it } from "vitest";
import { markdownLines, MarkdownStream } from "../../src/cli/render/markdown";
import { visibleWidth, createTheme } from "../../src/cli/theme";
import { renderRichLine } from "../../src/cli/render/rich";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (lines: readonly RichLine[]) => lines.map(line => line.map(span => span.text).join("")).join("\n");

it("uses GFM for nested/task lists, six headings, emphasis, strike and references", () => {
  const source = '# Title\n\n###### Deep\n\n- parent\n  - child\n- [x] done\n- [ ] pending\n\n**bold** *emphasis* ~~removed~~ `code`\n\n[docs][ref]\n\n[ref]: https://example.com\n';
  const lines = markdownLines(source);
  const body = text(lines);
  for (const value of ["# Title", "###### Deep", "parent", "child", "[X]", "[ ]", "bold", "emphasis", "removed", "code", "https://example.com"]) expect(body).toContain(value);
  expect(body).not.toContain("**bold**");
  expect(lines.flat().some(span => span.bold && span.text.includes("bold"))).toBe(true);
});
it("renders aligned multiline CJK tables with library borders and bounded widths", () => {
  const source = '| 名称 | Value |\n| :--- | ---: |\n| 中文 | long value with spaces |\n| a\\|b | `code` |\n';
  for (const width of [20,40,80]) {
    const lines = markdownLines(source,width); const body = text(lines);
    expect(body).toContain("┌"); expect(body).toContain("中文"); expect(body).toContain("a|b");
    for (const line of lines) expect(visibleWidth(text([line]))).toBeLessThanOrEqual(width);
  }
});
it("renders fenced and indented code literally, with library highlighting", () => {
  const source = '~~~ts\nconst n = 42; // comment\n~~~\n\n    > not quote\n    ---\n';
  const lines = markdownLines(source); const body = text(lines);
  expect(body).toContain("── ts ──"); expect(body).toContain("const n = 42;");
  expect(body).toContain("> not quote"); expect(body).toContain("---");
  expect(lines.flat().some(s=>s.tone === "warning" && s.text.includes("42"))).toBe(true);
  expect(text(markdownLines('```unknown\nkeep me'))).toContain("keep me");
});
it("keeps every split equivalent at finish, including references and hostile controls", () => {
  const source = '> **quote**\n\n| A | B |\n| --- | --- |\n| one | two |\n\n[ref][id]\n\n[id]: https://example.com\n\n```js\nlet x = 1;\n```\n\x1b]52;c;EVIL\x07safe';
  const expected = markdownLines(source);
  for (let split=0;split<source.length;split++) {
    const stream = new MarkdownStream();
    expect(stream.push(source.slice(0,split)).append).toEqual([]);
    stream.push(source.slice(split)); expect(stream.finish().append).toEqual(expected);
    expect(stream.finish().append).toEqual([]);
  }
  expect(text(expected)).not.toContain("EVIL"); expect(text(expected)).not.toContain("\x1b");
});
it("never fetches images or forwards raw terminal controls, including encoded controls", () => {
  const lines = markdownLines('![alt](https://example.com/image) <script>x</script>\n\n[a](javascript:alert) &#27;[2J &#x1b;]52;c;bad&#7;');
  expect(text(lines)).toContain("[image: alt]");
  expect(text(lines)).not.toContain("\x1b");
  const plain = lines.map(line=>renderRichLine(line,createTheme({isTTY:false}))).join("\n");
  expect(plain).not.toContain("\x1b");
});
it("preserves full source above parse limit without pretending it is rendered", () => {
  const source = '# title\n' + 'text '.repeat(21000) + 'END';
  expect(text(markdownLines(source))).toBe(source);
});
