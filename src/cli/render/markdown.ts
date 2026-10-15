import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight, supportsLanguage } from "cli-highlight";
import type { RichLine, Span } from "../ui-contract";
import { ControlFilter, sanitizeText } from "./sanitize";
import { plainLines, wrapRichLines } from "./rich";
import { visibleWidth } from "../theme";
import { MarkdownCache } from "./markdown-cache";

const completedCache = new MarkdownCache();

const PARSE_LIMIT = 100_000;
const identity = (text: string): string => text;
// Styling callbacks belong to this adapter, not model text. Only the controller
// eventually emits terminal escapes; the library output is decoded to RichLine.
const style = (open: number, close: number) => (text: string): string =>
  `\u001b[${open}m${text}\u001b[${close}m`;

function terminalLines(rendered: string): RichLine[] {
  const lines: Span[][] = [[]];
  let bold = false;
  let tone: Span["tone"];
  let cursor = 0;
  const append = (value: string): void => {
    const chunks = sanitizeText(value).split("\n");
    chunks.forEach((text, index) => {
      if (index) lines.push([]);
      const line = lines.at(-1);
      if (text && line) line.push({ text, ...(bold ? { bold } : {}), ...(tone ? { tone } : {}) });
    });
  };
  // Only SGR is interpreted, and only a bounded subset. OSC/cursor operations
  // from a dependency or entity-decoded input are stripped, never forwarded.
  for (const match of rendered.matchAll(/\u001b\[([\d;]*)m/g)) {
    append(rendered.slice(cursor, match.index));
    for (const code of (match[1] || "0").split(";").map(Number)) {
      if (code === 0) { bold = false; tone = undefined; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) tone = undefined;
      else if (code === 31 || code === 91) tone = "error";
      else if (code === 32 || code === 92) tone = "success";
      else if (code === 33 || code === 93) tone = "warning";
      else if ([34, 35, 36, 94, 95, 96].includes(code)) tone = "accent";
      else if (code === 2 || code === 90) tone = "muted";
    }
    cursor = match.index + match[0].length;
  }
  append(rendered.slice(cursor));
  while (lines.length && lines.at(-1)?.length === 0) lines.pop();
  return lines;
}

/** Markdown syntax and terminal layout are provided by marked/marked-terminal. */
export function markdownLines(source: string, columns = 80, cache = true): RichLine[] {
  const clean = sanitizeText(source);
  const width = Math.max(1, Math.min(500, Math.floor(columns) || 80));
  if (clean.length > PARSE_LIMIT) return [...plainLines(clean)];
  const key = `${width}:${clean}`;
  const hit = cache ? completedCache.get(key) : undefined;
  if (hit) return hit;
  // @types/marked-terminal describes the older renderer class return type;
  // v7 returns a MarkedExtension. The runtime API is tested below/in fixtures.
  const tableOptions: { style: { head: string[]; border: string[] }; wordWrap: boolean; colWidths?: number[]; colAligns?: ("left" | "center" | "right")[] } = { style: { head: [], border: [] }, wordWrap: true };
  const extension = markedTerminal({
    width, reflowText: false, tab: 2, emoji: false,
    code: style(33, 39), blockquote: style(90, 39),
    html: identity, heading: style(1, 22), firstHeading: style(1, 22),
    hr: identity, listitem: identity, table: identity, paragraph: identity,
    strong: style(1, 22), em: style(36, 39), codespan: style(33, 39),
    del: style(90, 39), link: identity, href: style(36, 39), text: identity,
    tableOptions,
  }) as unknown as MarkedExtension;
  const parser = new Marked(extension, { gfm: true, breaks: false });
  const tableRenderer = extension.renderer?.table;
  parser.use({ renderer: {
    table(token) {
      const count = token.header.length;
      if (!count || count > 12) return `${sanitizeText(token.raw)}\n`;
      const cellWidth = Math.max(1, Math.floor((width - 5) / count) - 3);
      const headers = token.header.map(cell => this.parser.parseInline(cell.tokens));
      const rows = token.rows.map(row => row.map(cell => this.parser.parseInline(cell.tokens)));
      const tooTall = [...headers, ...rows.flat()].some(cell =>
        sanitizeText(cell).split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(visibleWidth(line) / cellWidth)), 0) > 4);
      if (width < count * 8 + 5 || tooTall) {
        if (!rows.length) return `${headers.join("\n")}\n`;
        return rows.map((row, index) => `Row ${index + 1}\n${headers.map((header, column) =>
          `  ${header || `Column ${column + 1}`}: ${row[column] ?? ""}`).join("\n")}`).join("\n\n") + "\n\n";
      }
      tableOptions.colWidths = Array.from({ length: count }, () => Math.floor((width - 5) / count));
      tableOptions.colAligns = token.align.map(align => align ?? "left");
      return tableRenderer ? tableRenderer.call(this, token) : false;
    },
    code(token) {
      const language = sanitizeText(token.lang ?? "text").split(/\s/)[0] || "text";
      let code = sanitizeText(token.text);
      if (code.length <= 60000 && supportsLanguage(language)) {
        try {
          code = highlight(code, { language, ignoreIllegals: true, theme: {
            keyword: style(36, 39), string: style(32, 39), number: style(33, 39),
            comment: style(90, 39), literal: style(35, 39), default: identity,
          } });
        } catch { /* Unknown language remains lossless plain code. */ }
      }
      return `\n${style(90, 39)(`── ${language.slice(0, 40)} ──`)}\n${code.split("\n").map(line => `  ${line}`).join("\n")}\n\n`;
    },
    // Do not emit OSC8, fetch images or interpret raw HTML. Links remain useful
    // as visible text regardless of terminal hyperlink detection/environment.
    link(token) {
      const label = this.parser.parseInline(token.tokens);
      return label === token.href ? label : `${label} (${sanitizeText(token.href)})`;
    },
    image(token) { return `[image: ${sanitizeText(token.text)}]`; },
    html(token) { return sanitizeText(token.text); },
    hr() { return `${"─".repeat(Math.min(width, 40))}\n\n`; },
  } });
  try {
    const rendered = parser.parse(clean, { async: false });
    const lines = [...wrapRichLines(terminalLines(rendered), width)];
    if (cache) completedCache.set(key, lines);
    return lines;
  } catch {
    // Malformed/deep input or dependency failure must not lose the source.
    return [...plainLines(clean)];
  }
}

