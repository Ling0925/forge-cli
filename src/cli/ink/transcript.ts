import { wrapRichLines, renderRichLine } from "../render/rich";
import { resolveTheme } from "../theme";
import type { RichLine, UIOptions } from "../ui-contract";

export const HISTORY_LINES = 2000;
export const HISTORY_BYTES = 1_000_000;
export const PENDING_BYTES = 2_000_000;
const size = (line: RichLine) => line.reduce((n, span) => n + Buffer.byteLength(span.text) + 64, 0);

/** Recent UI reading cache only; persisted messages and terminal scrollback are untouched. */
export class Transcript {
  private lines: RichLine[] = [];
  private bytes = 0;
  private pending: (readonly RichLine[])[] = [];
  private pendingBytes = 0;
  private omitted = false;
  private revision = 0;
  private wrapped: { revision: number; width: number; lines: readonly RichLine[] } | undefined;
  append(lines: readonly RichLine[], deferred = false): void {
    if (!lines.length) return;
    const bounded = lines.map(line => size(line) > HISTORY_BYTES
      ? [{ text: line.map(span => span.text).join("").slice(-100_000), tone: "muted" as const }] : line);
    this.lines.push(...bounded);
    this.bytes += bounded.reduce((n, line) => n + size(line), 0);
    let removed = 0;
    while (this.lines.length - removed > HISTORY_LINES || this.bytes > HISTORY_BYTES) {
      this.bytes -= size(this.lines[removed++]!);
    }
    if (removed) this.lines = this.lines.slice(removed);
    // The queue is normally drained in the same render. Reading mode may defer it.
    this.pending.push(lines);
    this.pendingBytes += lines.reduce((n, line) => n + size(line), 0);
    while (deferred && this.pending.length && this.pendingBytes > PENDING_BYTES) {
      const first = this.pending.shift()!;
      this.pendingBytes -= first.reduce((n, line) => n + size(line), 0);
      this.omitted = true;
    }
    this.revision++;
  }
  get retainedLines(): number { return this.lines.length; }
  get retainedBytes(): number { return this.bytes; }
  get queuedBytes(): number { return this.pendingBytes; }
  recent(width: number): readonly RichLine[] {
    if (!this.wrapped || this.wrapped.width !== width || this.wrapped.revision !== this.revision)
      this.wrapped = { width, revision: this.revision, lines: wrapRichLines(this.lines, width) };
    return this.wrapped.lines;
  }
  /** Fullscreen paints retained history; only the accessible inline path drains output. */
  discardPending(): void { this.pending = []; this.pendingBytes = 0; this.omitted = false; }
  drain(width: number, setting: UIOptions["theme"], noColor: boolean, colorDepth = 8): string[] {
    const batches = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    const theme = resolveTheme({ setting, background: "unknown", colorDepth, noColor, dumb: false });
    const output: string[] = [];
    let chunk = this.omitted ? "[Reading buffer limit reached; use /export for the persisted session.]\n" : "";
    this.omitted = false;
    for (const batch of batches) for (const line of wrapRichLines(batch, width)) {
      const row = `${renderRichLine(line, theme)}\n`;
      if (chunk.length + row.length > 64_000 && chunk) { output.push(chunk); chunk = ""; }
      chunk += row;
    }
    if (chunk) output.push(chunk);
    return output;
  }
}

export interface ReadingSnapshot {
  readonly lines: readonly RichLine[];
  readonly end: number;
  readonly pending: number;
}
/** Freeze a display snapshot, not the runtime. Navigation never dispatches user input. */
export class ReadingView {
  private frozen: readonly RichLine[] | undefined;
  private end = 0;
  private pending = 0;
  get active(): boolean { return this.frozen !== undefined; }
  snapshot(): ReadingSnapshot | null {
    return this.frozen ? { lines: this.frozen, end: this.end, pending: this.pending } : null;
  }
  open(history: readonly RichLine[], tail: readonly RichLine[], width: number): void {
    if (this.active) return;
    this.frozen = [...history, ...wrapRichLines(tail, width)].slice(-HISTORY_LINES);
    this.end = this.frozen.length;
    this.pending = 0;
  }
  resize(width: number): void {
    if (!this.frozen) return;
    const before = wrapRichLines(this.frozen.slice(0, this.end), width);
    // Reflow the complete snapshot: splitting at the page cursor would turn a
    // soft continuation there into a permanent newline when widening again.
    const all = wrapRichLines(this.frozen, width);
    const trim = Math.max(0, all.length - HISTORY_LINES);
    this.frozen = all.slice(trim);
    this.end = Math.max(0, before.length - trim);
  }
  move(delta: number, pageSize: number): void {
    if (!this.frozen) return;
    this.end = Math.max(Math.min(pageSize, this.frozen.length), Math.min(this.frozen.length, this.end + delta));
  }
  changed(): void { if (this.active) this.pending++; }
  close(): void { this.frozen = undefined; this.end = 0; this.pending = 0; }
}
