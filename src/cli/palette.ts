import type { Tone } from "./ui-contract";

export interface ResolveThemeOptions {
  readonly setting: "system" | "light" | "dark";
  readonly background: "light" | "dark" | "unknown";
  readonly colorDepth: number;
  readonly noColor: boolean;
  readonly dumb: boolean;
}
type AnsiColor =
  | "black" | "gray" | "white"
  | "green" | "yellow" | "red" | "blue" | "magenta"
  | "brightGreen" | "brightYellow" | "brightRed" | "brightBlue" | "brightMagenta";
type Color = `#${string}` | number | AnsiColor;
export interface ToneStyle {
  readonly foreground?: Color;
  readonly background?: Color;
  readonly bold?: boolean;
  readonly inverse?: boolean;
}
type Palette = Readonly<Record<Tone, ToneStyle>>;
export interface ResolvedPalette {
  readonly enabled: boolean;
  readonly variant: "plain" | "structural" | "light" | "dark";
  readonly styles: Palette;
}

// DESIGN.md sage and semantic inks. Ordinary text keeps the terminal's foreground:
// the CLI does not change the user's canvas/background.
const semantic = {
  light: { muted: "#5c6357", accent: "#55684d", success: "#226d40", warning: "#975a06", error: "#b82420" },
  dark: { muted: "#a4aca0", accent: "#8fad82", success: "#7ed99e", warning: "#f0be65", error: "#ff8f85" },
} as const;
const indexed = {
  light: { muted: 59, accent: 59, success: 23, warning: 94, error: 124 },
  dark: { muted: 145, accent: 108, success: 115, warning: 215, error: 210 },
} as const;
// Preserve the original CLI diff/background and context-category palette at both
// extended depths, rather than assigning different colors to Ink's live content.
const extended: Record<"light" | "dark", Pick<Palette,
  "diffAdded" | "diffRemoved" | "diffAddedWord" | "diffRemovedWord" |
  "contextInstructions" | "contextMemory" | "contextConversation" | "contextTools">> = {
  light: {
    diffAdded: { foreground: 22, background: 194 }, diffRemoved: { foreground: 52, background: 224 },
    diffAddedWord: { foreground: 22, background: 157, bold: true }, diffRemovedWord: { foreground: 52, background: 217, bold: true },
    contextInstructions: { foreground: 25 }, contextMemory: { foreground: 90 },
    contextConversation: { foreground: 23 }, contextTools: { foreground: 94 },
  },
  dark: {
    diffAdded: { foreground: 194, background: 22 }, diffRemoved: { foreground: 224, background: 52 },
    diffAddedWord: { foreground: 231, background: 28, bold: true }, diffRemovedWord: { foreground: 231, background: 88, bold: true },
    contextInstructions: { foreground: 75 }, contextMemory: { foreground: 177 },
    contextConversation: { foreground: 115 }, contextTools: { foreground: 215 },
  },
};

// With no trustworthy background, keep prose on the terminal's own foreground.
// Decoration is separate so non-essential rules may still opt into ANSI gray.
const structural: Palette = {
  text: {}, muted: {}, decoration: { foreground: "gray" }, accent: { foreground: "green" },
  success: { foreground: "green" }, warning: { foreground: "yellow" }, error: { foreground: "red" },
  diffAdded: { foreground: "green" }, diffRemoved: { foreground: "red" },
  diffAddedWord: { foreground: "green", bold: true, inverse: true },
  diffRemovedWord: { foreground: "red", bold: true, inverse: true },
  contextInstructions: { foreground: "blue" }, contextMemory: { foreground: "magenta" },
  contextConversation: { foreground: "green" }, contextTools: { foreground: "yellow" },
};
const ansi16: Record<"light" | "dark", Palette> = {
  light: { ...structural,
    muted: { foreground: "black" }, decoration: { foreground: "black" },
  },
  dark: { ...structural,
    muted: { foreground: "white" }, decoration: { foreground: "white" },
    accent: { foreground: "brightGreen" }, success: { foreground: "brightGreen" },
    warning: { foreground: "brightYellow" }, error: { foreground: "brightRed" },
    diffAdded: { foreground: "brightGreen" }, diffRemoved: { foreground: "brightRed" },
    diffAddedWord: { foreground: "brightGreen", bold: true, inverse: true },
    diffRemovedWord: { foreground: "brightRed", bold: true, inverse: true },
    contextInstructions: { foreground: "brightBlue" }, contextMemory: { foreground: "brightMagenta" },
    contextConversation: { foreground: "brightGreen" }, contextTools: { foreground: "brightYellow" },
  },
};
const palettes = (variant: "light" | "dark", depth: number): Palette => {
  const colors = depth >= 24 ? semantic[variant] : indexed[variant];
  return { ...ansi16[variant], ...extended[variant],
    muted: { foreground: colors.muted }, decoration: { foreground: colors.muted },
    accent: { foreground: colors.accent }, success: { foreground: colors.success },
    warning: { foreground: colors.warning }, error: { foreground: colors.error },
  };
};
const light24 = palettes("light", 24), dark24 = palettes("dark", 24);
const light8 = palettes("light", 8), dark8 = palettes("dark", 8);

export function resolvePalette(options: ResolveThemeOptions): ResolvedPalette {
  if (options.noColor || options.dumb || options.colorDepth < 4)
    return { enabled: false, variant: "plain", styles: structural };
  const background = options.setting === "system" ? options.background : options.setting;
  if (background === "unknown") return { enabled: true, variant: "structural", styles: structural };
  const styles = options.colorDepth < 8 ? ansi16[background] : options.colorDepth >= 24
    ? background === "light" ? light24 : dark24 : background === "light" ? light8 : dark8;
  return { enabled: true, variant: background, styles };
}

const ansiCodes: Record<AnsiColor, number> = {
  black: 30, gray: 90, white: 37,
  green: 32, yellow: 33, red: 31, blue: 34, magenta: 35,
  brightGreen: 92, brightYellow: 93, brightRed: 91, brightBlue: 94, brightMagenta: 95,
};
function colorCode(color: Color, background: boolean): string {
  if (typeof color === "number") return `${background ? 48 : 38};5;${color}`;
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    return `${background ? 48 : 38};2;${[0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16)).join(";")}`;
  }
  return String(ansiCodes[color as AnsiColor] + (background ? 10 : 0));
}
/** Only trusted palette entries become SGR; callers sanitize untrusted text first. */
export function paintTone(text: string, palette: ResolvedPalette, role: Tone, options: { bold?: boolean; inverse?: boolean } = {}): string {
  if (!text || !palette.enabled) return text;
  const style = palette.styles[role];
  const codes: string[] = [];
  if (style.foreground !== undefined) codes.push(colorCode(style.foreground, false));
  if (style.background !== undefined) codes.push(colorCode(style.background, true));
  if (style.bold || options.bold) codes.push("1");
  if (style.inverse || options.inverse) codes.push("7");
  return codes.length ? `${codes.map(code => `\x1b[${code}m`).join("")}${text}\x1b[0m` : text;
}

/** Resolve against the actual UI sink (stderr), not Chalk's process.stdout guess. */
export function terminalColorDepth(output: Pick<NodeJS.WritableStream, "write"> & { getColorDepth?: () => number }): number {
  const depth = output.getColorDepth?.();
  return depth !== undefined && Number.isFinite(depth) ? depth : 8;
}
