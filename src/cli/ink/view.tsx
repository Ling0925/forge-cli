import { Box } from "ink";
import { useMemo, type ReactElement } from "react";
import { compactTokens } from "../render/token-count";
import { wrapRichLines } from "../render/rich";
import { contextFooter } from "../terminal/context-footer";
import type { RichLine } from "../ui-contract";
import { ApprovalInput, Composer, editorRows, Picker, SlashSuggestions } from "./input-components";
import { focusedEditor, type InputState } from "./input-state";
import { line, RichRow, single, spinner, type Appearance } from "./rich-row";
import { dockLayout } from "./layout";
import { Committed } from "./output";
import type { InkViewState } from "./types";

function statusLine(state: InkViewState): RichLine | null {
  const status = state.status;
  if (!status) return null;
  const frame = state.screenReader ? "" : spinner[Math.floor(state.now / 80) % spinner.length] ?? "⠋";
  const tokens = status.tokens === undefined ? "?" : `${status.tokensEstimated ? "≈" : ""}${compactTokens(status.tokens)}`;
  const seconds = Math.max(0, Math.floor((state.now - status.startedAt) / 1000));
  const activity = `${single(status.label)}${frame && (status.observing || status.cancellable) ? ` ${frame}` : ""}`;
  if (status.observing || state.screenReader) return line(activity, "muted");
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

/** Bounded live region; committed output is delivered through Ink's stdout context. */
export function InkView({ state, input }: { state: InkViewState; input: InputState }): ReactElement {
  const width = Math.max(1, Math.floor(state.columns) - 1);
  const limit = Math.max(0, Math.floor(state.rows) - 1);
  const appearance: Appearance = { theme: state.theme, noColor: state.noColor || (state.colorDepth ?? 8) < 4,
    colorDepth: state.colorDepth ?? 8, now: state.screenReader ? 0 : state.now };
  const picking = input.focus.kind === "picker";
  const fresh = input.focus.kind === "approval";
  const editor = focusedEditor(input);
  const editorRoom = Math.max(1, Math.min(6, Math.floor(limit / 3) || 1));
  const editorProps = {
    editor, prefix: input.prompt,
    hint: fresh ? null : state.inputHint ?? "Ask anything · / commands · PgUp read",
    tone: fresh || state.mode === "plan" ? "warning" as const : "accent" as const,
    width, maxLines: limit ? editorRoom : 0, appearance,
  };
  const preparedEditor = useMemo(() => editorRows(editorProps),
    [editor, input.prompt, editorProps.hint, editorProps.tone, width, editorProps.maxLines, appearance.noColor]);
  const wrappedTail = useMemo(() => wrapRichLines(state.tail, width), [state.tail, width]);
  const extras: RichLine[] = [];
  const status = statusLine(state);
  if (status) extras.push(status);
  if (!fresh && !input.menu.active) {
    const plan = planLine(state);
    if (plan) extras.push(plan);
    extras.push(...state.pendingInput.slice(0, 2).map(pending => line(single(pending), "accent")));
    if (state.context) extras.push(...contextFooter(state.context, width, state.rows <= 20));
  }
  const geometry = dockLayout(state.rows, preparedEditor.length, extras.length, input.menu.active && !fresh, picking, wrappedTail.length > 0);
  let visibleTail = wrappedTail.slice(-geometry.tail);
  if (!geometry.tail) visibleTail = [];
  else if (wrappedTail.length > geometry.tail && geometry.tail >= 2)
    visibleTail = [line(`↑ ${wrappedTail.length - geometry.tail + 1} earlier lines · PgUp read`, "muted"), ...wrappedTail.slice(-(geometry.tail - 1))];
  const reading = state.reading;
  const readRows = Math.max(0, limit - 1);
  const readingRows = reading ? reading.lines.slice(Math.max(0, reading.end - readRows), reading.end) : [];
  return <>
    <Committed output={state.output} />
    <Box flexDirection="column" width={width}>
      {reading ? <>
        {readingRows.map((spans, index) => <RichRow key={`read-${index}`} spans={spans} appearance={{ ...appearance, now: 0 }} width={width} />)}
        {limit > 0 && <RichRow spans={line(`Reading ${Math.max(1, reading.end - readRows + 1)}–${reading.end}/${reading.lines.length} · PgUp/PgDn · End/Esc live`, "muted")} appearance={appearance} width={width} />}
      </> : <>
        {visibleTail.map((spans, index) => <RichRow key={`tail-${index}`} spans={spans} appearance={appearance} width={width} />)}
        {input.focus.kind === "picker" ? <Picker focus={input.focus} width={width} limit={geometry.picker} appearance={appearance} />
          : input.focus.kind === "approval" ? <ApprovalInput {...editorProps} rows={preparedEditor} /> : <Composer {...editorProps} rows={preparedEditor} />}
        {!!geometry.menu && <SlashSuggestions menu={input.menu} limit={geometry.menu} width={width} appearance={appearance} />}
        {!picking && extras.slice(0, geometry.extras).map((spans, index) => <RichRow key={`extra-${index}`} spans={spans} appearance={appearance} width={width} />)}
      </>}
    </Box>
  </>;
}
