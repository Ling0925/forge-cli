import type { TaskPlan } from "../../shared/schemas";
import { terminalText } from "../format";
import { compactTokens } from "../render/token-count";
import { wrapRichLines } from "../render/rich";
import type { SlashMenu } from "../slash-menu";
import { truncate, visibleWidth } from "../theme";
import { pickerLayout } from "./picker-layout";
import type { ComposerContext, PickerSpec, RichLine, RunStatus } from "../ui-contract";
import { contextFooter } from "./context-footer";
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
  plan?: TaskPlan | null;
  mode?: "build" | "plan";
  menu: SlashMenu;
  status: RunStatus | null;
  notice?: string | null;
  inputHint?: string | null;
  pendingInput?: readonly string[];
  context?: ComposerContext | null;
  tail: readonly RichLine[];
  filtered(): PickerSpec["items"];
}
const animatedTails = new WeakMap<readonly RichLine[], { frame: string; lines: readonly RichLine[]; animated: boolean }>();
function animateTail(tail: readonly RichLine[], frame: string): readonly RichLine[] {
  const cached = animatedTails.get(tail);
  if (cached && (!cached.animated || cached.frame === frame)) return cached.lines;
  const animated = cached?.animated ?? tail.some(line => line.some(span => span.animation === "spinner"));
  const lines = animated ? tail.map(line => line.some(span => span.animation === "spinner")
    ? line.map(span => span.animation === "spinner" ? { ...span, text: frame } : span)
    : line) : tail;
  animatedTails.set(tail, { frame, lines, animated });
  return lines;
}

