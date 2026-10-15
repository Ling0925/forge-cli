import type { RichLine } from "../ui-contract";
import { sanitizeText } from "./sanitize";
import { truncate } from "./width";

/** Keeps only the trailing bytes needed for the current wrapped line. */
export const REASONING_KEEP = 8 * 1024;
export const REASONING_PREFIX = "✻ ";

const isBreak = (char: string): boolean => char === "\n" || char === "\r";

/** Latest single line of streamed reasoning, flattened for one-row display. */
export const lastReasoningLine = (text: string): string => {
  let last = text.length;
  while (last > 0 && isBreak(text[last - 1] as string)) last -= 1;
  let start = last;
  while (start > 0 && !isBreak(text[start - 1] as string)) start -= 1;
  return sanitizeText(text.slice(start, last)).replace(/\s+/g, " ").trim();
};

/** Renders one bounded, muted reasoning row; undefined when there is no text. */
export const reasoningLine = (
  text: string,
  width: number,
): RichLine | undefined => {
  const current = lastReasoningLine(text);
  if (!current) return undefined;
  const room = Math.max(0, Math.floor(width) - 2);
  return [
    { text: REASONING_PREFIX, tone: "muted" },
    { text: truncate(current, room), tone: "muted" },
  ];
};
