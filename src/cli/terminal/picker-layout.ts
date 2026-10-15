import { terminalText } from "../format";
import { graphemeWidth, graphemes, truncate, visibleWidth } from "../theme";
import type { PickerSpec, RichLine } from "../ui-contract";
import { composerLayout } from "./screen";

/** Picker data is never terminal markup, including before width measurement. */
const singleLine = (text: string): string => terminalText(text).replace(/[\n\t]/g, " ");
const fit = (text: string, columns: number): string => truncate(singleLine(text), columns);

/** Segment/measure once, then take bounded ends; no repeated suffix scans. */
export function pickerDetail(text: string, columns: number): string {
  const glyphs = graphemes(singleLine(text));
  const widths = glyphs.map(graphemeWidth);
  if (widths.reduce((sum, width) => sum + width, 0) <= columns) return glyphs.join("");
  if (columns <= 0) return "";
  const headRoom = Math.floor((columns - 1) / 2);
  const tailRoom = columns - 1 - headRoom;
  let head = 0;
  let tail = glyphs.length;
  let width = 0;
  while (head < glyphs.length && width + widths[head]! <= headRoom) width += widths[head++]!;
  width = 0;
  while (tail > head && width + widths[tail - 1]! <= tailRoom) width += widths[--tail]!;
  return `${glyphs.slice(0, head).join("")}…${glyphs.slice(tail).join("")}`;
}

export interface PickerLayoutInput {
  spec: PickerSpec;
  items: PickerSpec["items"];
  index: number;
  text: string;
  cursor: number;
  columns: number;
  limit: number;
  itemLimit: number;
  frame: string;
}

/** Presentation only: filtering, selected values and lifecycle stay in controller. */
export function pickerLayout(input: PickerLayoutInput): { lines: RichLine[]; row: number; column: number } {
  const { spec, items, index, frame } = input;
  const columns = Math.max(1, input.columns);
  const limit = Math.max(1, input.limit);
  // Always retain the input and, when physically possible, one result. Chrome
  // gets space before optional details, but never displaces the last result.
  const footer = limit >= 3;
  const title = limit >= 4;
  const lines: RichLine[] = title ? [[{ text: fit(spec.title, columns), tone: "accent", bold: true }]] : [];
  const row = lines.length;
  const prefix = columns >= 3 ? "❯ " : "";
  const text = singleLine(input.text);
  const cursor = singleLine(input.text.slice(0, input.cursor)).length;
  const editor = composerLayout(prefix + text, prefix.length + cursor, columns);
  // A single physical input viewport leaves choices visible even for long queries.
  const current = editor.lines[editor.row] ?? [];
  const content = current.map(span => span.text).join("");
  lines.push(!text ? [
    { text: prefix, tone: "accent" },
    { text: fit(spec.placeholder ?? (spec.confirmation ? "Choose an action…" : "Type to filter…"), columns - visibleWidth(prefix)), tone: "muted" },
  ] : [{ text: content }]);

  const room = Math.max(0, limit - lines.length - Number(footer));
  const details = terminalText(items[index]?.detail ?? "").split("\n").filter(Boolean);
  const detailCount = Math.min(2, details.length, Math.max(0, room - 2));
  const optionRoom = room - detailCount;
  const hidden = items.length > Math.min(input.itemLimit, optionRoom);
  const cueRow = hidden && optionRoom > 1 ? 1 : 0;
  const count = Math.min(input.itemLimit, Math.max(0, optionRoom - cueRow), items.length);
  const first = Math.max(0, Math.min(index - Math.floor(count / 2), items.length - count));
  const options: RichLine[] = items.slice(first, first + count).map((item, offset) => {
    const selected = first + offset === index;
    const marker = fit(`${selected ? "❯" : " "} `, columns);
    return [
      { text: marker, tone: selected ? "accent" : "text", inverse: selected },
      { text: fit(`${item.active ? `${frame} ` : ""}${singleLine(item.label)}`, Math.max(0, columns - visibleWidth(marker))), inverse: selected },
    ];
  });
  lines.push(...options);
  if (hidden && count) {
    const range = `${first + 1}–${first + count}/${items.length}`;
    if (cueRow) lines.push([{ text: fit(`${range} matches`, columns), tone: "muted" }]);
    else if (columns > visibleWidth(range) + 5) {
      // With no spare row preserve the option marker and some label, then range.
      const suffix = ` ${range}`;
      const option = options[0]!;
      lines[lines.length - 1] = [
        { text: fit(option.map(span => span.text).join(""), columns - visibleWidth(suffix)), inverse: index === first },
        { text: suffix, tone: "muted" },
      ];
    }
  }
  if (!items.length && room) lines.push([{ text: fit(spec.emptyLabel ?? "No matches", columns), tone: "muted" }]);
  for (const detail of details.slice(0, detailCount)) lines.push([{ text: pickerDetail(detail, columns), tone: "muted" }]);
  if (footer) lines.push([{ text: fit(spec.confirmation ? "Enter确认 · Esc取消 · ↑↓移动" : "Enter选择 · Esc返回 · ↑↓移动", columns), tone: "muted" }]);
  return { lines, row, column: editor.column };
}
