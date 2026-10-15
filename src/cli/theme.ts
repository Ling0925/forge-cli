import type { Tone } from "./ui-contract";

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
  tone(
    text: string,
    role: Tone,
    options?: { bold?: boolean; inverse?: boolean },
  ): string;
  badge(
    text: string,
    color: "green" | "blue" | "yellow" | "red" | "gray" | "cyan",
  ): string;
}

export interface ResolveThemeOptions {
  readonly setting: "system" | "light" | "dark";
  readonly background: "light" | "dark" | "unknown";
  readonly colorDepth: number;
  readonly noColor: boolean;
  readonly dumb: boolean;
}

const wrap = (text: string, open: string, close: string): string =>
  text ? `${open}${text}${close}` : "";

const identity = (text: string): string => text;

const paint = (open: string) => (text: string) => wrap(text, open, "\u001b[0m");

interface Paint {
  readonly text: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly accent: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly error: (text: string) => string;
}

const plainPaint: Paint = {
  text: identity,
  muted: identity,
  accent: identity,
  success: identity,
  warning: identity,
  error: identity,
};

/** Truecolor sage/semantic inks measured at >= 4.5:1 on DESIGN.md canvases. */
const truecolor: Record<"light" | "dark", Paint> = {
  light: {
    text: identity,
    muted: paint("\u001b[38;2;92;99;87m"),
    accent: paint("\u001b[38;2;85;104;77m"),
    success: paint("\u001b[38;2;34;109;64m"),
    warning: paint("\u001b[38;2;151;90;6m"),
    error: paint("\u001b[38;2;184;36;32m"),
  },
  dark: {
    text: identity,
    muted: paint("\u001b[38;2;164;172;160m"),
    accent: paint("\u001b[38;2;143;173;130m"),
    success: paint("\u001b[38;2;126;217;158m"),
    warning: paint("\u001b[38;2;240;190;101m"),
    error: paint("\u001b[38;2;255;143;133m"),
  },
};

/** 256-color fallbacks that also clear 4.5:1 on the same canvases. */
const cube: Record<"light" | "dark", Paint> = {
  light: {
    text: identity,
    muted: paint("\u001b[38;5;59m"),
    accent: paint("\u001b[38;5;59m"),
    success: paint("\u001b[38;5;23m"),
    warning: paint("\u001b[38;5;94m"),
    error: paint("\u001b[38;5;124m"),
  },
  dark: {
    text: identity,
    muted: paint("\u001b[38;5;145m"),
    accent: paint("\u001b[38;5;108m"),
    success: paint("\u001b[38;5;115m"),
    warning: paint("\u001b[38;5;215m"),
    error: paint("\u001b[38;5;210m"),
  },
};

const build = (
  enabled: boolean,
  variant: Theme["variant"],
  colors: Paint,
  structural: boolean,
  extendedColor = false,
): Theme => {
  const accent = colors.accent;
  const bold = (text: string): string =>
    enabled && text ? wrap(text, "\u001b[1m", "\u001b[22m") : text;
  const tone: Theme["tone"] = (text, role, options) => {
    const contextRoles: Partial<Record<Tone, number>> = {
      contextInstructions: 0, contextMemory: 1, contextConversation: 2, contextTools: 3,
    };
    const index = contextRoles[role];
    const inks = extendedColor && variant === "light"
      ? ["38;5;25", "38;5;90", "38;5;23", "38;5;94"]
      : extendedColor && variant === "dark"
        ? ["38;5;75", "38;5;177", "38;5;115", "38;5;215"]
        : ["34", "35", "32", "33"];
    const diffRoles: Partial<Record<Tone, number>> = {
      diffAdded: 0, diffRemoved: 1, diffAddedWord: 2, diffRemovedWord: 3,
    };
    const diffIndex = diffRoles[role];
    // Independent foreground/background palettes: line context is quiet, changed
    // word spans are stronger. Unknown terminals use standard ANSI, NO_COLOR none.
    const diffInks = extendedColor && variant === "light"
      ? ["38;5;22;48;5;194", "38;5;52;48;5;224", "38;5;22;48;5;157;1", "38;5;52;48;5;217;1"]
      : extendedColor && variant === "dark"
        ? ["38;5;194;48;5;22", "38;5;224;48;5;52", "38;5;231;48;5;28;1", "38;5;231;48;5;88;1"]
        : ["32", "31", "32;1;7", "31;1;7"];
    const painted = diffIndex !== undefined
      ? enabled ? paint(`\u001b[${diffInks[diffIndex]}m`)(text) : text
      : index === undefined
        ? colors[role as keyof Paint](text)
        : enabled ? paint(`\u001b[${inks[index]}m`)(text) : text;
    const marked = options?.bold ? bold(painted) : painted;
    return options?.inverse && enabled && marked
      ? wrap(marked, "\u001b[7m", "\u001b[27m")
      : marked;
  };
  return {
    enabled,
    variant,
    bold:
      structural || variant === "light" || variant === "dark" ? bold : identity,
    dim: colors.muted,
    italic: enabled
      ? (text) => wrap(text, "\u001b[3m", "\u001b[23m")
      : identity,
    underline: enabled
      ? (text) => wrap(text, "\u001b[4m", "\u001b[24m")
      : identity,
    inverse: enabled
      ? (text) => wrap(text, "\u001b[7m", "\u001b[27m")
      : identity,
    cyan: accent,
    blue: accent,
    magenta: accent,
    green: colors.success,
    yellow: colors.warning,
    red: colors.error,
    gray: colors.muted,
    tone,
    badge: (text) => bold(`[${text}]`),
  };
};

export const resolveTheme = (options: ResolveThemeOptions): Theme => {
  if (options.noColor || options.dumb || options.colorDepth < 4) {
    return build(false, "plain", plainPaint, false);
  }
  const variant =
    options.setting === "system" ? options.background : options.setting;
  if (variant === "unknown") return build(true, "structural", plainPaint, true);
  const colors = options.colorDepth >= 24 ? truecolor[variant] : cube[variant];
  return build(true, variant, colors, true, options.colorDepth >= 8);
};

export const createTheme = (
  options: { isTTY?: boolean; forceColor?: boolean } = {},
): Theme => {
  const enabled =
    (options.isTTY ?? true) &&
    isColorSupported(true) &&
    (options.forceColor ?? true);
  if (!enabled)
    return resolveTheme({
      setting: "system",
      background: "unknown",
      colorDepth: 1,
      noColor: true,
      dumb: false,
    });
  return resolveTheme({
    setting: "dark",
    background: "dark",
    colorDepth: 8,
    noColor: false,
    dumb: false,
  });
};

export const defaultTheme = createTheme();

export {
  codePointWidth,
  getTerminalWidth,
  graphemeWidth,
  graphemes,
  padLeft,
  padRight,
  stringWidth,
  stripAnsi,
  truncate,
  visibleWidth,
} from "./render/width";
