import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { sanitizeText } from "../render/sanitize";
import type { RichLine, Tone } from "../ui-contract";
import type { InkViewState } from "./types";

export const spinner = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
export const line = (text: string, tone: Tone = "text"): RichLine => [{ text: sanitizeText(text), tone }];
export const single = (text: string): string => sanitizeText(text).replace(/[\n\t]/g, " ");
export type Appearance = Pick<InkViewState, "theme" | "noColor" | "now">;

const palette: Record<"light" | "dark", Partial<Record<Tone, { color?: string; backgroundColor?: string }>>> = {
  light: {
    muted: { color: "#5c6357" }, accent: { color: "#55684d" },
    success: { color: "#226d40" }, warning: { color: "#975a06" }, error: { color: "#b82420" },
    diffAdded: { color: "#205e27", backgroundColor: "#d6efd1" },
    diffRemoved: { color: "#813032", backgroundColor: "#f6d9db" },
    diffAddedWord: { color: "#16491c", backgroundColor: "#a5e3a1" },
    diffRemovedWord: { color: "#641c20", backgroundColor: "#edb4ba" },
    contextInstructions: { color: "#165d85" }, contextMemory: { color: "#754a8e" },
    contextConversation: { color: "#226d40" }, contextTools: { color: "#975a06" },
  },
  dark: {
    muted: { color: "#a4aca0" }, accent: { color: "#8fad82" },
    success: { color: "#7ed99e" }, warning: { color: "#f0be65" }, error: { color: "#ff8f85" },
    diffAdded: { color: "#b7e9b8", backgroundColor: "#1c4c25" },
    diffRemoved: { color: "#f1c2c4", backgroundColor: "#51252a" },
    diffAddedWord: { color: "#ffffff", backgroundColor: "#24763c" },
    diffRemovedWord: { color: "#ffffff", backgroundColor: "#8b3035" },
    contextInstructions: { color: "#83bde9" }, contextMemory: { color: "#d2a2e9" },
    contextConversation: { color: "#7ed99e" }, contextTools: { color: "#f0be65" },
  },
};
export function RichRow({ spans, appearance, width }: { spans: RichLine; appearance: Appearance; width: number }): ReactElement {
  const colors = appearance.noColor || appearance.theme === "system" ? null : palette[appearance.theme];
  const frame = spinner[Math.floor(appearance.now / 80) % spinner.length] ?? "⠋";
  return <Box flexDirection="row" width={width} height={1} flexShrink={0}><Text wrap="truncate">
    {spans.map((span, index) => {
      const style = colors?.[span.tone ?? "text"];
      const text = span.animation === "spinner" ? frame : sanitizeText(span.text).replace(/\n/g, " ").replace(/\t/g, "    ");
      return <Text key={index} {...style} bold={!appearance.noColor && !!span.bold} inverse={!appearance.noColor && !!span.inverse}>{text}</Text>;
    })}
  </Text></Box>;
}
