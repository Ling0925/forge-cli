import { Box, Static, Text } from "ink";
import type { ReactElement } from "react";
import { compactTokens } from "../render/token-count";
import { wrapRichLines } from "../render/rich";
import { sanitizeText } from "../render/sanitize";
import { graphemes } from "../render/width";
import { contextFooter } from "../terminal/context-footer";
import type { RichLine, Tone } from "../ui-contract";
import type { InkViewState } from "./types";

const spinner = [..."⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"];
const line = (text: string, tone: Tone = "text"): RichLine => [{ text: sanitizeText(text), tone }];
const single = (text: string): string => sanitizeText(text).replace(/[\n\t]/g, " ");

// Ink owns the escape sequences. In particular, diff word backgrounds must not
// be flattened to ordinary success/error foregrounds.
const palette: Record<"light" | "dark", Partial<Record<Tone, { color?: string; backgroundColor?: string }>>> = {
  light: {
    muted: { color: "#5c6357" }, accent: { color: "#55684d" },
    success: { color: "#226d40" }, warning: { color: "#975a06" }, error: { color: "#b82420" },
    diffAdded: { color: "#205e27", backgroundColor: "#d6efd1" },
    diffRemoved: { color: "#813032", backgroundColor: "#f6d9db" },
    diffAddedWord: { color: "#16491c", backgroundColor: "#a5e3a1" },
    diffRemovedWord: { color: "#641c20", backgroundColor: "#edb4ba" },
    contextInstructions: { color: "#165d85" }, contextMemory: { color: "#754a8e" },
    contextConversation: { color: "#226d40" }, contextTools: { color: "#975a06" },
  },
  dark: {
    muted: { color: "#a4aca0" }, accent: { color: "#8fad82" },
    success: { color: "#7ed99e" }, warning: { color: "#f0be65" }, error: { color: "#ff8f85" },
    diffAdded: { color: "#b7e9b8", backgroundColor: "#1c4c25" },
    diffRemoved: { color: "#f1c2c4", backgroundColor: "#51252a" },
    diffAddedWord: { color: "#ffffff", backgroundColor: "#24763c" },
    diffRemovedWord: { color: "#ffffff", backgroundColor: "#8b3035" },
    contextInstructions: { color: "#83bde9" }, contextMemory: { color: "#d2a2e9" },
    contextConversation: { color: "#7ed99e" }, contextTools: { color: "#f0be65" },
  },
};

type Appearance = Pick<InkViewState, "theme" | "noColor" | "now">;

function RichRow({ spans, appearance, width }: { spans: RichLine; appearance: Appearance; width: number }): ReactElement {
  const colors = appearance.noColor || appearance.theme === "system" ? null : palette[appearance.theme];
  const frame = spinner[Math.floor(appearance.now / 80) % spinner.length] ?? "⠋";
  return <Box flexDirection="row" width={width} height={1} flexShrink={0}><Text wrap="truncate">
    {spans.map((span, index) => {
      const style = colors?.[span.tone ?? "text"];
      // Never pass data as terminal markup; every span, including static history,
      // goes through the same control filter before Ink receives it.
      const text = span.animation === "spinner" ? frame : sanitizeText(span.text).replace(/\n/g, " ").replace(/\t/g, "    ");
      return <Text key={index} {...style}
        bold={!appearance.noColor && !!span.bold} inverse={!appearance.noColor && !!span.inverse}>{text}</Text>;
    })}
  </Text></Box>;
}

function cursorLine(prefix: string, value: string, offset: number, hint: string | null, noColor: boolean): RichLine {
  const position = Math.max(0, Math.min(value.length, offset));
  const before = sanitizeText(value.slice(0, position));
  const after = sanitizeText(value.slice(position));
  const next = graphemes(after)[0];
  const cursorChar = next && next !== "\n" ? next : " ";
  const rest = next && next !== "\n" ? after.slice(next.length) : after;
  return [
    { text: single(prefix), tone: "accent" },
    { text: before },
    // NO_COLOR still has a visible insertion point without terminal styling.
    { text: noColor ? "▏" : cursorChar, inverse: !noColor },
    { text: noColor ? after : rest },
    ...(!value && hint ? [{ text: single(hint), tone: "muted" as const }] : []),
  ];
}

