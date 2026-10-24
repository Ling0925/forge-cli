import { Box } from "ink";
import { useMemo, type ReactElement } from "react";
import { compactTokens } from "../render/token-count";
import { chrome } from "../render/labels";
import { wrapRichLines } from "../render/rich";
import { spinnerFrame, uiSymbols } from "../symbols";
import { contextFooter } from "../terminal/context-footer";
import type { RichLine } from "../ui-contract";
import { ApprovalInput, Composer, editorRows, Picker, SlashSuggestions } from "./input-components";
import { focusedEditor, type InputState } from "./input-state";
import { line, RichRow, single, type Appearance } from "./rich-row";
import { dockLayout } from "./layout";
import { Committed } from "./output";
import type { InkViewState } from "./types";

function statusLine(state: InkViewState): RichLine | null {
  const status = state.status;
  if (!status) return null;
  const symbols = uiSymbols();
  const frame = state.screenReader ? "" : spinnerFrame(state.now);
  const tokens = status.tokens === undefined ? "?" : `${status.tokensEstimated ? symbols.approximate : ""}${compactTokens(status.tokens)}`;
  const seconds = Math.max(0, Math.floor((state.now - status.startedAt) / 1000));
  const position = status.step === undefined ? "" : `turn ${status.turn ?? "?"} · step ${status.step} · `;
  const activity = `${position}${single(status.label)}${frame ? ` ${frame}` : ""}`;
  if (status.observing || state.screenReader) return line(activity, "muted");
  // Narrow rows keep the activity and elapsed time; token/tool counters and the
  // cancel reminder return as soon as there is room.
  const head = `${activity} ${symbols.separator} ${seconds}s`;
  if (state.columns < 72) return line(head, "muted");
  const detail = `${head} ${symbols.separator} ${tokens} ${chrome.tokens} ${symbols.separator} ${status.toolCount} ${chrome.tools}${status.cancellable ? ` ${symbols.separator} ${chrome.cancelHint}` : ""}`;
  return line(detail, "muted");
}
function planLine(state: InkViewState): RichLine | null {
  if (!state.plan) return null;
  const symbols = uiSymbols();
  const steps = state.plan.steps;
  const current = steps.find(step => step.status === "in_progress") ?? steps.find(step => step.status === "pending");
  const done = steps.filter(step => step.status === "completed").length;
  const progress = `Plan ${done}/${steps.length}`;
  // Below the room for progress + step + hint, keep the step itself and drop
  // the reminder; the plan stays readable without a command hint on every row.
  const body = current ? `${current.status === "in_progress" ? symbols.active : symbols.pending} ${single(current.step)}` : `${symbols.success} done`;
  const tail = ` ${symbols.separator} /plan`;
  const narrow = `${progress} ${symbols.separator} ${body}`;
  return line(state.columns < 56 ? narrow : `${narrow}${tail}`,
    current?.status === "in_progress" ? "warning" : "muted");
}

/** Ink/Yoga owns a fullscreen viewport and a non-shrinking bottom dock. */
export function InkView({ state, input }: { state: InkViewState; input: InputState }): ReactElement {
  const symbols = uiSymbols();
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
    hint: fresh ? null : state.inputHint ?? `Ask anything ${symbols.separator} / commands ${symbols.separator} PgUp read`,
    tone: fresh || state.mode === "plan" ? "warning" as const : "accent" as const,
    width, maxLines: limit ? editorRoom : 0, appearance,
  };
  const preparedEditor = useMemo(() => editorRows(editorProps),
    [editor, input.prompt, editorProps.hint, editorProps.tone, width, editorProps.maxLines, appearance.noColor, symbols]);
  const wrappedTail = useMemo(() => wrapRichLines(state.tail, width), [state.tail, width]);
  // Keep the dock's hierarchy explicit: plan, activity, suggestions, editor,
  // then queued input and model/context. All auxiliary rows share one budget.
  const aboveEditor: RichLine[] = [];
  const extras: RichLine[] = [];
  if (!fresh && !input.menu.active) {
    const plan = planLine(state);
    if (plan) aboveEditor.push(plan);
    extras.push(...state.pendingInput.slice(0, 2).map(pending => line(single(pending), "accent")));
    if (state.context) extras.push(...contextFooter(state.context, width, state.rows <= 20));
  }
  const status = statusLine(state);
  if (status) aboveEditor.push(status);
  const geometry = dockLayout(state.rows, preparedEditor.length, aboveEditor.length + extras.length, input.menu.active && !fresh, picking, wrappedTail.length > 0);
  const visibleAbove = aboveEditor.slice(0, geometry.extras);
  const visibleExtras = extras.slice(0, Math.max(0, geometry.extras - visibleAbove.length));
  let visibleTail = wrappedTail.slice(-geometry.tail);
  if (!geometry.tail) visibleTail = [];
  else if (wrappedTail.length > geometry.tail && geometry.tail >= 2)
    visibleTail = [line(`${symbols.up} ${wrappedTail.length - geometry.tail + 1} earlier lines ${symbols.separator} PgUp read`, "muted"), ...wrappedTail.slice(-(geometry.tail - 1))];
  const reading = state.reading;
  const readRows = Math.max(0, limit - 1);
  const readingRows = reading ? reading.lines.slice(Math.max(0, reading.end - readRows), reading.end) : [];
  const historyRoom = Math.max(0, geometry.tail - visibleTail.length);
  const history = historyRoom ? (state.visibleHistory ?? []).slice(-historyRoom) : [];
  // One spare physical row prevents Ink's terminal-bottom wrap/scroll edge.
  // Accessible output deliberately remains inline rather than reading blank padding.
  // RichRow already bounds horizontal cells. Clip only vertically: Ink's horizontal
  // slice-ansi path can split ZWJ clusters even when the row already fits.
  return <>
    {state.screenReader && <Committed output={state.output} />}
    <Box flexDirection="column" width={width} {...(!state.screenReader ? { height: limit } : {})}>
      {reading ? <>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
          {readingRows.map((spans, index) => <RichRow key={`read-${index}`} spans={spans} appearance={{ ...appearance, now: 0 }} width={width} />)}
        </Box>
        {limit > 0 && <RichRow spans={line(`Reading ${Math.max(1, reading.end - readRows + 1)}${symbols.range}${reading.end}/${reading.lines.length} ${symbols.separator} Wheel/PgUp/PgDn ${symbols.separator} End/Esc live`, "muted")} appearance={appearance} width={width} />}
      </> : <>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
          {history.map((spans, index) => <RichRow key={`history-${index}`} spans={spans} appearance={appearance} width={width} />)}
          {visibleTail.map((spans, index) => <RichRow key={`tail-${index}`} spans={spans} appearance={appearance} width={width} />)}
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {!picking && visibleAbove.map((spans, index) => <RichRow key={`above-${index}`} spans={spans} appearance={appearance} width={width} />)}
          {!!geometry.menu && <SlashSuggestions menu={input.menu} limit={geometry.menu} width={width} appearance={appearance} />}
          {input.focus.kind === "picker" ? <Picker focus={input.focus} width={width} limit={geometry.picker} appearance={appearance} />
            : input.focus.kind === "approval" ? <ApprovalInput {...editorProps} rows={preparedEditor} /> : <Composer {...editorProps} rows={preparedEditor} />}
          {!picking && visibleExtras.map((spans, index) => <RichRow key={`extra-${index}`} spans={spans} appearance={appearance} width={width} />)}
        </Box>
      </>}
    </Box>
  </>;
}