/** Compatibility entry for callers rendering a single inline/block sample. */
export const renderMarkdownLine = (line: string, fenced: boolean): RichLine =>
  fenced ? [{ text: sanitizeText(line) }] : markdownLines(line).flatMap((row, index) =>
    index ? [{ text: "\n" }, ...row] : [...row]);

/** Hold the current message until its boundary so later reference definitions,
 * table delimiters and nested lists can reparse earlier text correctly. */
export class MarkdownStream {
  private readonly filter = new ControlFilter();
  private source = "";
  private rendered: RichLine[] = [];
  constructor(private readonly width: () => number = () => 80) {}

  push(chunk: string): { append: RichLine[]; tail: RichLine[] } {
    this.source += this.filter.push(chunk);
    // Core already coalesces text deltas (80ms / 8192 chars). Always render the
    // latest delivered delta; a second timerless throttle could hide its suffix.
    // Streaming prefixes never enter the completed-message LRU.
    this.rendered = markdownLines(this.source, this.width(), false);
    return { append: [], tail: this.rendered };
  }

  finish(): { append: RichLine[]; tail: RichLine[] } {
    this.source += this.filter.finish();
    const append = this.source ? markdownLines(this.source, this.width()) : [];
    this.source = "";
    this.rendered = [];
    return { append, tail: [] };
  }
}
