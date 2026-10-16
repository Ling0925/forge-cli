import type { Theme } from "../theme";
import type { RichLine, Span } from "../ui-contract";
import { sanitizeText } from "./sanitize";
import { graphemeWidth, graphemes, stringWidth, truncate } from "./width";

export const textSpan = (text: string): Span => ({ text: sanitizeText(text) });

export const plainLines = (text: string): readonly RichLine[] => {
  const lines = sanitizeText(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => [textSpan(line)]);
};

const styleOf = (theme: Theme, item: Span): ((value: string) => string) => {
  const role = item.tone ?? "text";
  return (value) =>
    theme.tone(value, role, {
      ...(item.bold === undefined ? {} : { bold: item.bold }),
      ...(item.inverse === undefined ? {} : { inverse: item.inverse }),
    });
};

export const renderRichLine = (line: RichLine, theme: Theme): string =>
  line
    .filter((item): item is Span => item !== undefined)
    .map((item) =>
      styleOf(
        theme,
        item,
      )(sanitizeText(item.text).replace(/\n/g, " ").replace(/\t/g, "    ")),
    )
    .join("");

export const wrapRichLines = (
  lines: readonly RichLine[],
  columns: number,
): readonly RichLine[] => {
  const limit = Math.max(1, Math.floor(columns));
  const wrapped: RichLine[] = [];
  for (const line of lines) {
    if (line.some(item => item.preview === "reasoning")) {
      // Producers can use a wider width than Ink, and frozen/history rows are
      // reflowed again on resize. A collapsed thought must never become two rows.
      let remaining = limit;
      const preview: Span[] = [];
      for (const item of line) {
        if (remaining <= 0) break;
        const clean = sanitizeText(item.text).replace(/[\n\t]/g, " ");
        const text = truncate(clean, remaining);
        preview.push({ ...item, text });
        remaining -= stringWidth(text);
        if (stringWidth(clean) > stringWidth(text)) break;
      }
      wrapped.push(preview);
      continue;
    }
    let current: Span[] = [];
    let used = 0;
    const flush = (): void => {
      wrapped.push(current);
      current = [];
      used = 0;
    };
    for (const item of line) {
      const clean = sanitizeText(item.text).replace(/\t/g, "    ");
      for (const cluster of graphemes(clean)) {
        if (cluster === "\n") {
          flush();
          continue;
        }
        const width = graphemeWidth(cluster);
        if (used && used + width > limit) flush();
        // A two-cell grapheme cannot fit a one-cell terminal: use a visible replacement.
        const text = width > limit ? "�" : cluster;
        const last = current.at(-1);
        if (
          last &&
          last.tone === item.tone &&
          last.bold === item.bold &&
          last.inverse === item.inverse &&
          last.animation === item.animation
        ) {
          current[current.length - 1] = { ...last, text: last.text + text };
        } else {
          current.push({ ...item, text });
        }
        used += Math.min(width, limit);
      }
    }
    flush();
  }
  return wrapped;
};

export const joinSpans = (parts: readonly Span[]): RichLine =>
  parts.filter((item) => item.text.length > 0);
