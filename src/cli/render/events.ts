import type { AgentEvent, ApprovalRequest, TaskPlan, ToolCall } from "../../shared/schemas";
import type { RenderUpdate, RichLine, RunStatus } from "../ui-contract";
import { estimateTokens } from "../../shared/context-usage";
import { MarkdownStream } from "./markdown";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { truncate } from "./width";
import { approvalAuditArguments } from "../approval-policy";
import { ToolTranscript } from "./tool-transcript";
import { compactToolLine, toolRunningLine, toolTarget } from "./tools";

export interface EventRendererOptions {
  readonly width?: () => number;
  readonly now?: () => number;
  readonly tools?: ToolTranscript;
}

export interface EventRenderer {
  push(event: AgentEvent): RenderUpdate;
  finish(): RenderUpdate;
  childApproval(request: ApprovalRequest): RenderUpdate;
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
  const markdown = new MarkdownStream(options.width);
  const tools = options.tools ?? new ToolTranscript();
  const now = options.now ?? Date.now;
  let startedAt = now();
  let toolCount = 0;
  let running = false;
  let currentStatus: RunStatus | null = null;
  let completedOutputTokens = 0;
  let tokensEstimated = false;
  let streamedText = "";
  const withTokens = (status: RunStatus): RunStatus => ({
    ...status,
    tokens: completedOutputTokens + estimateTokens(streamedText),
    tokensEstimated: tokensEstimated || streamedText.length > 0,
  });
  let tail: readonly RichLine[] = [];
  let messageTail: readonly RichLine[] = [];
  const children = new Map<string, { model: string; status: string; activity: string }>();
  const settled = new Set<string>();
  const childLine = (id: string, child: { model: string; status: string; activity: string }): RichLine => [{
    text: truncate(sanitizeText(`  │ Agent ${id.slice(0, 8)} · ${child.model} · ${child.status}${child.activity ? ` · ${child.activity}` : ""}`).replace(/\s+/g, " "), options.width?.() ?? 80),
    tone: child.status === "failed" ? "error" : child.status === "completed" ? "success" : "muted",
  }];
  const stopChildren = (): RichLine[] => {
    const lines = [...children].map(([id, child]) => {
      settled.add(id);
      return childLine(id, { ...child, status: "interrupted", activity: "" });
    });
    children.clear();
    return lines;
  };
  const active = new Map<string, ToolCall>();
  const stopTools = (label = "interrupted"): RichLine[] => {
    const lines = [...active.values()].map((call) => compactToolLine(
      call.function.name, toolTarget(call), ` · ${label}`, "warning", options.width?.() ?? 80,
    ));
    active.clear();
    return [...lines, ...stopChildren()];
  };

  const flushText = (): RichLine[] => {
    const done = markdown.finish();
    tail = [];
    messageTail = [];
    return done.append;
  };

  const update = (
    append: readonly RichLine[],
    nextTail: readonly RichLine[],
    status: RunStatus | null,
  ): RenderUpdate => {
    currentStatus = status ? withTokens(status) : null;
    const width = options.width?.() ?? 80;
    messageTail = nextTail;
    tail = wrapRichLines([
      ...nextTail,
      ...[...active.values()].map((call) => toolRunningLine(call, width)),
      ...[...children].map(([id, child]) => childLine(id, child)),
    ], width);
    return {
      append: wrapRichLines(append, width),
      tail,
      status: currentStatus,
    };
  };

  const live = (label: string): RunStatus => {
    currentStatus = withTokens(statusFor(label, startedAt, toolCount, true));
    return currentStatus;
  };

  return {
    push(event): RenderUpdate {
      switch (event.type) {
        case "run_started":
          startedAt = now();
          toolCount = 0;
          completedOutputTokens = 0;
          tokensEstimated = false;
          streamedText = "";
          running = true;
          return update(flushText(), [], live("thinking"));
        case "text_delta": {
          running = true;
          streamedText += event.text;
          const chunk = markdown.push(event.text);
          return update(chunk.append, chunk.tail, live("responding"));
        }
        case "tool_started": {
          running = true;
          if (!active.has(event.call.id)) toolCount += 1;
          tools.start(event.call, now());
          active.set(event.call.id, event.call);
          return update(
            flushText(),
            [],
            live(event.call.function.name),
          );
        }
        case "tool_finished": {
          active.delete(event.toolCallId);
          return update(
            [
              ...flushText(),
              ...tools.summary(event.toolCallId, event.result, options.width?.() ?? 80, now()),
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
              ...stopTools(),
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
              ...stopTools(event.status === "cancelled" ? "cancelled" : "interrupted"),
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
            return update([...flushText(), ...stopTools("cancelled")], [], null);
          }
          return {
            append: [],
            tail,
            ...(running ? { status: live("thinking") } : {}),
          };
        case "context_usage": {
          if (!running) return { append: [], tail };
          // A user turn may contain multiple model requests. Count only their
          // outputs, never the projected context or prompt tokens. A reported
          // completion replaces this request's streaming estimate, not prior outputs.
          if (event.usage.completionTokens !== undefined) {
            completedOutputTokens += event.usage.completionTokens;
          } else if (streamedText) {
            completedOutputTokens += estimateTokens(streamedText);
            tokensEstimated = true;
          }
          streamedText = "";
          if (running && currentStatus) {
            currentStatus = withTokens(currentStatus);
            return { append: [], tail, status: currentStatus };
          }
          return { append: [], tail };
        }
        case "agent_update": {
          const id = event.childSessionId;
          if (settled.has(id)) return { append: [], tail };
          const child = { model: event.model, status: event.status,
            activity: event.currentTool ? `${event.currentTool.name} ${event.currentTool.target}`.trim() : "thinking" };
          if (["completed", "failed", "cancelled", "interrupted"].includes(event.status)) {
            children.delete(id); settled.add(id);
            // Do not dump the child's summary/logs or finalize parent Markdown.
            return update([childLine(id, { ...child, activity: "" })], messageTail, currentStatus);
          }
          if (children.has(id) || children.size < 4) children.set(id, child);
          return update([], messageTail, currentStatus);
        }
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
    childApproval(request): RenderUpdate {
      const id = request.childSessionId;
      if (!id || settled.has(id)) return { append: [], tail };
      const previous = children.get(id);
      if (previous || children.size < 4) children.set(id, {
        model: previous?.model ?? "", status: "auto-approved",
        activity: `${request.toolName} ${approvalAuditArguments(request).join(" ")}`.slice(0, 2048),
      });
      return update([], messageTail, currentStatus);
    },
    finish(): RenderUpdate {
      running = false;
      return update([...flushText(), ...stopTools()], [], null);
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
