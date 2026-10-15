import { Box, Static } from "ink";
import type { ReactElement } from "react";
import { compactTokens } from "../render/token-count";
import { wrapRichLines } from "../render/rich";
import { contextFooter } from "../terminal/context-footer";
import type { RichLine } from "../ui-contract";
import { ApprovalInput, Composer, editorRows, menuRows, Picker, SlashSuggestions } from "./input-components";
import { focusedEditor, type InputState } from "./input-state";
import { line, RichRow, single, spinner, type Appearance } from "./rich-row";
import type { InkViewState } from "./types";

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

/** Pure component tree. Only the focused input component is mounted. */
export function InkView({ state, input }: { state: InkViewState; input: InputState }): ReactElement {
  const width = Math.max(1, Math.floor(state.columns) - 1);
  const limit = Math.max(0, Math.min(20, Math.floor(state.rows) - 1));
  const appearance: Appearance = { theme: state.theme, noColor: state.noColor, now: state.now };
  const picking = input.focus.kind === "picker";
  const fresh = input.focus.kind === "approval";
  const menu = input.menu;
  const editorRoom = Math.max(1, Math.min(4, Math.floor(limit / 3) || 1));
  const editorProps = {
    editor: focusedEditor(input), prefix: input.prompt,
    hint: fresh ? null : state.inputHint ?? "Ask anything · / for commands",
    tone: state.mode === "plan" ? "warning" as const : "accent" as const,
    width, maxLines: limit ? editorRoom : 0, appearance,
  };
  const editorHeight = picking ? 0 : editorRows(editorProps).length;
  const reserve = Number(!!state.status || (state.tail.length > 0 && limit >= 4));
  const menuLimit = !picking && !fresh && menu.active ? Math.max(0, limit - editorHeight - reserve) : 0;
  const menuHeight = menuRows(menu, menuLimit).length;
  const extras: RichLine[] = [];
  const status = statusLine(state);
  if (status) extras.push(status);
  if (!fresh && !menu.active) {
    const plan = planLine(state);
    if (plan) extras.push(plan);
    extras.push(...state.pendingInput.slice(0, 2).map(pending => line(single(pending), "accent")));
    if (state.context) extras.push(...contextFooter(state.context, width, state.rows <= 20));
  }
  const tailReserve = state.tail.length && limit >= 3 ? 1 : 0;
  const visibleExtras = picking ? [] : extras.slice(0, Math.max(0, limit - editorHeight - menuHeight - tailReserve));
  const tailRoom = picking ? 0 : Math.max(0, limit - editorHeight - menuHeight - visibleExtras.length);
  const visibleTail = tailRoom ? wrapRichLines(state.tail.slice(-tailRoom), width).slice(-tailRoom) : [];
  return <>
    <Static items={[...state.history]}>{entry => <Box key={entry.id} flexDirection="column">
      {wrapRichLines([entry.line], width).map((spans, index) => <RichRow key={index} spans={spans} appearance={appearance} width={width} />)}
    </Box>}</Static>
    <Box flexDirection="column">
      {visibleTail.map((spans, index) => <RichRow key={`tail-${index}`} spans={spans} appearance={appearance} width={width} />)}
      {input.focus.kind === "picker" ? <Picker focus={input.focus} width={width} limit={limit} appearance={appearance} />
        : input.focus.kind === "approval" ? <ApprovalInput {...editorProps} /> : <Composer {...editorProps} />}
      {!!menuLimit && <SlashSuggestions menu={menu} limit={menuLimit} width={width} appearance={appearance} />}
      {visibleExtras.map((spans, index) => <RichRow key={`extra-${index}`} spans={wrapRichLines([spans], width)[0] ?? []} appearance={appearance} width={width} />)}
    </Box>
  </>;
}
