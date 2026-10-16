/** UI-owned glyphs only. Never transliterate user text, code, paths or model output. */
const unicode = Object.freeze({
  prompt: "❯", success: "✔", active: "●", pending: "○", failure: "✖",
  branch: "↳", endBranch: "╰", reasoning: "✻", vertical: "│", horizontal: "─", heavyHorizontal: "━",
  bullet: "•", separator: "·", ellipsis: "…", approximate: "≈",
  up: "↑", down: "↓", move: "↑↓", range: "–", cursor: "▏",
  spinnerFrames: Object.freeze([..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"]),
});
export type UISymbols = Readonly<{ [K in keyof typeof unicode]: K extends "spinnerFrames" ? readonly string[] : string }>;
const ascii: UISymbols = Object.freeze({
  prompt: ">", success: "+", active: "*", pending: "o", failure: "x",
  branch: ">", endBranch: "+", reasoning: "*", vertical: "|", horizontal: "-", heavyHorizontal: "=",
  bullet: "*", separator: "|", ellipsis: "...", approximate: "~",
  up: "^", down: "v", move: "Up/Down", range: "-", cursor: "|",
  spinnerFrames: Object.freeze([..."|/-\\"]),
});

/** Capability hints, not font detection. An explicit override handles missing glyphs. */
export function resolveSymbols(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): UISymbols {
  const setting = env.FORGE_SYMBOLS?.trim().toLowerCase();
  if (setting === "ascii") return ascii;
  if (setting === "unicode") return unicode;
  const term = env.TERM?.toLowerCase();
  if (term === "dumb" || term === "linux") return ascii;
  if (platform === "win32") {
    return env.WT_SESSION || env.ConEmuANSI === "ON" || env.TERM_PROGRAM === "vscode"
      || term?.startsWith("xterm") || term === "cygwin" ? unicode : ascii;
  }
  // Respect locale precedence. A missing locale is not evidence of ASCII-only output.
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return locale && !/utf-?8/i.test(locale) ? ascii : unicode;
}

/** Resolve at the producer boundary, before wrapping/truncation; color is independent. */
export const uiSymbols = (): UISymbols => resolveSymbols();
export function spinnerFrame(now: number): string {
  const frames = uiSymbols().spinnerFrames;
  const tick = Number.isFinite(now) ? Math.max(0, Math.floor(now / 80)) : 0;
  return frames[tick % frames.length]!;
}
