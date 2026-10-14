import { describe, expect, it } from "vitest";
import {
  MarkdownStream,
  renderMarkdownLine,
} from "../../src/cli/render/markdown";
import type { RichLine } from "../../src/cli/ui-contract";

const text = (lines: readonly RichLine[]): string =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

const render = (source: string): RichLine[] => {
  const stream = new MarkdownStream();
  const first = stream.push(source);
  const done = stream.finish();
  return [...first.append, ...done.append];
};

const renderSplit = (source: string, size: number): RichLine[] => {
  const stream = new MarkdownStream();
  const lines: RichLine[] = [];
  for (let index = 0; index < source.length; index += size) {
    lines.push(...stream.push(source.slice(index, index + size)).append);
  }
  lines.push(...stream.finish().append);
  return lines;
};

describe("CLI markdown blockquotes", () => {
  it("renders quote markers as muted quote bars and preserves inline spans", () => {
    const line = renderMarkdownLine("> quoted `code` and **bold**", false);
    expect(line[0]).toMatchObject({ text: "│ ", tone: "muted" });
    expect(text([line])).toBe("│ quoted code and bold");
    expect(line).toContainEqual({ text: "code", tone: "accent" });
    expect(line).toContainEqual({ text: "bold", tone: "accent" });
  });

  it("does not parse quote markers inside fenced code", () => {
    const body = text(render("```md\n> quoted\n```\n"));
    expect(body).toBe("> quoted");
    expect(body).not.toContain("│ quoted");
  });

  it("filters hostile terminal controls in quoted text", () => {
    const body = text(render("> safe\u001b]52;c;AAAA\u0007after\n"));
    expect(body).toBe("│ safeafter");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("]52");
  });

  it("keeps quote rendering stable when split across chunks", () => {
    expect(text(renderSplit("> split `code`\n", 1))).toBe("│ split code");
  });
});

describe("CLI markdown horizontal rules", () => {
  it("renders common horizontal rule markers", () => {
    expect(renderMarkdownLine("---", false)).toEqual([
      { text: "────────", tone: "muted" },
    ]);
    expect(renderMarkdownLine("  ***  ", false)).toEqual([
      { text: "────────", tone: "muted" },
    ]);
    expect(renderMarkdownLine("___", false)).toEqual([
      { text: "────────", tone: "muted" },
    ]);
  });

  it("does not parse horizontal rules inside fenced code", () => {
    const body = text(render("```md\n---\n```\n"));
    expect(body).toBe("---");
    expect(body).not.toContain("────────");
  });

  it("does not let controls adjacent to rules inject terminal sequences", () => {
    const body = text(render("---\u001b[31m\nnext\n"));
    expect(body).toBe("────────\nnext");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("[31m");
  });

  it("keeps rule rendering stable when split across chunks", () => {
    expect(text(renderSplit("---\n", 1))).toBe("────────");
  });
});

describe("CLI markdown GFM tables", () => {
  it("renders a basic table with a styled header and muted cell borders", () => {
    const lines = render("| Name | Value |\n| --- | --- |\n| one | `two` |\n");
    expect(text(lines)).toBe("│ Name │ Value │\n│ one │ two │");
    expect(lines[0]?.[0]).toMatchObject({ text: "│ ", tone: "muted" });
    expect(lines[0]?.find((span) => span.text === "Name")).toMatchObject({
      tone: "accent",
      bold: true,
    });
    expect(lines[1]?.find((span) => span.text === "two")).toMatchObject({
      tone: "accent",
    });
  });

  it("does not parse tables inside fenced code", () => {
    const body = text(render("```md\n| A | B |\n| --- | --- |\n```\n"));
    expect(body).toBe("| A | B |\n| --- | --- |");
    expect(body).not.toContain("│ A │ B │");
  });

  it("filters hostile controls from table cells before parsing", () => {
    const body = text(
      render(
        "| A | B |\n| --- | --- |\n| safe\u001b]8;;http://x\u0007 | after |\n",
      ),
    );
    expect(body).toBe("│ A │ B │\n│ safe │ after │");
    expect(body).not.toContain("\u001b");
    expect(body).not.toContain("]8");
  });

  it("recognizes a table when the header and delimiter are split across chunks", () => {
    const body = text(renderSplit("| A | B |\n| --- | --- |\n| 1 | 2 |\n", 3));
    expect(body).toBe("│ A │ B │\n│ 1 │ 2 │");
  });

  it("flushes a pipe-containing non-table line without losing text", () => {
    expect(text(render("ordinary | text\nnext\n"))).toBe(
      "ordinary | text\nnext",
    );
  });
});

it("does not discard extra table cells or reinterpret complex pipes", () => {
  const prefix = "| a | b |\n| --- | --- |\n";
  expect(text(render(`${prefix}| one | two | KEEP |\n`))).toContain("KEEP");
  expect(text(render(`${prefix}| a\\|b | KEEP |\n`))).toContain("a\\|b");
  expect(text(render(`${prefix}| \`a|b\` | KEEP |\n`))).toContain("a|b");
  expect(text(render(`${prefix}> quote | KEEP\n`))).toContain("│ quote | KEEP");
});
