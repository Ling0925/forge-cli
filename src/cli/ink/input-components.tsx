import { Box } from "ink";
import type { ReactElement } from "react";
import type { SlashMenuState } from "../slash-menu";
import { wrapRichLines } from "../render/rich";
import { sanitizeText } from "../render/sanitize";
import { graphemes } from "../render/width";
import type { RichLine, Tone } from "../ui-contract";
import type { InputEditor } from "./input-editor";
import { pickerItems, type InputFocus } from "./input-state";
import { line, RichRow, single, spinner, type Appearance } from "./rich-row";

interface EditorProps {
  readonly editor: Pick<InputEditor, "text" | "cursor">;
  readonly prefix: string;
  readonly hint: string | null;
  readonly tone: Tone;
  readonly width: number;
  readonly maxLines: number;
  readonly appearance: Appearance;
  readonly rows?: readonly RichLine[];
}
/** Pure layout shared with the dock's height budget; the component owns its rows. */
export function editorRows({ editor, prefix, hint, tone, width, maxLines, appearance }: EditorProps): readonly RichLine[] {
  if (maxLines <= 0) return [];
  const position = Math.max(0, Math.min(editor.text.length, editor.cursor));
  const before = sanitizeText(editor.text.slice(0, position));
  const after = sanitizeText(editor.text.slice(position));
  const next = graphemes(after)[0];
  const cursorChar = next && next !== "\n" ? next : " ";
  const rest = next && next !== "\n" ? after.slice(next.length) : after;
  const spans: RichLine = [
    { text: single(prefix), tone }, { text: before },
    { text: appearance.noColor ? "▏" : cursorChar, inverse: !appearance.noColor },
    { text: appearance.noColor ? after : rest },
    ...(!editor.text && hint ? [{ text: single(hint), tone: "muted" as const }] : []),
  ];
  const rows = wrapRichLines([spans], width);
  const cursorRow = Math.max(0, wrapRichLines([spans.slice(0, 3)], width).length - 1);
  const start = Math.max(0, Math.min(cursorRow - Math.floor(maxLines / 2), rows.length - maxLines));
  return rows.slice(start, start + maxLines);
}
export function Composer(props: EditorProps): ReactElement {
  return <Box flexDirection="column">{(props.rows ?? editorRows(props)).map((spans, index) =>
    <RichRow key={index} spans={spans} appearance={props.appearance} width={props.width} />)}</Box>;
}
export function ApprovalInput(props: Omit<EditorProps, "hint" | "tone">): ReactElement {
  return <Composer {...props} hint={null} tone="warning" />;
}
const windowStart = (index: number, count: number, total: number) => Math.max(0, Math.min(index - Math.floor(count / 2), total - count));

export function Picker({ focus, width, limit, appearance }: {
  focus: Extract<InputFocus, { kind: "picker" }>; width: number; limit: number; appearance: Appearance;
}): ReactElement | null {
  if (limit <= 0) return null;
  const items = pickerItems(focus);
  const titleRows = Number(limit >= 4);
  const room = Math.max(0, limit - titleRows - 1);
  const selected = Math.max(0, Math.min(focus.index, items.length - 1));
  const details = sanitizeText(items[selected]?.detail ?? "").split("\n").filter(Boolean);
  const help = room >= 2;
  const detailCount = Math.min(2, details.length, Math.max(0, room - Number(help) - 1));
  const optionRoom = Math.max(0, room - Number(help) - detailCount);
  const cue = items.length > optionRoom && optionRoom >= 2;
  const count = Math.min(items.length, optionRoom - Number(cue));
  const first = windowStart(selected, count, items.length);
  const frame = spinner[Math.floor(appearance.now / 80) % spinner.length] ?? "⠋";
  const rows: RichLine[] = items.slice(first, first + count).map((item, i) => [
    { text: first + i === selected ? "❯ " : "  ", tone: "accent", inverse: first + i === selected },
    { text: `${item.active ? `${frame} ` : ""}${single(item.label)}`, inverse: first + i === selected },
  ]);
  if (cue) rows.push(line(`${first + 1}–${first + count}/${items.length} matches · ↑↓ move`, "muted"));
  if (!items.length && optionRoom) rows.push(line(single(focus.spec.emptyLabel ?? "No matches"), "muted"));
  for (const detail of details.slice(0, detailCount)) rows.push(line(single(detail), "muted"));
  if (help) rows.push(line(focus.spec.confirmation ? "Enter confirm · Esc cancel · ↑↓ move" : "Enter select · Esc back · ↑↓ move", "muted"));
  return <Box flexDirection="column">
    {!!titleRows && <RichRow spans={line(single(focus.spec.title), "accent")} width={width} appearance={appearance} />}
    <Composer editor={focus.editor} prefix={width >= 3 ? "❯ " : ""}
      hint={focus.spec.placeholder ?? (focus.spec.confirmation ? "Choose an action…" : "Type to filter…")}
      tone="accent" width={width} maxLines={1} appearance={appearance} />
    {rows.map((spans, index) => <RichRow key={index} spans={wrapRichLines([spans], width)[0] ?? []} width={width} appearance={appearance} />)}
  </Box>;
}
export function menuRows(menu: SlashMenuState, limit: number): readonly RichLine[] {
  const items = menu.items;
  if (!menu.active || !items.length || limit <= 0) return [];
  const cue = items.length > Math.min(8, limit) && limit > 1;
  const count = Math.min(items.length, 8, limit - Number(cue));
  const first = windowStart(Math.max(0, Math.min(menu.selectedIndex, items.length - 1)), count, items.length);
  const rows: RichLine[] = items.slice(first, first + count).map((item, i) => [
    { text: first + i === menu.selectedIndex ? "❯ " : "  ", tone: "accent", inverse: first + i === menu.selectedIndex },
    { text: `${single(item.name)}  `, tone: "accent", inverse: first + i === menu.selectedIndex },
    { text: single(item.description), tone: "muted", inverse: first + i === menu.selectedIndex },
  ]);
  if (cue) rows.push(line(`${first + 1}–${first + count}/${items.length} · ↑↓ move · type to filter`, "muted"));
  return rows;
}
export function SlashSuggestions({ menu, limit, width, appearance }: {
  menu: SlashMenuState; limit: number; width: number; appearance: Appearance;
}): ReactElement {
  return <Box flexDirection="column">{menuRows(menu, limit).map((spans, index) =>
    <RichRow key={index} spans={wrapRichLines([spans], width)[0] ?? []} width={width} appearance={appearance} />)}</Box>;
}
