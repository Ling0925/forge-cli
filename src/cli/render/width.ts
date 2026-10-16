// Match Ink's locked measurement version; keep our sanitizer as the trust boundary.
import measureStringWidth from "string-width";
import { uiSymbols } from "../symbols";
import { sanitizeText } from "./sanitize";

export const stripAnsi = (text: string): string => sanitizeText(text);

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export const graphemes = (text: string): string[] =>
  segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);

export const codePointWidth = (cp: number): number => {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return 0;
  return measureStringWidth(String.fromCodePoint(cp));
};

export const graphemeWidth = (cluster: string): number =>
  measureStringWidth(cluster);

export const stringWidth = (text: string): number =>
  measureStringWidth(stripAnsi(text));

export const visibleWidth = stringWidth;

export const padRight = (
  text: string,
  width: number,
  padChar = " ",
): string => {
  const current = stringWidth(text);
  return current >= width ? text : text + padChar.repeat(width - current);
};

export const padLeft = (text: string, width: number, padChar = " "): string => {
  const current = stringWidth(text);
  return current >= width ? text : padChar.repeat(width - current) + text;
};

export const truncate = (
  input: string,
  maxWidth: number,
  ellipsis = uiSymbols().ellipsis,
): string => {
  if (maxWidth <= 0) return "";
  const mark = stringWidth(ellipsis) > maxWidth ? "" : sanitizeText(ellipsis);
  const tokens =
    input.match(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal protocol tokenizer
      /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]+|\u001b/g,
    ) ?? [];
  const clean: string[] = [];
  for (const token of tokens) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: preserve SGR only
    if (/^\u001b\[[0-9;]*m$/.test(token)) clean.push(token);
    else if (!token.startsWith("\u001b")) clean.push(sanitizeText(token));
  }
  const text = clean.join("");
  if (stringWidth(text) <= maxWidth) return text;
  const target = Math.max(0, maxWidth - stringWidth(mark));
  let out = "";
  let width = 0;
  let styled = false;
  for (const token of clean) {
    if (token.startsWith("\u001b")) {
      out += token;
      styled = true;
      continue;
    }
    for (const cluster of graphemes(token)) {
      const next = graphemeWidth(cluster);
      if (width + next > target)
        return `${out}${mark}${styled ? "\u001b[0m" : ""}`;
      out += cluster;
      width += next;
    }
  }
  return out;
};

export const getTerminalWidth = (): number => {
  const columns = process.stderr?.columns;
  if (typeof columns === "number" && Number.isFinite(columns) && columns > 0) {
    return Math.floor(columns);
  }
  return 80;
};
