import type { ApprovalRequest, ContextUsage } from "../shared/schemas";

/**
 * Typed contract between the CLI's presentation producers (formatting, command
 * layer) and the single terminal controller that owns the screen.
 *
 * Trust model: every `text` in this contract is untrusted, plain Unicode. Only
 * the terminal controller may emit terminal escape sequences, and only after
 * sanitizing the supplied text. Producers must never pre-colorize their input.
 */

/** Semantic emphasis role. Colors are resolved by the controller, not callers. */
export type Tone =
  | "text"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "contextInstructions"
  | "contextMemory"
  | "contextConversation"
  | "contextTools";

/** A single styled run of plain text. */
export type Span = Readonly<{
  readonly text: string;
  readonly tone?: Tone;
  readonly bold?: boolean;
  readonly inverse?: boolean;
  /** Local presentation marker; animated only in the transient terminal tail. */
  readonly animation?: "spinner";
}>;

/** A logical output line, rendered as a sequence of spans. */
export type RichLine = readonly Span[];

export type ComposerContext = Readonly<{
  model: string;
  usage: ContextUsage | null;
  /** Session estimate until a projected runtime request is available. */
  estimated?: boolean;
}>;

export type UIOptions = Readonly<{
  /** Requested appearance; the controller resolves "system" against the host. */
  readonly theme: "system" | "light" | "dark";
}>;

/** Live run summary for the transient status line. */
export type RunStatus = Readonly<{
  readonly label: string;
  readonly startedAt: number;
  readonly toolCount: number;
  readonly cancellable: boolean;
  /** Generated output in this user turn, across model requests; excludes input/history. */
  readonly tokens?: number;
  readonly tokensEstimated?: boolean;
}>;

export type PickerItem = Readonly<{
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
}>;

export type PickerSpec = Readonly<{
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly selected?: string;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
}>;

/**
 * The controller owns the screen: exactly one component may write escapes,
 * reposition the cursor, or repaint the transient region.
 */
export type TerminalUI = Readonly<{
  readonly columns: number;
  readonly rows: number;

  /** Resolves the theme and installs terminal modes; idempotent. */
  configure(options: UIOptions): Promise<void>;

  /**
   * Finalizes lines above the transient region: once appended, a line is
   * permanent scrollback and is never repainted. Use for completed output.
   */
  append(lines: readonly RichLine[]): void;

  /**
   * Replaces the entire unfinished assistant tail (streaming text, partial
   * tool row). Pass an empty array to clear it. Never appends.
   */
  setTail(lines: readonly RichLine[]): void;

  /** Sets or clears the transient status line; null removes it. */
  setStatus(status: RunStatus | null): void;

  /**
   * Marks a run as in progress. A composed draft is preserved, but no new run
   * may be dispatched from it until the consumer reads that input.
   */
  setBusy(busy: boolean): void;

  /** Optional composer hint shown near the input line; null clears any override. */
  setInputHint?(hint: string | null): void;

  /** Bounded pending-message previews pinned outside the scrolling transcript. */
  setPendingInput?(lines: readonly string[]): void;

  /** Persistent model and context budget footer, independent of run status. */
  setContext?(context: ComposerContext | null): void;

  /**
   * Applies one renderer frame atomically when supported. Older fake UIs may
   * implement only append/setTail/setStatus; callers must feature-detect.
   */
  update?(update: RenderUpdate): void;

  /**
   * Shows a filterable picker. Resolves the selected item's `value`, or null
   * when dismissed or when `signal` aborts. The terminal is restored on return.
   */
  choose(spec: PickerSpec, signal: AbortSignal): Promise<string | null>;

  /**
   * Requests a one-shot decision for `request`. Resolves true only for fresh,
   * intentional typed confirmation (or an explicit key selection); resolves
   * false for decline, cancellation, or abort. Bracketed paste can never
   * approve: pasted bytes are treated as untrusted text, not as consent.
   */
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;

  /** Restores terminal modes and stops all repainting; safe to call once. */
  dispose(): void;
}>;

/** What the controller actually painted, for consumers that mirror the screen. */
export type RenderUpdate = Readonly<{
  readonly append: readonly RichLine[];
  readonly tail: readonly RichLine[];
  readonly status?: RunStatus | null;
}>;
