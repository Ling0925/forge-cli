import { wrapRichLines } from "../render/rich";
import type { SlashMenu } from "../slash-menu";
import { graphemes, truncate, visibleWidth } from "../theme";
import type { PickerSpec, RichLine, RunStatus } from "../ui-contract";
import type { Editor } from "./editor";
import { type Screen, composerLayout, plain } from "./screen";

export interface Picker {
  spec: PickerSpec;
  editor: Editor;
  index: number;
  resolve(value: string | null): void;
}
export interface View {
  columns: number;
  rows: number;
  screen: Screen;
  picker: Picker | undefined;
  editor: Editor;
  prompt: string;
  fresh: boolean;
  menu: SlashMenu;
  status: RunStatus | null;
  tail: readonly RichLine[];
  filtered(): PickerSpec["items"];
}
export function draw(view: View): void {
  if (!view.screen.enabled) return;
  // Keep unfinished output a compact preview, never a viewport-sized frame.
  const limit = Math.max(1, Math.min(10, view.rows - 1));
  const picker = view.picker;
  const editor = picker?.editor ?? view.editor;
  const prefix = picker ? `${picker.spec.title}: ` : view.prompt;
  const layout = composerLayout(
    prefix + editor.text,
    prefix.length + editor.cursor,
    view.columns,
  );
  const start = Math.max(
    0,
    layout.row - Math.max(0, Math.floor(limit / 2) - 1),
  );
  let prefixRemaining = prefix.length;
  const styled = layout.lines.map((line): RichLine => {
    const text = line.map((span) => span.text).join("");
    const length = Math.min(prefixRemaining, text.length);
    prefixRemaining -= length;
    return [
      { text: text.slice(0, length), tone: "accent" },
      { text: text.slice(length) },
    ];
  });
  if (!editor.text && !picker && !view.fresh && layout.lines.length === 1) {
    styled[0] = [
      ...(styled[0] ?? []),
      {
        text: truncate(
          "Ask anything · / for commands",
          Math.max(0, view.columns - visibleWidth(prefix)),
        ),
        tone: "muted",
      },
    ];
  }
  const composer = styled.slice(start, start + limit);
  const room = limit - composer.length;
  let below: RichLine[] = [];
  if (picker) {
    const items = view.filtered();
    // Only the selected item expands. Reserve one item before allocating details.
    const details = (items[picker.index]?.detail ?? "")
      .split("\n")
      .filter(Boolean);
    const detailCount = Math.min(details.length, 2, Math.max(0, room - 1));
    const optionRoom = Math.max(0, room - detailCount);
    const hidden = items.length > Math.min(8, optionRoom);
    const cueRow = hidden && optionRoom > 1 ? 1 : 0;
    const count = Math.min(8, optionRoom - cueRow, items.length);
    const first = Math.max(
      0,
      Math.min(picker.index - Math.floor(count / 2), items.length - count),
    );
    below = items.slice(first, first + count).map((item, index) => [
      {
        text: truncate(
          `${first + index === picker.index ? "❯" : " "} ${item.label}`,
          view.columns,
        ),
        inverse: first + index === picker.index,
      },
    ]);
    if (hidden && count) {
      const range = `${first + 1}–${first + count}/${items.length}`;
      if (cueRow) {
        below.push([
          {
            text: truncate(`${range} · ↑↓ move · type to filter`, view.columns),
            tone: "muted",
          },
        ]);
      } else {
        // No spare row: retain the option and cursor, compact the range inline.
        const line = below[0];
        if (line) {
          const suffix = truncate(` ${range}`, view.columns);
          below[0] = [
            {
              text: truncate(
                line[0]?.text ?? "",
                Math.max(0, view.columns - visibleWidth(suffix)),
              ),
              inverse: true,
            },
            { text: suffix, tone: "muted" },
          ];
        }
      }
    }
    for (const detail of details.slice(0, detailCount)) {
      // Preserve both ends of long paths/details, using actual grapheme widths.
      const width = Math.max(1, view.columns);
      let text = detail;
      if (visibleWidth(text) > width) {
        const left = Math.max(1, Math.floor((width - 1) / 2));
        let suffix = text;
        while (suffix && visibleWidth(suffix) > width - left - 1) {
          suffix = graphemes(suffix).slice(1).join("");
        }
        let head = "";
        for (const glyph of graphemes(text)) {
          if (visibleWidth(head + glyph) > left) break;
          head += glyph;
        }
        text = `${head}…${suffix}`;
      }
      below.push([{ text: truncate(text, width), tone: "muted" }]);
    }
    if (!items.length && room)
      below = [plain(picker.spec.emptyLabel ?? "No matches")];
  } else if (view.menu.isActive && room) {
    const state = view.menu.state;
    const hidden = state.items.length > Math.min(8, room);
    const cueRow = hidden && room > 1 ? 1 : 0;
    const count = Math.min(8, room - cueRow, state.items.length);
    const first = Math.max(
      0,
      Math.min(
        state.selectedIndex - Math.floor(count / 2),
        state.items.length - count,
      ),
    );
    const nameWidth = Math.max(
      ...state.items.map((item) => visibleWidth(item.name)),
    );
    below = state.items.slice(first, first + count).map((item, index) => {
      const selected = first + index === state.selectedIndex;
      const name = `${item.name}${" ".repeat(nameWidth - visibleWidth(item.name) + 2)}`;
      const label = truncate(
        name + item.description,
        Math.max(1, view.columns - 2),
      );
      return [
        {
          text: `${selected ? "❯" : " "} `,
          tone: selected ? "accent" : "text",
          inverse: selected,
        },
        { text: label, inverse: selected },
      ];
    });
    if (hidden && count) {
      const range = `${first + 1}–${first + count}/${state.items.length}`;
      if (cueRow) {
        below.push([
          {
            text: truncate(`${range} · ↑↓ move · type to filter`, view.columns),
            tone: "muted",
          },
        ]);
      } else {
        const line = below[0];
        if (line) {
          const suffix = truncate(` ${range}`, view.columns);
          below[0] = [
            {
              text: truncate(
                line.map((span) => span.text).join(""),
                Math.max(0, view.columns - visibleWidth(suffix)),
              ),
              inverse: true,
            },
            { text: suffix, tone: "muted" },
          ];
        }
      }
    }
  }
  const available = limit - composer.length - below.length;
  const status =
    view.status && available
      ? [
          [
            {
              text: truncate(
                `${view.status.label} · ${Math.max(0, Math.floor((Date.now() - view.status.startedAt) / 1000))}s · ${view.status.toolCount} tools${view.status.cancellable ? " · Ctrl+C cancel" : ""}`,
                view.columns,
              ),
              tone: "muted" as const,
            },
          ],
        ]
      : [];
  const spacer = available > status.length && view.rows >= 6 ? [plain("")] : [];
  const tailRoom = Math.max(
    0,
    Math.min(3, available - status.length - spacer.length),
  );
  const tail = tailRoom
    ? wrapRichLines(view.tail, view.columns).slice(-tailRoom)
    : [];
  const above = [...spacer, ...tail, ...status];
  view.screen.paint(
    [...above, ...composer, ...below],
    above.length + layout.row - start,
    layout.column,
  );
}
