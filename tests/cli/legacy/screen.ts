import { terminalText } from "../../../src/cli/format";
import { renderRichLine, wrapRichLines } from "../../../src/cli/render/rich";
import { type Theme, graphemeWidth, graphemes, visibleWidth } from "../../../src/cli/theme";
import type { RichLine } from "../../../src/cli/ui-contract";
import { type Cell, ScreenSelection } from "./selection";
import type { InputEvent } from "../../../src/cli/terminal/decoder";

export const plain = (text: string): RichLine => [{ text: terminalText(text) }];

const positiveDimension = (value: number): number =>
  Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;

const safeIndex = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const safeColumn = (value: number, columns: number): number =>
  Math.min(safeIndex(value), Math.max(0, columns - 1));

const lineText = (line: RichLine): string =>
  line.map((span) => span.text).join("");

/** Physical layout never relies on the terminal's delayed autowrap. */
export function composerLayout(
  text: string,
  cursor: number,
  columns: number,
): { lines: RichLine[]; row: number; column: number } {
  const lines: string[] = [""];
  let row = 0;
  let column = 0;
  let offset = 0;
  let cursorRow = 0;
  let cursorColumn = 0;
  for (const g of graphemes(text)) {
    const width = graphemeWidth(g);
    const glyph = width > columns ? "�" : g;
    const cells = Math.min(columns, width);
    if (g !== "\n" && column + cells > columns) {
      row++;
      column = 0;
      lines.push("");
    }
    if (offset === cursor) {
      cursorRow = row;
      cursorColumn = column;
    }
    if (g === "\n") {
      if (
        column === 0 &&
        row > 0 &&
        lines[row] === "" &&
        offset > 0 &&
        text[offset - 1] !== "\n"
      ) {
        offset += g.length;
        continue;
      }
      row++;
      column = 0;
      lines.push("");
    } else {
      lines[row] = (lines[row] ?? "") + glyph;
      column += cells;
    }
    offset += g.length;
    if (column === columns) {
      row++;
      column = 0;
      lines.push("");
    }
  }
  if (offset === cursor) {
    cursorRow = row;
    cursorColumn = column;
  }
  return { lines: lines.map(plain), row: cursorRow, column: cursorColumn };
}

