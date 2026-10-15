import { graphemeWidth, graphemes } from "../../../src/cli/theme";
import type { RichLine, Span } from "../../../src/cli/ui-contract";

export interface Cell { row: number; column: number }
const compare = (a: Cell, b: Cell) => a.row - b.row || a.column - b.column;

/** Selection owns a snapshot: asynchronous output cannot invalidate its cells. */
export class ScreenSelection {
  focus: Cell;
  constructor(readonly lines: readonly RichLine[], readonly anchor: Cell) {
    this.focus = anchor;
  }
  private range(row: number): [number, number] | undefined {
    const [start, end] = compare(this.anchor, this.focus) <= 0
      ? [this.anchor, this.focus] : [this.focus, this.anchor];
    if (row < start.row || row > end.row) return undefined;
    return [row === start.row ? start.column : 0, row === end.row ? end.column : Infinity];
  }
  private spans(line: RichLine, row: number): { span: Span; selected: boolean }[] {
    const range = this.range(row);
    let column = 0;
    const result: { span: Span; selected: boolean }[] = [];
    for (const span of line) {
      for (const glyph of graphemes(span.text)) {
        const width = graphemeWidth(glyph);
        const selected = !!range && column + Math.max(1, width) > range[0] && column <= range[1];
        result.push({ span: { ...span, text: glyph }, selected });
        column += width;
      }
    }
    return result;
  }
  highlight(): readonly RichLine[] {
    return this.lines.map((line, row) => this.spans(line, row)
      .map(({ span, selected }) => selected ? { ...span, inverse: true } : span));
  }
  text(): string {
    return this.lines.flatMap((line, row) => this.range(row)
      ? [this.spans(line, row).filter((item) => item.selected).map((item) => item.span.text).join("").trimEnd()]
      : []).join("\n");
  }
}
