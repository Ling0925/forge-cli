import type { InputEvent } from "../terminal/decoder";

export type ThemeSetting = "system" | "light" | "dark";
export type TerminalInput = Pick<
  NodeJS.ReadStream,
  "isTTY" | "isRaw" | "setRawMode"
>;
export type TerminalOutput = Pick<NodeJS.WriteStream, "isTTY" | "write">;

const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const BACKGROUND_QUERY = "\x1b]11;?\x07";
const QUERY_TIMEOUT_MS = 350;

/** Only the 16 standard ANSI background slots have a predictable brightness. */
function colorFgBg(value: string | undefined): "light" | "dark" | "unknown" {
  if (!value || !/^(?:\d{1,3};)?\d{1,3}$/.test(value)) return "unknown";
  const parts = value.split(";").map(Number);
  const background = parts.at(-1);
  if (background === undefined || background > 15) return "unknown";
  if (parts.length === 2 && (parts[0] ?? 0) > 255) return "unknown";
  return background === 7 || background >= 9 ? "light" : "dark";
}

/**
 * Terminal-mode ownership only; the reader/decoder remains the sole input-stream owner.
 *
 * This class never subscribes to input. It owns raw/paste, fullscreen mouse
 * reports, the alternate-buffer lifecycle, and the one-shot background probe.
 * Ink alone owns screen drawing; screen-reader mode stays inline.
 */
export class TerminalModes {
  private setting: ThemeSetting = "system";
  private resolved: ThemeSetting = "system";
  private rawAttempted = false;
  private previousRaw = false;
  private pasteAttempted = false;
  private alternateAttempted = false;
  private mouseAttempted = false;
  get mouseEnabled(): boolean { return this.mouseAttempted && !this.disposed; }
  /** Fullscreen is opt-in at the render boundary, never for a standalone approval. */
  enterFullscreen(): void {
    if (this.disposed || this.screenReader || this.alternateAttempted || !this.input.isTTY || !this.output.isTTY || process.env.TERM === "dumb") return;
    this.alternateAttempted = true;
    try {
      this.output.write("\x1b[?1049h");
      if (!/^(?:0|false|off|no)$/i.test(process.env.FORGE_MOUSE ?? "")) {
        // Basic button/wheel reports only, not motion tracking. Shift+drag remains
        // the terminal's native selection gesture; FORGE_MOUSE=0 opts out.
        this.mouseAttempted = true;
        this.output.write("\x1b[?1006h\x1b[?1000h");
      }
    } catch (error) { try { this.dispose(); } catch {} throw error; }
  }
  private queried = false;
  private deadline = 0;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  readonly screenReader = /^(?:1|true|yes|on)$/i.test(
    process.env.INK_SCREEN_READER ?? "",
  );

  constructor(
    private readonly input: TerminalInput,
    private readonly output: TerminalOutput,
    private readonly onThemeChange: (theme: ThemeSetting) => void,
  ) {}

  get theme(): ThemeSetting {
    return this.resolved;
  }

  /**
   * Idempotent. Repeating the current setting keeps an in-flight background probe alive and keeps
   * any theme already discovered this session; it never re-enables raw/paste and never probes
   * twice. Only switching away from `system` invalidates a pending probe.
   */
  configure(setting: ThemeSetting): void {
    if (this.disposed) return;
    try {
      this.acquire();
      const previousSetting = this.setting;
      this.setting = setting;
      if (setting !== "system") {
        this.cancelQuery();
        this.setTheme(setting);
        return;
      }
      // `unknown` is not a theme: leave the setting unresolved and probe instead of guessing.
      const detected = colorFgBg(process.env.COLORFGBG);
      if (detected === "unknown") {
        if (previousSetting !== "system") this.setTheme("system");
        this.probeBackground();
        return;
      }
      this.cancelQuery();
      this.setTheme(detected);
    } catch (error) {
      try {
        this.dispose();
      } catch {
        /* Preserve the original configure failure. */
      }
      throw error;
    }
  }

  /** Always consume protocol replies; only a pending OSC 11 request may update the theme. */
  handle(event: InputEvent): boolean {
    if (event.kind !== "background") return false;
    if (
      !this.disposed &&
      this.setting === "system" &&
      this.deadline !== 0 &&
      Date.now() < this.deadline
    ) {
      this.cancelQuery();
      this.setTheme(event.background);
    }
    return true;
  }

  /** Takes raw mode and bracketed paste at most once; remembers what to restore later. */
  private acquire(): void {
    // Never change raw mode when somebody else already owns it.
    if (this.input.isTTY && !this.rawAttempted) {
      this.previousRaw = Boolean(this.input.isRaw);
      if (!this.previousRaw && this.input.setRawMode) {
        this.rawAttempted = true; // A throwing implementation may already have changed its state.
        this.input.setRawMode(true);
      }
    }
    if (this.input.isTTY && this.output.isTTY && !this.pasteAttempted) {
      this.pasteAttempted = true; // A throwing write may have sent the sequence.
      this.output.write(PASTE_ON);
    }
  }

  /** Asks for the background color at most once, and never when probing is unsafe or pointless. */
  private probeBackground(): void {
    if (this.queried || !this.canProbe()) return;
    this.queried = true;
    this.deadline = Date.now() + QUERY_TIMEOUT_MS;
    this.queryTimer = setTimeout(() => {
      this.cancelQuery();
    }, QUERY_TIMEOUT_MS);
    this.queryTimer.unref?.();
    this.output.write(BACKGROUND_QUERY);
  }

  private canProbe(): boolean {
    return (
      !this.screenReader &&
      process.env.NO_COLOR === undefined &&
      process.env.TERM !== "dumb" &&
      this.input.isTTY &&
      this.output.isTTY
    );
  }

  private setTheme(theme: ThemeSetting): void {
    if (this.resolved === theme) return;
    this.resolved = theme;
    this.onThemeChange(theme);
  }

  private cancelQuery(): void {
    this.deadline = 0;
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelQuery();
    // Restore raw even if disabling bracketed paste throws.
    let failure: unknown;
    if (this.pasteAttempted) {
      this.pasteAttempted = false;
      try {
        this.output.write(PASTE_OFF);
      } catch (error) {
        failure = error;
      }
    }
    if (this.mouseAttempted) {
      this.mouseAttempted = false;
      // Try each reset even when a previous write failed.
      for (const reset of ["\x1b[?1000l", "\x1b[?1006l"]) {
        try { this.output.write(reset); } catch (error) { failure ??= error; }
      }
    }
    if (this.alternateAttempted) {
      this.alternateAttempted = false;
      try { this.output.write("\x1b[?1049l"); } catch (error) { failure ??= error; }
    }
    if (this.rawAttempted) {
      this.rawAttempted = false;
      try {
        this.input.setRawMode?.(this.previousRaw);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}