function editorLines(state: InkViewState, width: number, maxLines: number, picker: boolean): readonly RichLine[] {
  if (!maxLines) return [];
  const prefix = picker ? (width >= 3 ? "❯ " : "") : state.prompt;
  const hint = picker
    ? state.picker?.spec.placeholder ?? (state.picker?.spec.confirmation ? "Choose an action…" : "Type to filter…")
    : state.fresh ? null : state.inputHint ?? "Ask anything · / for commands";
  const composed = cursorLine(prefix, state.text, state.cursor, hint, state.noColor);
  const styled: RichLine = picker ? composed : [
    { ...composed[0]!, tone: state.mode === "plan" ? "warning" : "accent" },
    ...composed.slice(1),
  ];
  const lines = wrapRichLines([styled], width);
  // Measure the same prefix and cursor glyph as the displayed line so a cursor
  // after a wrap (or at the start of a new line) stays inside the viewport.
  const cursorSpans = composed.slice(0, 3);
  const cursorRow = Math.max(0, wrapRichLines([cursorSpans], width).length - 1);
  const start = Math.max(0, Math.min(cursorRow - Math.floor(maxLines / 2), lines.length - maxLines));
  return lines.slice(start, start + maxLines);
}

function windowStart(index: number, count: number, total: number): number {
  return Math.max(0, Math.min(index - Math.floor(count / 2), total - count));
}

function pickerLines(state: InkViewState, width: number, limit: number): RichLine[] {
  const picker = state.picker;
  if (!picker || !limit) return [];
  const result: RichLine[] = [];
  if (limit >= 4) result.push(line(single(picker.spec.title), "accent"));
  result.push(...editorLines(state, width, 1, true));
  const room = limit - result.length;
  const selected = Math.max(0, Math.min(picker.index, picker.items.length - 1));
  const details = sanitizeText(picker.items[selected]?.detail ?? "").split("\n").filter(Boolean);
  // Reserve a result (or the empty-state label) before showing navigation help.
  const help = room >= 2;
  const detailCount = Math.min(2, details.length, Math.max(0, room - Number(help) - 1));
  const optionRoom = Math.max(0, room - Number(help) - detailCount);
  const cue = picker.items.length > optionRoom && optionRoom >= 2;
  const count = Math.min(picker.items.length, optionRoom - Number(cue));
  const first = windowStart(selected, count, picker.items.length);
  const frame = spinner[Math.floor(state.now / 80) % spinner.length] ?? "⠋";
  for (let i = first; i < first + count; i++) {
    const item = picker.items[i];
    if (!item) continue;
    const active = i === selected;
    result.push([
      { text: active ? "❯ " : "  ", tone: "accent", inverse: active },
      { text: `${item.active ? `${frame} ` : ""}${single(item.label)}`, inverse: active },
    ]);
  }
  if (cue) result.push(line(`${first + 1}–${first + count}/${picker.items.length} matches · ↑↓ move`, "muted"));
  if (!picker.items.length && optionRoom) result.push(line(single(picker.spec.emptyLabel ?? "No matches"), "muted"));
  for (const detail of details.slice(0, detailCount)) result.push(line(single(detail), "muted"));
  if (help) result.push(line(picker.spec.confirmation ? "Enter confirm · Esc cancel · ↑↓ move" : "Enter select · Esc back · ↑↓ move", "muted"));
  return result.slice(0, limit);
}

function menuLines(state: InkViewState, limit: number): RichLine[] {
  const items = state.menu.items;
  if (!state.menu.active || !items.length || limit <= 0) return [];
  const cue = items.length > Math.min(8, limit) && limit > 1;
  const count = Math.min(items.length, 8, limit - Number(cue));
  const first = windowStart(Math.max(0, Math.min(state.menu.selectedIndex, items.length - 1)), count, items.length);
  const lines: RichLine[] = [];
  for (let i = first; i < first + count; i++) {
    const item = items[i];
    if (!item) continue;
    const selected = i === state.menu.selectedIndex;
    lines.push([
      { text: selected ? "❯ " : "  ", tone: "accent", inverse: selected },
      { text: `${single(item.name)}  `, tone: "accent", inverse: selected },
      { text: single(item.description), tone: "muted", inverse: selected },
    ]);
  }
  if (cue) lines.push(line(`${first + 1}–${first + count}/${items.length} · ↑↓ move · type to filter`, "muted"));
  return lines;
}

