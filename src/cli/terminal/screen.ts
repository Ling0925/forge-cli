import { terminalText } from "../format";
import { renderRichLine, wrapRichLines } from "../render/rich";
import { type Theme, graphemeWidth, graphemes, visibleWidth } from "../theme";
import type { RichLine } from "../ui-contract";

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
  clear(): void {
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
    this.clear();
    const width = positiveDimension(this.dimensions().columns);
    for (const line of wrapRichLines(lines, width))
      this.output.write(
        `${renderRichLine(line, this.theme)}${this.enabled ? "\r\n" : "\n"}`,
      );
  }
  paint(lines: readonly RichLine[], row: number, column: number): void {
    if (!this.enabled) return;
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
