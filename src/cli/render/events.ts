import type { AgentEvent, TaskPlan, ToolCall } from "../../shared/schemas";
import type { RenderUpdate, RichLine, RunStatus } from "../ui-contract";
import { MarkdownStream } from "./markdown";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { toolFinishLines, toolStartLine } from "./tools";

export interface EventRendererOptions {
  readonly width?: () => number;
  readonly now?: () => number;
}

export interface EventRenderer {
  push(event: AgentEvent): RenderUpdate;
  finish(): RenderUpdate;
}

const statusFor = (
  label: string,
  startedAt: number,
  toolCount: number,
  cancellable: boolean,
): RunStatus => ({ label, startedAt, toolCount, cancellable });

export const createEventRenderer = (
  options: EventRendererOptions = {},
): EventRenderer => {
  const markdown = new MarkdownStream();
  const calls = new Map<string, ToolCall>();
  const now = options.now ?? Date.now;
  let startedAt = now();
  let toolCount = 0;
  let running = false;
  let tail: readonly RichLine[] = [];

  const flushText = (): RichLine[] => {
    const done = markdown.finish();
    tail = [];
    return done.append;
  };

  const update = (
    append: readonly RichLine[],
    nextTail: readonly RichLine[],
    status: RunStatus | null,
  ): RenderUpdate => {
    tail = nextTail;
    const width = options.width?.() ?? 80;
    return {
      append: wrapRichLines(append, width),
      tail: wrapRichLines(nextTail, width),
      status,
    };
  };

  const live = (label: string): RunStatus =>
    statusFor(label, startedAt, toolCount, true);

  return {
    push(event): RenderUpdate {
      switch (event.type) {
        case "run_started":
          startedAt = now();
          toolCount = 0;
          running = true;
          return update(flushText(), [], live("thinking"));
        case "text_delta": {
          running = true;
          const chunk = markdown.push(event.text);
          return update(chunk.append, chunk.tail, live("responding"));
        }
        case "tool_started": {
          running = true;
          toolCount += 1;
          calls.set(event.call.id, event.call);
          return update(
            [
              ...flushText(),
              toolStartLine(event.call, options.width?.() ?? 80),
            ],
            [],
            live(event.call.function.name),
          );
        }
        case "tool_finished": {
          const call = calls.get(event.toolCallId);
          calls.delete(event.toolCallId);
          return update(
            [
              ...flushText(),
              ...toolFinishLines(call, event.result, options.width?.() ?? 80),
            ],
            [],
            live("thinking"),
          );
        }
        case "plan_updated":
          return update(
            [...flushText(), ...planEventLines(event.plan)],
            [],
            live("thinking"),
          );
        case "error":
          running = false;
          return update(
            [
              ...flushText(),
              [{ text: sanitizeText(event.error.message), tone: "error" }],
            ],
            [],
            null,
          );
        case "run_finished": {
          running = false;
          const tone =
            event.status === "completed"
              ? "success"
              : event.status === "failed"
                ? "error"
                : "warning";
          return update(
            [
              ...flushText(),
              [{ text: `${event.status} · ${event.toolCalls} tools`, tone }],
            ],
            [],
            null,
          );
        }
        case "approval_requested":
          return update(
            flushText(),
            [],
            statusFor("awaiting approval", startedAt, toolCount, false),
          );
        case "state_changed":
          if (event.status === "cancelled") {
            running = false;
            return update(flushText(), [], null);
          }
          return {
            append: [],
            tail,
            ...(running ? { status: live("thinking") } : {}),
          };
        case "agent_update":
        case "context_compacted":
          return {
            append: [],
            tail,
            ...(running ? { status: live("thinking") } : {}),
          };
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    },
    finish(): RenderUpdate {
      running = false;
      return update(flushText(), [], null);
    },
  };
};

const planEventLines = (plan: TaskPlan): RichLine[] => {
  const rows: RichLine[] = [[{ text: "Plan", tone: "accent" }]];
  if (plan.explanation) rows.push([{ text: plan.explanation, tone: "muted" }]);
  for (const [index, step] of plan.steps.entries()) {
    const tone =
      step.status === "completed"
        ? "success"
        : step.status === "in_progress"
          ? "warning"
          : "muted";
    rows.push([{ text: `${index + 1}. ${step.step} · ${step.status}`, tone }]);
  }
  return rows;
};