export class Screen {
  enabled = false;
  /** Alternate-screen viewport with a docked composer. */
  fixed = false;
  private history: RichLine[] = [];
  private scrollOffset = 0;
  get historyOffset(): number { return this.scrollOffset; }
  private transcript: readonly RichLine[] = [];
  private transcriptLength = 0;
  private wrapColumns = 0;
  private historyDirty = true;
  private transcriptDirty = true;
  private wrappedHistory: readonly RichLine[] = [];
  private wrappedTail: readonly RichLine[] = [];
  private wrappedTranscript: readonly RichLine[] = [];
  private layoutTranscript(columns: number): readonly RichLine[] {
    const resized = this.wrapColumns !== columns;
    if (resized || this.historyDirty || this.transcriptDirty) {
      // Typing, scrolling and status ticks must not re-segment restored history.
      // A streaming tail also must not invalidate the committed-history layout.
      if (resized || this.historyDirty)
        this.wrappedHistory = wrapRichLines(this.history, columns);
      if (resized || this.transcriptDirty)
        this.wrappedTail = wrapRichLines(this.transcript, columns);
      this.wrappedTranscript = [...this.wrappedHistory, ...this.wrappedTail];
      this.wrapColumns = columns;
      this.historyDirty = false;
      this.transcriptDirty = false;
    }
    return this.wrappedTranscript;
  }
  private viewport: readonly RichLine[] = [];
  private selection: ScreenSelection | undefined;
  private selectionAnchor: Cell | undefined;
  /** Explicit terminal-native selection mode; resume with Ctrl+G. */
  nativeSelection = false;
  private fixedTarget = -1;
  private fixedColumn = -1;
  get hasSelection(): boolean { return this.selection !== undefined; }
  selectedText(): string { return this.selection?.text() ?? ""; }
  clearSelection(): void { this.selection = undefined; this.selectionAnchor = undefined; }
  copySelection(): boolean {
    const text = this.selectedText();
    // Sending OSC 52 is not an acknowledgement from the system clipboard.
    if (!text || Buffer.byteLength(text) > 100_000) return false;
    this.output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return true;
  }
  mouse(event: Extract<InputEvent, { kind: "mouse" }>): void {
    if (!this.fixed || this.nativeSelection || event.shift) return;
    if (event.action === "wheel-up" || event.action === "wheel-down") {
      this.scroll(event.action === "wheel-up" ? 3 : -3);
      return;
    }
    const cell: Cell = {
      row: Math.min(Math.max(0, this.fixedRows - 1), safeIndex(event.row)),
      column: safeColumn(event.column, this.fixedColumns),
    };
    if (event.action === "press") {
      this.clearSelection();
      this.paintFixed(this.lastFixedLines, this.lastFixedRow, this.lastFixedColumn);
      this.selectionAnchor = cell;
      return;
    }
    const anchor = this.selectionAnchor;
    if (!this.selection && anchor && (anchor.row !== cell.row || anchor.column !== cell.column)) {
      this.selection = new ScreenSelection(this.viewport, anchor);
    }
    if (this.selection) {
      this.selection.focus = cell;
      this.writeFixed(this.selection.highlight(), this.fixedTarget, this.fixedColumn);
    }
    if (event.action === "release") this.selectionAnchor = undefined;
  }
  setTranscript(lines: readonly RichLine[]): void {
    // Render updates replace immutable tail snapshots; draw reuses the same one.
    if (this.transcript === lines) return;
    this.transcript = lines;
    this.transcriptDirty = true;
  }
  private fixedRendered: string[] = [];
  private fixedColumns = 0;
  private fixedRows = 0;
  private lastFixedLines: readonly RichLine[] = [];
  private lastFixedRow = 0;
  private lastFixedColumn = 0;
  private count = 0;
  private cursorRow = 0;
  private cursorColumn = 0;
  private widths: number[] = [];
  private rendered: string[] = [];
  private columns = 0;
  private rows = 0;
  constructor(
    private readonly output: NodeJS.WritableStream,
    private readonly dimensions: () => { columns: number; rows: number },
    public theme: Theme,
  ) {}
  private top(): string {
    return `\r${this.cursorRow ? `\x1b[${this.cursorRow}A` : ""}`;
  }
  private reset(): void {
    this.count = 0;
    this.cursorRow = 0;
    this.cursorColumn = 0;
    this.widths = [];
    this.rendered = [];
    this.columns = 0;
    this.rows = 0;
  }
  private moveCursor(fromRow: number, toRow: number, column: number): string {
    const delta = toRow - fromRow;
    return `\r${
      delta < 0 ? `\x1b[${-delta}A` : delta > 0 ? `\x1b[${delta}B` : ""
    }\x1b[${column + 1}G`;
  }
  private frame(lines: readonly RichLine[], row: number, column: number) {
    const dimensions = this.dimensions();
    const columns = positiveDimension(dimensions.columns);
    const rows = positiveDimension(dimensions.rows);
    const limit = Math.max(1, rows - 1);
    const selected = lines.slice(0, limit);
    const target = selected.length
      ? Math.min(safeIndex(row), selected.length - 1)
      : 0;
    return {
      rendered: selected.map((line) => renderRichLine(line, this.theme)),
      widths: selected.map((line) => visibleWidth(lineText(line))),
      target,
      column: safeColumn(column, columns),
      columns,
      rows,
    };
  }
  private drawFull(
    rendered: readonly string[],
    target: number,
    column: number,
  ): void {
    if (!rendered.length) return;
    const height = rendered.length;
    this.output.write(
      `${"\r\n".repeat(height - 1)}${height > 1 ? `\x1b[${height - 1}A` : ""}\r${rendered.join("\r\n")}\r${height - 1 > target ? `\x1b[${height - 1 - target}A` : ""}\x1b[${column + 1}G`,
    );
  }
  private updateRows(
    rendered: readonly string[],
    changedRows: readonly number[],
    target: number,
    column: number,
  ): void {
    let bytes = this.top();
    let current = 0;
    for (const row of changedRows) {
      const delta = row - current;
      if (delta > 0) bytes += `\x1b[${delta}B`;
      else if (delta < 0) bytes += `\x1b[${-delta}A`;
      bytes += `\r\x1b[2K${rendered[row] ?? ""}\r`;
      current = row;
    }
    bytes += this.moveCursor(current, target, column);
    this.output.write(bytes);
  }
  private commit(frame: ReturnType<Screen["frame"]>): void {
    this.count = frame.rendered.length;
    this.cursorRow = frame.target;
    this.cursorColumn = frame.column;
    this.widths = frame.widths;
    this.rendered = frame.rendered;
    this.columns = frame.columns;
    this.rows = frame.rows;
  }
  /** Scroll only the transcript; the composer and editor cursor stay docked. */
  scroll(delta: number): void {
    if (!this.fixed || !Number.isFinite(delta)) return;
    this.clearSelection();
    this.scrollOffset = Math.max(0, this.scrollOffset + Math.trunc(delta));
    this.paintFixed(this.lastFixedLines, this.lastFixedRow, this.lastFixedColumn);
  }
  private paintFixed(lines: readonly RichLine[], row: number, column: number): void {
    this.lastFixedLines = lines;
    this.lastFixedRow = row;
    this.lastFixedColumn = column;
    const { columns: rawColumns, rows: rawRows } = this.dimensions();
    const columns = positiveDimension(rawColumns);
    const rows = positiveDimension(rawRows);
    const sameSize = this.fixedColumns === columns && this.fixedRows === rows;
    if (this.nativeSelection && sameSize) return;
    const composer = lines.slice(0, Math.max(1, rows - 1));
    if (this.selection && sameSize) {
      // Freeze selected transcript cells only, not the whole application. Dock
      // rows outside the selected range can still show activity/approvals.
      const selected = this.selection.highlight();
      const dockStart = rows - composer.length;
      const first = Math.min(this.selection.anchor.row, this.selection.focus.row);
      const last = Math.max(this.selection.anchor.row, this.selection.focus.row);
      const merged = selected.map((line, index) => index >= dockStart && (index < first || index > last)
        ? composer[index - dockStart] ?? line : line);
      this.writeFixed(merged, Math.min(rows - 1, dockStart + safeIndex(row)), safeColumn(column, columns));
      return;
    }
    if (!sameSize) this.clearSelection();
    const available = Math.max(0, rows - composer.length);
    const wrapped = this.layoutTranscript(Math.max(1, columns - 1));
    if (this.scrollOffset && this.fixedColumns === columns)
      this.scrollOffset = Math.max(0, this.scrollOffset + wrapped.length - this.transcriptLength);
    this.transcriptLength = wrapped.length;
    const maxScroll = Math.max(0, wrapped.length - available);
    this.scrollOffset = Math.min(maxScroll, this.scrollOffset);
    const end = wrapped.length - this.scrollOffset;
    const start = Math.max(0, end - available);
    const shown = wrapped.slice(start, end);
    const top = rows - composer.length - shown.length;
    this.viewport = [...Array.from({ length: top }, () => plain("")), ...shown, ...composer];
    const target = Math.min(rows - 1, top + shown.length + Math.min(safeIndex(row), composer.length - 1));
    this.writeFixed(this.viewport, target, safeColumn(column, columns));
  }
  // RichLine snapshots are immutable. Reuse styled bytes for static transcript
  // rows across spinner ticks; reset on theme changes so colors never go stale.
  private styledRows = new WeakMap<RichLine, string>();
  private styledTheme: Theme | undefined;
  private writeFixed(lines: readonly RichLine[], target: number, column: number): void {
    const { columns: rawColumns, rows: rawRows } = this.dimensions();
    const columns = positiveDimension(rawColumns);
    const rows = positiveDimension(rawRows);
    if (this.styledTheme !== this.theme) {
      this.styledRows = new WeakMap();
      this.styledTheme = this.theme;
    }
    const desired = lines.map(line => {
      const cached = this.styledRows.get(line);
      if (cached !== undefined) return cached;
      const styled = renderRichLine(line, this.theme);
      this.styledRows.set(line, styled);
      return styled;
    });
    const resized = this.fixedColumns !== columns || this.fixedRows !== rows;
    const changed = Array.from({ length: rows }, (_, i) => i)
      .filter((i) => resized || desired[i] !== this.fixedRendered[i]);
    if (!changed.length && target === this.fixedTarget && column === this.fixedColumn) return;
    let output = "\x1b[?2026h\x1b[?25l";
    if (resized) output += "\x1b[2J";
    for (const i of changed) output += `\x1b[${i + 1};1H\x1b[2K${desired[i] ?? ""}`;
    output += `\x1b[${target + 1};${column + 1}H\x1b[?25h\x1b[?2026l`;
    this.output.write(output);
    this.fixedRendered = desired;
    this.fixedColumns = columns;
    this.fixedRows = rows;
    this.fixedTarget = target;
    this.fixedColumn = column;
  }
  clear(): void {
    if (this.fixed) {
      this.fixedRendered = [];
      this.fixedRows = 0;
      return;
    }
    if (!this.count) {
      this.reset();
      return;
    }
    let bytes = this.top();
    for (let i = 0; i < this.count; i++) bytes += `${i ? "\r\n" : ""}\x1b[2K`;
    if (this.count > 1) bytes += `\x1b[${this.count - 1}A`;
    this.output.write(`${bytes}\r`);
    this.reset();
  }
  append(lines: readonly RichLine[]): void {
    if (this.fixed) {
      if (!lines.length) return;
      this.historyDirty = true;
      this.history.push(...lines);
      // Bound retained transcript; persisted sessions can be reopened for older content.
      if (this.history.length > 4000) this.history.splice(0, this.history.length - 4000);
      return;
    }
    this.clear();
    const width = positiveDimension(this.dimensions().columns);
    for (const line of wrapRichLines(lines, width))
      this.output.write(
        `${renderRichLine(line, this.theme)}${this.enabled ? "\r\n" : "\n"}`,
      );
  }
  paint(lines: readonly RichLine[], row: number, column: number): void {
    if (!this.enabled) return;
    if (this.fixed) { this.paintFixed(lines, row, column); return; }
    const frame = this.frame(lines, row, column);
    if (!frame.rendered.length) {
      this.clear();
      return;
    }
    const dimensionsChanged =
      this.count > 0 &&
      (this.columns !== frame.columns || this.rows !== frame.rows);
    if (
      !this.count ||
      dimensionsChanged ||
      this.count !== frame.rendered.length
    ) {
      if (this.count) {
        if (this.columns !== frame.columns) this.invalidate();
        else this.clear();
      }
      this.drawFull(frame.rendered, frame.target, frame.column);
      this.commit(frame);
      return;
    }
    const changedRows = frame.rendered.flatMap((line, index) =>
      line === this.rendered[index] ? [] : [index],
    );
    const cursorChanged =
      frame.target !== this.cursorRow || frame.column !== this.cursorColumn;
    if (!changedRows.length && !cursorChanged) return;
    if (changedRows.length) {
      this.updateRows(frame.rendered, changedRows, frame.target, frame.column);
    } else {
      this.output.write(
        this.moveCursor(this.cursorRow, frame.target, frame.column),
      );
    }
    this.commit(frame);
  }
  invalidate(): void {
    if (this.fixed) { this.clearSelection(); this.fixedRendered = []; this.fixedRows = 0; return; }
    const columns = positiveDimension(this.dimensions().columns);
    // Normal-screen terminals preserve the cursor's physical line during
    // reflow. Its column is clamped, not wrapped into an extra row. Counting
    // that extra row moves clear() above our frame and erases committed output
    // when width and height shrink together.
    const heights = this.widths.map((width, row) =>
      row === this.cursorRow ? 1 : Math.max(1, Math.ceil(width / columns)),
    );
    const cursor = heights
      .slice(0, this.cursorRow)
      .reduce((sum, value) => sum + value, 0);
    this.count = heights.reduce((sum, value) => sum + value, 0);
    this.cursorRow = cursor;
    this.clear();
  }
}
