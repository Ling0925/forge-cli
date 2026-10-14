import type { RichLine, Span } from "../ui-contract";
import { ControlFilter } from "./sanitize";

const fence = /^```([A-Za-z0-9_-]*)\s*$/;
const heading = /^(#{1,3}) (.*)$/;
const quote = /^> ?(.*)$/;
const horizontalRule = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const bullet = /^[-*] (.*)$/;
const ordered = /^(\d+)\. (.*)$/;
const tableDelimiterCell = /^:?-{3,}:?$/;

const span = (text: string, tone?: Span["tone"], bold?: boolean): Span => ({
  text,
  ...(tone ? { tone } : {}),
  ...(bold ? { bold } : {}),
});

const inline = (text: string, codeTone: Span["tone"]): Span[] => {
  const parts: Span[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const found = match[0];
    const index = match.index ?? 0;
    if (index > cursor) parts.push(span(text.slice(cursor, index)));
    if (found.startsWith("`")) parts.push(span(found.slice(1, -1), codeTone));
    else parts.push(span(found.slice(2, -2), "accent"));
    cursor = index + found.length;
  }
  if (cursor < text.length) parts.push(span(text.slice(cursor)));
  return parts.length ? parts : [span("")];
};

const tableCells = (line: string): string[] | null => {
  // Complex escaped/code-span pipes stay readable as source rather than being
  // split into the wrong cells. This is a bounded subset, not a GFM parser.
  if (
    !line.includes("|") ||
    line.includes("\\|") ||
    /`[^`]*\|[^`]*`/.test(line)
  )
    return null;
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  const cells = trimmed.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
};

const tableDelimiterColumns = (line: string): number | null => {
  const cells = tableCells(line);
  if (!cells?.length) return null;
  return cells.every((cell) => tableDelimiterCell.test(cell))
    ? cells.length
    : null;
};

const tableHeaderCandidate = (line: string): boolean =>
  !quote.test(line) &&
  !heading.test(line) &&
  !bullet.test(line) &&
  !ordered.test(line) &&
  !horizontalRule.test(line) &&
  tableCells(line) !== null &&
  tableDelimiterColumns(line) === null;

const normalizedTableCells = (
  cells: readonly string[],
  columns: number,
): string[] => {
  const normalized = cells.slice(0, columns);
  while (normalized.length < columns) normalized.push("");
  return normalized;
};

const withHeaderStyle = (parts: Span[]): Span[] =>
  parts.map((part) => ({
    ...part,
    tone: part.tone ?? "accent",
    bold: true,
  }));

const tableRow = (
  cells: readonly string[],
  columns: number,
  header: boolean,
): RichLine => {
  const line: Span[] = [span("│ ", "muted")];
  normalizedTableCells(cells, columns).forEach((cell, index) => {
    const parts = inline(cell, "accent");
    line.push(...(header ? withHeaderStyle(parts) : parts));
    line.push(span(index === columns - 1 ? " │" : " │ ", "muted"));
  });
  return line;
};

export const renderMarkdownLine = (line: string, fenced: boolean): RichLine => {
  if (fenced) {
    const parts: Span[] = [];
    let cursor = 0;
    for (const match of line.matchAll(
      /\b(?:const|let|return|function|class|import|export|if|else|def|true|false|null)\b/g,
    )) {
      const index = match.index;
      if (index > cursor) parts.push(span(line.slice(cursor, index)));
      parts.push(span(match[0], "accent"));
      cursor = index + match[0].length;
    }
    parts.push(span(line.slice(cursor)));
    return parts;
  }
  const quotation = quote.exec(line);
  if (quotation?.[1] !== undefined) {
    return [span("│ ", "muted"), ...inline(quotation[1], "accent")];
  }
  const title = heading.exec(line);
  if (title?.[1] && title[2] !== undefined) {
    const mark = title[1].length === 1 ? "#" : title[1];
    return [span(`${mark} ${title[2]}`, "accent", true)];
  }
  if (horizontalRule.test(line)) return [span("────────", "muted")];
  const item = bullet.exec(line);
  if (item?.[1] !== undefined)
    return [span("• "), ...inline(item[1], "accent")];
  const number = ordered.exec(line);
  if (number?.[1] && number[2] !== undefined) {
    return [span(`${number[1]}. `, "muted"), ...inline(number[2], "accent")];
  }
  return inline(line, "accent");
};

export class MarkdownStream {
  private readonly filter = new ControlFilter();
  private pending = "";
  private fenced = false;
  private queuedLine: string | null = null;
  private tableColumns = 0;

  push(chunk: string): { append: RichLine[]; tail: RichLine[] } {
    this.pending += this.filter.push(chunk).replace(/\r/g, "");
    const append: RichLine[] = [];
    while (true) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0) break;
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.processLine(line, append);
    }
    return { append, tail: this.tail() };
  }

  finish(): { append: RichLine[]; tail: RichLine[] } {
    this.pending += this.filter.finish();
    const append: RichLine[] = [];
    if (this.pending) {
      this.processLine(this.pending, append);
      this.pending = "";
    }
    this.flushQueued(append);
    this.fenced = false;
    this.tableColumns = 0;
    return { append, tail: [] };
  }

  private processLine(line: string, append: RichLine[]): void {
    if (fence.test(line.trim())) {
      this.flushQueued(append);
      this.tableColumns = 0;
      this.fenced = !this.fenced;
      return;
    }
    if (this.fenced) {
      append.push(renderMarkdownLine(line, true));
      return;
    }

    const delimiterColumns = tableDelimiterColumns(line);
    if (this.queuedLine !== null) {
      const headerCells = tableCells(this.queuedLine);
      if (
        delimiterColumns !== null &&
        headerCells !== null &&
        headerCells.length === delimiterColumns
      ) {
        append.push(tableRow(headerCells, delimiterColumns, true));
        this.queuedLine = null;
        this.tableColumns = delimiterColumns;
        return;
      }
      this.flushQueued(append);
    }

    if (this.tableColumns > 0) {
      const cells = tableCells(line);
      if (
        cells !== null &&
        cells.length <= this.tableColumns &&
        tableHeaderCandidate(line)
      ) {
        append.push(tableRow(cells, this.tableColumns, false));
        return;
      }
      this.tableColumns = 0;
    }

    if (tableHeaderCandidate(line)) {
      this.queuedLine = line;
      return;
    }
    append.push(renderMarkdownLine(line, false));
  }

  private flushQueued(append: RichLine[]): void {
    if (this.queuedLine === null) return;
    append.push(renderMarkdownLine(this.queuedLine, false));
    this.queuedLine = null;
  }

  private tail(): RichLine[] {
    const tail: RichLine[] = [];
    if (this.queuedLine !== null) {
      tail.push(renderMarkdownLine(this.queuedLine, false));
    }
    if (this.pending) tail.push([span(this.pending, "muted")]);
    return tail;
  }
}