function statusLine(state: InkViewState): RichLine | null {
  const status = state.status;
  if (!status) return null;
  const frame = spinner[Math.floor(state.now / 80) % spinner.length] ?? "⠋";
  const tokens = status.tokens === undefined ? "?" : `${status.tokensEstimated ? "≈" : ""}${compactTokens(status.tokens)}`;
  const seconds = Math.max(0, Math.floor((state.now - status.startedAt) / 1000));
  const activity = `${status.observing ? `${frame} ` : ""}${single(status.label)}${status.cancellable && !status.observing ? ` ${frame}` : ""}`;
  if (status.observing) return line(activity, "muted");
  return line(`${activity} · ${tokens} tokens · ${seconds}s · ${status.toolCount} tools${status.cancellable ? " · Ctrl+C cancel" : ""}`, "muted");
}

function planLine(state: InkViewState): RichLine | null {
  if (!state.plan) return null;
  const steps = state.plan.steps;
  const current = steps.find(step => step.status === "in_progress") ?? steps.find(step => step.status === "pending");
  const done = steps.filter(step => step.status === "completed").length;
  return line(`Plan ${done}/${steps.length} · ${current ? `${current.status === "in_progress" ? "●" : "○"} ${single(current.step)}` : "✔ done"} · /plan`,
    current?.status === "in_progress" ? "warning" : "muted");
}

/** Static owns permanent scrollback; only the bounded tail/dock is replaced. */
export function InkView({ state }: { state: InkViewState }): ReactElement {
  // Leaving one physical row free avoids Ink's terminal-bottom wrap/scroll edge.
  const width = Math.max(1, Math.floor(state.columns) - 1);
  const limit = Math.max(0, Math.min(20, Math.floor(state.rows) - 1));
  const appearance: Appearance = { theme: state.theme, noColor: state.noColor, now: state.now };
  const dock: RichLine[] = [];
  const picking = !!state.picker && !state.fresh;
  if (picking) {
    dock.push(...pickerLines(state, width, limit));
  } else if (limit) {
    const editorRoom = Math.max(1, Math.min(4, Math.floor(limit / 3) || 1));
    dock.push(...editorLines(state, width, editorRoom, false));
    if (state.menu.active) {
      const reserve = Number(!!state.status || (state.tail.length > 0 && limit >= 4));
      dock.push(...menuLines(state, Math.max(0, limit - dock.length - reserve)));
    }
    const extras: RichLine[] = [];
    const status = statusLine(state);
    if (status) extras.push(status);
    if (!state.fresh && !state.menu.active) {
      const plan = planLine(state);
      if (plan) extras.push(plan);
      extras.push(...state.pendingInput.slice(0, 2).map(pending => line(single(pending), "accent")));
      if (state.context) extras.push(...contextFooter(state.context, width, state.rows <= 20));
    }
    // Keep transcript tail replaceable without filling the entire screen; when
    // space is tight, the input and activity status take precedence over chrome.
    const tailReserve = state.tail.length && limit >= 3 ? 1 : 0;
    dock.push(...extras.slice(0, Math.max(0, limit - dock.length - tailReserve)));
  }
  const tailRoom = picking ? 0 : Math.max(0, limit - dock.length);
  const visibleTail = tailRoom ? wrapRichLines(state.tail.slice(-tailRoom), width).slice(-tailRoom) : [];
  const visibleDock = dock.map(spans => wrapRichLines([spans], width)[0] ?? []);
  // Static must be a sibling of the live region: wrapping it inside the live
  // Box would make permanent scrollback participate in dynamic reconciliation.
  return <>
    <Static items={[...state.history]}>{entry => <Box key={entry.id} flexDirection="column">
      {wrapRichLines([entry.line], width).map((spans, index) => <RichRow key={index} spans={spans} appearance={appearance} width={width} />)}
    </Box>}</Static>
    <Box flexDirection="column">
      {visibleTail.map((spans, index) => <RichRow key={`tail-${index}`} spans={spans} appearance={appearance} width={width} />)}
      {visibleDock.map((spans, index) => <RichRow key={`dock-${index}`} spans={spans} appearance={appearance} width={width} />)}
    </Box>
  </>;
}
