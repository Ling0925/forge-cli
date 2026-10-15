import type { Tone } from "./ui-contract";
import { paintTone, resolvePalette, type ResolveThemeOptions } from "./palette";
export type { ResolveThemeOptions } from "./palette";

export const isColorSupported = (isTTY = true): boolean => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.TERM === "dumb") return false;
  return isTTY;
};

export interface Theme {
  readonly enabled: boolean;
  readonly variant: "plain" | "structural" | "light" | "dark";
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  gray(text: string): string;
  tone(text: string, role: Tone, options?: { bold?: boolean; inverse?: boolean }): string;
  badge(text: string, color: "green" | "blue" | "yellow" | "red" | "gray" | "cyan"): string;
}

export const resolveTheme = (options: ResolveThemeOptions): Theme => {
  const palette = resolvePalette(options);
  const decorate = (text: string, open: number, close: number): string =>
    palette.enabled && text ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  const role = (tone: Tone) => (text: string) => paintTone(text, palette, tone);
  const bold = (text: string) => decorate(text, 1, 22);
  return {
    enabled: palette.enabled, variant: palette.variant,
    bold, dim: role("muted"), italic: text => decorate(text, 3, 23),
    underline: text => decorate(text, 4, 24), inverse: text => decorate(text, 7, 27),
    cyan: role("accent"), blue: role("accent"), magenta: role("accent"),
    green: role("success"), yellow: role("warning"), red: role("error"), gray: role("muted"),
    tone: (text, tone, emphasis) => paintTone(text, palette, tone, emphasis),
    badge: text => bold(`[${text}]`),
  };
};

export const createTheme = (options: { isTTY?: boolean; forceColor?: boolean } = {}): Theme => {
  const enabled = (options.isTTY ?? true) && isColorSupported(true) && (options.forceColor ?? true);
  return resolveTheme({ setting: enabled ? "dark" : "system", background: enabled ? "dark" : "unknown",
    colorDepth: enabled ? 8 : 1, noColor: !enabled, dumb: false });
};
export const defaultTheme = createTheme();
export {
  codePointWidth, getTerminalWidth, graphemeWidth, graphemes, padLeft, padRight,
  stringWidth, stripAnsi, truncate, visibleWidth,
} from "./render/width";
