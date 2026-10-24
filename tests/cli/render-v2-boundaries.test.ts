import { describe, expect, it } from "vitest";
import { MarkdownStream } from "../../src/cli/render/markdown";
import { wrapRichLines } from "../../src/cli/render/rich";
import { ControlFilter } from "../../src/cli/render/sanitize";
import { toolFinishLines } from "../../src/cli/render/tools";
import { visibleWidth } from "../../src/cli/theme";
import type { RichLine } from "../../src/cli/ui-contract";

const text = (lines: readonly RichLine[]): string =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

describe("v2 incremental boundaries", () => {
  it("handles fences and inline delimiters split at every byte boundary", () => {
    const stream = new MarkdownStream();
    const source = "# 标题\n- `中文🙂`\n```ts\nconst x = 1;\n```\nend";
    const finalized: RichLine[] = [];
    for (const symbol of source) finalized.push(...stream.push(symbol).append);
    finalized.push(...stream.finish().append);
    expect(text(finalized)).toContain("中文🙂");
    expect(text(finalized).match(/const x/g)).toHaveLength(1);
    expect(text(finalized)).toContain("end");
    expect(stream.finish().append).toEqual([]);
  });

  it("drops split CSI and OSC ST, including long unterminated payloads", () => {
    const filter = new ControlFilter();
    expect(filter.push("safe\u001b[")).toBe("safe");
    expect(filter.push("31mred\u001b]52;c;")).toBe("red");
    expect(filter.push("x".repeat(100000))).toBe("");
    expect(filter.push("\u001b")).toBe("");
    expect(filter.push("\\ok\r")).toBe("ok");
  });

  it("terminates on one-column CJK wrapping and preserves ordinary graphemes", () => {
    expect(text(wrapRichLines([[{ text: "中🙂a" }]], 1))).toBe("�\n�\na");
    const lines = wrapRichLines([[{ text: "é🇨🇳👩‍💻中文", tone: "accent" }]], 4);
    expect(lines.every((line) => visibleWidth(text([line])) <= 4)).toBe(true);
    expect(text(lines).replaceAll("\n", "")).toBe("é🇨🇳👩‍💻中文");
  });

  it("shows stderr even with stdout and does not call nonzero exits success", () => {
    const lines = toolFinishLines(undefined, {
      content: JSON.stringify({
        stdout: "out",
        stderr: "error reason",
        exit_code: 9,
      }),
      isError: false,
    });
    expect(text(lines)).toContain("failed · exit 9");
    expect(text(lines)).toContain("error reason");
  });
});
