import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { sanitizeText } from "../render/sanitize";
import { renderRichLine } from "../render/rich";
import { resolveTheme } from "../theme";
import type { RichLine, Tone } from "../ui-contract";
import type { InkViewState } from "./types";
import { spinnerFrame } from "../symbols";
import { truncate } from "../render/width";

export const line = (text: string, tone: Tone = "text"): RichLine => [{ text: sanitizeText(text), tone }];
export const single = (text: string): string => sanitizeText(text).replace(/[\n\t]/g, " ");
export type Appearance = Pick<InkViewState, "theme" | "noColor" | "colorDepth" | "now">;

export function RichRow({ spans, appearance, width }: { spans: RichLine; appearance: Appearance; width: number }): ReactElement {
  const theme = resolveTheme({ setting: appearance.theme, background: "unknown",
    colorDepth: appearance.colorDepth ?? 8, noColor: appearance.noColor, dumb: false });
  const frame = spinnerFrame(appearance.now);
  const animated = spans.some(span => span.animation === "spinner")
    ? spans.map(span => span.animation === "spinner" ? { ...span, text: frame + (span.text.endsWith(" ") ? " " : "") } : span) : spans;
  // Only sanitized text + trusted SGR from the shared palette enters Ink Text.
  // Ink owns layout/cursor output; do not let its global Chalk capability guess
  // recolor live rows differently from committed output on the actual UI stream.
  // Bound before Ink so its default Unicode ellipsis cannot bypass ASCII mode.
  return <Box flexDirection="row" width={width} height={1} flexShrink={0}>
    <Text wrap="truncate">{truncate(renderRichLine(animated, theme), width)}</Text>
  </Box>;
}
