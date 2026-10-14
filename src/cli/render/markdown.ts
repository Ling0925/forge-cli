import type { RichLine, Span } from "../ui-contract";
import { ControlFilter } from "./sanitize";

const fence = /^```([A-Za-z0-9_-]*)\s*$/;
const heading = /^(#{1,3}) (.*)$/;
const bullet = /^[-*] (.*)$/;
const ordered = /^(\d+)\. (.*)$/;

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
  const title = heading.exec(line);
  if (title?.[1] && title[2] !== undefined) {
    const mark = title[1].length === 1 ? "#" : title[1];
    return [span(`${mark} ${title[2]}`, "accent", true)];
  }
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

  push(chunk: string): { append: RichLine[]; tail: RichLine[] } {
    this.pending += this.filter.push(chunk).replace(/\r/g, "");
    const append: RichLine[] = [];
    while (true) {
      const nl = this.pending.indexOf("\n");
      if (nl < 0) break;
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      if (fence.test(line.trim())) {
        this.fenced = !this.fenced;
        continue;
      }
      append.push(renderMarkdownLine(line, this.fenced));
    }
    const tail = this.pending ? [[span(this.pending, "muted")]] : [];
    return { append, tail };
  }

  finish(): { append: RichLine[]; tail: RichLine[] } {
    this.pending += this.filter.finish();
    const flushed = this.pending ? this.push("\n") : { append: [], tail: [] };
    this.pending = "";
    this.fenced = false;
    return { append: flushed.append, tail: [] };
  }
}
