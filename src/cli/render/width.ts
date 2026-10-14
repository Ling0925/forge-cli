import { sanitizeText } from "./sanitize";

export const stripAnsi = (text: string): string => sanitizeText(text);

const isWideCodePoint = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2329 && cp <= 0x232a) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe10 && cp <= 0xfe19) ||
  (cp >= 0xfe30 && cp <= 0xfe6f) ||
  (cp >= 0xff01 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1f64f) ||
  (cp >= 0x1f680 && cp <= 0x1f6ff) ||
  (cp >= 0x1f900 && cp <= 0x1f9ff) ||
  (cp >= 0x1fa70 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

const isZeroWidthCodePoint = (cp: number): boolean =>
  cp === 0 ||
  (cp >= 1 && cp <= 31) ||
  (cp >= 127 && cp <= 159) ||
  (cp >= 0x0300 && cp <= 0x036f) ||
  (cp >= 0x1ab0 && cp <= 0x1aff) ||
  (cp >= 0x1dc0 && cp <= 0x1dff) ||
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  (cp >= 0x20d0 && cp <= 0x20ff) ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xfe20 && cp <= 0xfe2f) ||
  (cp >= 0xe0100 && cp <= 0xe01ef) ||
  cp === 0x00ad ||
  cp === 0xfeff;

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export const graphemes = (text: string): string[] =>
  segmenter
    ? Array.from(segmenter.segment(text), (part) => part.segment)
    : Array.from(text);

export const codePointWidth = (cp: number): number => {
  if (isZeroWidthCodePoint(cp)) return 0;
  if (isWideCodePoint(cp)) return 2;
  return 1;
};

const isEmojiPresentation = (cluster: string): boolean => {
  if (
    /\p{Extended_Pictographic}/u.test(cluster) &&
    (cluster.includes("\ufe0f") || cluster.includes("\u200d"))
  )
    return true;
  if (cluster.includes("\u20e3")) return true;
  const first = cluster.codePointAt(0) ?? 0;
  return first >= 0x1f1e6 && first <= 0x1f1ff;
};

export const graphemeWidth = (cluster: string): number => {
  if (!cluster) return 0;
  if (isEmojiPresentation(cluster)) return 2;
  let width = 0;
  for (const symbol of cluster) {
    const point = symbol.codePointAt(0);
    if (point !== undefined) width = Math.max(width, codePointWidth(point));
  }
  return width;
};

export const stringWidth = (text: string): number => {
  let width = 0;
  for (const cluster of graphemes(stripAnsi(text)))
    width += graphemeWidth(cluster);
  return width;
};

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
  ellipsis = "…",
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