export function draw(view: View): void {
  if (!view.screen.enabled) return;
  // Bound expanded input/menus; do not fill unused rows in the dock.
  const limit = Math.max(1, Math.min(20, Math.max(4, Math.floor(view.rows * 0.45)), view.rows - 1));
  const compactFooter = view.rows <= 20;
  const itemLimit = view.rows >= 36 ? 12 : 8;
  const picker = view.fresh ? undefined : view.picker;
  const frame = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 80) % 10]!;
  if (picker) {
    const layout = pickerLayout({
      spec: picker.spec, items: view.filtered(), index: picker.index,
      text: picker.editor.text, cursor: picker.editor.cursor,
      columns: view.columns, limit, itemLimit, frame,
    });
    if (view.screen.fixed) view.screen.setTranscript(view.tail);
    view.screen.paint(layout.lines, layout.row, layout.column);
    return;
  }
  const pending = !picker && !view.fresh
    ? (view.pendingInput ?? []).slice(0, Math.min(2, Math.max(0, limit - 2))).map(line =>
      [{ text: truncate(line, view.columns), tone: "accent" as const }]) : [];
  const footer = !picker && !view.menu.isActive && !view.fresh && view.context
    ? contextFooter(view.context, view.columns, compactFooter).slice(0, Math.max(0, limit - 2 - pending.length)) : [];
  // Fixed mode reserves footer and status slots even when they are empty.
  // Background activity must not change the editor's physical row.
  const fixedFooter = view.screen.fixed ? (picker || view.menu.isActive ? 0 : Math.min(compactFooter ? 1 : 2, Math.max(0, limit - 2 - pending.length))) : footer.length;
  const footerLines = view.screen.fixed
    ? [...footer, ...Array.from({ length: Math.max(0, fixedFooter - footer.length) }, () => plain(""))]
    : footer;
  // Reserve the auxiliary row by geometry, never by activity/plan presence.
  // This keeps the editor stationary when background state changes.
  const auxiliarySlot = view.screen.fixed && view.rows >= 30 && !picker && !view.menu.isActive && !view.fresh ? 1 : 0;
  const contentLimit = limit - fixedFooter - pending.length - auxiliarySlot;
  const statusSlot = view.screen.fixed && contentLimit > 1 ? 1 : 0;
  const editor = view.editor;
  const prefix = view.prompt;
  const layout = composerLayout(
    prefix + editor.text,
    prefix.length + editor.cursor,
    view.columns,
  );
  const start = Math.max(
    0,
    layout.row - Math.max(0, Math.floor(contentLimit / 2) - 1),
  );
  let prefixRemaining = prefix.length;
  const styled = layout.lines.map((line): RichLine => {
    const text = line.map((span) => span.text).join("");
    const length = Math.min(prefixRemaining, text.length);
    prefixRemaining -= length;
    return [
      { text: text.slice(0, length), tone: !picker && !view.fresh && view.mode === "plan" ? "warning" : "accent" },
      { text: text.slice(length) },
    ];
  });
  if (!editor.text && !picker && !view.fresh && layout.lines.length === 1) {
    styled[0] = [
      ...(styled[0] ?? []),
      {
        text: truncate(
          view.inputHint ?? "Ask anything · / for commands",
          Math.max(0, view.columns - visibleWidth(prefix)),
        ),
        tone: "muted",
      },
    ];
  }
  const composer = styled.slice(start, start + (view.screen.fixed ? Math.max(1, contentLimit - statusSlot) : contentLimit));
  const room = Math.max(0, contentLimit - composer.length - statusSlot);
  let below: RichLine[] = [];
  if (view.menu.isActive && room) {
    const state = view.menu.state;
    const hidden = state.items.length > Math.min(itemLimit, room);
    const cueRow = hidden && room > 1 ? 1 : 0;
    const count = Math.min(itemLimit, room - cueRow, state.items.length);
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
  const tokenLabel = view.status?.tokens === undefined ? "?"
    : `${view.status.tokensEstimated ? "≈" : ""}${compactTokens(view.status.tokens)}`;
  const available = contentLimit - composer.length - below.length;
  const activeStep = view.plan?.steps.find(step => step.status === "in_progress") ?? view.plan?.steps.find(step => step.status === "pending");
  const done = view.plan?.steps.filter(step => step.status === "completed").length ?? 0;
  const pinned: RichLine | undefined = view.screen.fixed && !picker && !view.fresh && view.plan
    ? [{text: truncate(terminalText(`Plan ${done}/${view.plan.steps.length} · ${activeStep ? `${activeStep.status === "in_progress" ? "● [active]" : "○ [pending]"} ${activeStep.step}` : "✔ [done]"} · /plan`), view.columns), tone: activeStep?.status === "in_progress" ? "warning" : "muted"}] : undefined;
  const history: RichLine | undefined = view.screen.historyOffset > 0 && !picker && !view.fresh
    ? [{ text: truncate(`▼ History · ${view.screen.historyOffset} lines from latest · End to bottom`, view.columns), tone: "warning" }] : undefined;
  const status =
    view.status && available
      ? [
          [
            {
              text: truncate(
                view.status.observing ? `${frame} ${view.status.label} · 仅观察`
                  : `${view.status.label}${view.status.cancellable ? ` ${frame}` : ""} · ${tokenLabel} tokens · ${Math.max(0, Math.floor((Date.now() - view.status.startedAt) / 1000))}s · ${view.status.toolCount} tools${view.status.cancellable ? " · Ctrl+C cancel" : ""}`,
                view.columns,
              ),
              tone: "muted" as const,
            },
          ],
        ]
      : [];
  // A pinned plan must never hide live execution. Keep one physical status
  // slot, reserve its leading cells for activity, then fit secondary details.
  let liveStatus: RichLine | undefined;
  if (view.status && view.screen.fixed && !picker && !view.fresh) {
    const elapsed = Math.max(0, Math.floor((Date.now() - view.status.startedAt) / 1000));
    const suffix = view.status.observing ? "" : ` · ${elapsed}s`;
    const marker = view.status.cancellable || view.status.observing ? `${frame} ` : "";
    const labelWidth = Math.max(0, Math.min(24, Math.floor(view.columns / 2), view.columns - visibleWidth(marker + suffix)));
    const activity = truncate(`${marker}${truncate(terminalText(view.status.label), labelWidth)}${suffix}`, view.columns);
    const metrics = plain(view.status.observing ? "仅观察 · 未接管运行"
      : `${tokenLabel} tokens · ${view.status.toolCount} tools${view.status.cancellable ? " · Ctrl+C cancel" : ""}`);
    const detail = auxiliarySlot ? metrics : view.notice ? plain(terminalText(view.notice)) : pinned ?? history ?? metrics;
    const remaining = view.columns - visibleWidth(activity) - 3;
    liveStatus = [
      { text: activity, tone: view.status.cancellable ? "accent" : "warning" },
      ...(remaining > 0 ? [{ text: " · ", tone: "muted" as const }, { text: truncate(detail.map(span => span.text).join(""), remaining), tone: "muted" as const }] : []),
    ];
  }
  const spacer = available > status.length && view.rows >= 6 ? [plain("")] : [];
  const animatedTail = animateTail(view.tail, frame);
  const tailRoom = Math.max(
    0,
    Math.min(3, available - status.length - spacer.length),
  );
  const tail = !view.screen.fixed && tailRoom
    ? wrapRichLines(animatedTail, view.columns).slice(-tailRoom)
    : [];
  const above = view.screen.fixed ? [] : [...spacer, ...tail, ...status];
  if (view.screen.fixed) {
    view.screen.setTranscript(animatedTail);
    const auxiliary = !picker && !view.fresh && view.notice
      ? plain(truncate(terminalText(view.notice), view.columns)) : pinned ?? history ?? plain("");
    view.screen.paint(
      [...(auxiliarySlot ? [auxiliary] : []),
        ...(statusSlot ? [liveStatus ?? (auxiliarySlot ? plain("") : auxiliary)] : []),
        ...composer, ...below, ...pending, ...footerLines],
      auxiliarySlot + statusSlot + layout.row - start, layout.column,
    );
    return;
  }
  view.screen.paint(
    [...above, ...composer, ...below, ...pending, ...footer],
    above.length + layout.row - start,
    layout.column,
  );
}
