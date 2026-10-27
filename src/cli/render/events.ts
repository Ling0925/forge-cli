import { estimateTokens } from "@forge/core/shared/context-usage";
import type { ProviderAttempt } from "@forge/core/shared/model-access";
import type {
  AgentEvent,
  ApprovalRequest,
  TaskPlan,
  ToolCall,
} from "@forge/core/shared/schemas";
import { approvalAuditArguments } from "../approval-policy";
import { uiSymbols } from "../symbols";
import type { RenderUpdate, RichLine, RunStatus } from "../ui-contract";
import { chrome, toolVerb } from "./labels";
import { MarkdownStream, markdownLines } from "./markdown";
import {
  REASONING_KEEP,
  reasoningLine as buildReasoningLine,
} from "./reasoning";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { ToolTranscript } from "./tool-transcript";
import { compactToolLine, toolRunningLine, toolTarget } from "./tools";
import { webSearchDetails, webSearchStatus } from "./web-search";
import { truncate } from "./width";

export interface EventRendererOptions {
  readonly width?: () => number;
  readonly now?: () => number;
  readonly tools?: ToolTranscript;
  readonly expandReasoning?: boolean | (() => boolean);
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

/** Cumulative, display-only metadata of one in-flight tool argument stream. */
export interface ToolPreview {
  readonly name: string;
  readonly argumentsChars: number;
}

const PREVIEW_LABEL = "preparing arguments";
const PREVIEW_FALLBACK_NAME = "tool call";
const PREVIEW_MAX_CHARS = 1_000_000;

/** Untrusted name; never echo arguments, only the bounded cumulative size. */
export const previewName = (name: string): string =>
  sanitizeText(name).replace(/\s+/g, " ").trim() || PREVIEW_FALLBACK_NAME;

export const previewChars = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(PREVIEW_MAX_CHARS, Math.max(0, Math.floor(value)))
    : 0;

/** Single plain-text summary used by both the tail row and append-only stderr. */
export const previewSummary = (preview: ToolPreview): string =>
  `${toolVerb(previewName(preview.name))} ${uiSymbols().separator} ${PREVIEW_LABEL} ${uiSymbols().separator} ${previewChars(preview.argumentsChars)} chars`;

/**
 * One live row per pending tool call: name plus how many argument characters
 * have arrived. The metadata is never a tool call and carries no arguments.
 */
export const toolPreviewLine = (preview: ToolPreview, width = 80): RichLine => {
  const symbols = uiSymbols();
  const suffix = ` ${symbols.separator} ${PREVIEW_LABEL} ${symbols.separator} ${previewChars(preview.argumentsChars)} chars`;
  return [
    {
      text: symbols.spinnerFrames[0] ?? symbols.active,
      tone: "muted",
      animation: "spinner",
    },
    { text: " " },
    ...compactToolLine(
      toolVerb(previewName(preview.name)),
      "",
      suffix,
      "muted",
      Math.max(1, width - 2),
    ),
  ];
};

/** `tool_started` may carry the previewId of the row it replaces. */
const previewIdOf = (event: AgentEvent): string | undefined =>
  event.type === "tool_started" ? event.previewId : undefined;

const attemptField = (value: string | undefined): string =>
  sanitizeText(value ?? "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 256) || "-";

/** One concise, secret-free row for the real provider selection and outcome. */
export const providerAttemptLine = (
  selection: ProviderAttempt,
  width = 80,
): RichLine => {
  const usage =
    selection.usage === undefined
      ? ""
      : ` · tokens ${selection.usage.totalTokens}`;
  const error =
    selection.errorCode === undefined
      ? ""
      : ` · error ${attemptField(selection.errorCode)}`;
  const text = [
    `provider ${selection.outcome}`,
    `${attemptField(selection.sourceId)}/${attemptField(selection.model)}`,
    attemptField(selection.apiMode),
    `credential ${attemptField(selection.credentialId)}`,
    selection.groupId === undefined
      ? undefined
      : `group ${attemptField(selection.groupId)}`,
    `attempt ${selection.attempt}`,
    attemptField(selection.reason),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return [
    {
      text: truncate(
        sanitizeText(`${text}${error}${usage}`),
        Math.max(1, width),
      ),
      tone:
        selection.outcome === "failed"
          ? "error"
          : selection.outcome === "succeeded"
            ? "success"
            : "muted",
    },
  ];
};

type AdvisorUpdate = Extract<AgentEvent, { type: "advisor_update" }>;
const advisorLabel = (request: AdvisorUpdate["request"]): string => request.status === "pending"
  ? "awaiting advisor" : request.status === "answered"
    ? request.deliveredAt ? "advisor delivered" : "advisor answered (delivery pending)"
    : `advisor ${request.status}`;

/** Metadata only: child questions/answers must not become parent reply text. */
export const advisorSummary = (event: AdvisorUpdate): string => sanitizeText(
  `Child ${event.request.childSessionId.slice(0, 8)}: ${advisorLabel(event.request)}; request=${event.request.id.slice(0, 8)}`,
);

export const createEventRenderer = (
  options: EventRendererOptions = {},
): EventRenderer => {
  const markdown = new MarkdownStream(options.width);
  const tools = options.tools ?? new ToolTranscript();
  const now = options.now ?? Date.now;
  let startedAt = now();
  let toolCount = 0;
  let stepNumber: number | undefined;
  let turnNumber: number | undefined;
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
  // Latest single line of streamed reasoning; replaces in place (scrolling preview).
  let reasoningLine: RichLine | undefined;
  let reasoningAccumulator = "";
  let reasoningStreamed = "";
  const isExpandReasoning = (): boolean =>
    typeof options.expandReasoning === "function"
      ? options.expandReasoning()
      : options.expandReasoning === true;
  const updateReasoning = (text: string): RichLine[] => {
    if (isExpandReasoning()) {
      reasoningStreamed += text;
      // In expanded mode, format each newline-delimited chunk directly with muted tone
      const parts = sanitizeText(text).split("\n");
      const appends: RichLine[] = [];
      parts.forEach((part, index) => {
        if (index > 0) appends.push([]);
        if (part) {
          appends.push([
            { text: `${uiSymbols().reasoning} ${part}`, tone: "muted" },
          ]);
        }
      });
      return appends;
    }
    const merged = reasoningAccumulator + text;
    reasoningAccumulator =
      merged.length > REASONING_KEEP ? merged.slice(-REASONING_KEEP) : merged;
    // A streamed newline/indent is not a new visible thought. Keep the previous
    // preview until text arrives; otherwise the entire history viewport jumps.
    reasoningLine =
      buildReasoningLine(reasoningAccumulator, options.width?.() ?? 80, true) ??
      reasoningLine;
    return [];
  };
  const children = new Map<
    string,
    { model: string; status: string; activity: string }
  >();
  const settled = new Set<string>();
  const awaitingAdvisor = new Map<string, string>();
  const childLine = (
    id: string,
    child: { model: string; status: string; activity: string },
  ): RichLine => [
    {
      text: truncate(
        sanitizeText(
          `  ${uiSymbols().vertical} Agent ${id.slice(0, 8)} ${uiSymbols().separator} ${child.model} ${uiSymbols().separator} ${child.status}${child.activity ? ` ${uiSymbols().separator} ${child.activity}` : ""}`,
        ).replace(/\s+/g, " "),
        options.width?.() ?? 80,
      ),
      tone:
        child.status === "failed"
          ? "error"
          : child.status === "completed"
            ? "success"
            : "muted",
    },
  ];
  const stopChildren = (): RichLine[] => {
    const lines = [...children].map(([id, child]) => {
      settled.add(id);
      return childLine(id, { ...child, status: "interrupted", activity: "" });
    });
    children.clear();
    awaitingAdvisor.clear();
    return lines;
  };
  const active = new Map<string, ToolCall>();
  // Pending argument streams, keyed by previewId. Display-only: these are not
  // tool calls, never enter the transcript and never raise toolCount.
  const previews = new Map<string, ToolPreview>();
  const clearPreviews = (): void => {
    previews.clear();
  };
  const stopTools = (label: string = chrome.interrupted): RichLine[] => {
    const lines = [...active.values()].map((call) => [
      { text: `${uiSymbols().failure} `, tone: "warning" as const },
      ...compactToolLine(
        toolVerb(call.function.name),
        toolTarget(call),
        ` ${uiSymbols().separator} ${label}`,
        "warning",
        Math.max(1, (options.width?.() ?? 80) - 2),
      ),
    ]);
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
    tail = wrapRichLines(
      [
        // While arguments are still being generated, the pending-tool rows take
        // the transient slot: reasoning is a lower-value duplicate there.
        ...(reasoningLine && previews.size === 0 ? [reasoningLine] : []),
        ...nextTail,
        ...[...active.values()].map((call) => toolRunningLine(call, width)),
        ...[...previews.values()].map((preview) =>
          toolPreviewLine(preview, width),
        ),
        ...[...children].map(([id, child]) => childLine(id, child)),
      ],
      width,
    );
    return {
      append: wrapRichLines(append, width),
      tail,
      status: currentStatus,
    };
  };

  const live = (label: string): RunStatus => {
    // Round/step position stays structured, not baked into the label: the dock
    // decides how much of it a narrow row can afford.
    currentStatus = withTokens({
      ...statusFor(label, startedAt, toolCount, true),
      ...(turnNumber === undefined ? {} : { turn: turnNumber }),
      ...(stepNumber === undefined ? {} : { step: stepNumber }),
    });
    return currentStatus;
  };

  return {
    push(event): RenderUpdate {
      switch (event.type) {
        case "step_started":
          turnNumber = event.turn;
          stepNumber = event.step;
          return update([], messageTail, live(chrome.thinking));
        case "step_finished":
          return { append: [], tail };
        case "retry_reset":
          markdown.finish();
          streamedText = "";
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          clearPreviews();
          return update([], [], live(chrome.retrying));
        case "provider_retry":
          return update(
            [],
            [],
            live(`retry ${event.attempt}/${event.maxAttempts}`),
          );
        case "provider_attempt":
          running = true;
          return update(
            [
              ...flushText(),
              providerAttemptLine(event.selection, options.width?.() ?? 80),
            ],
            [],
            live(`provider ${event.selection.outcome}`),
          );
        case "run_started":
          turnNumber = event.turn;
          stepNumber = undefined;
          startedAt = now();
          toolCount = 0;
          completedOutputTokens = 0;
          tokensEstimated = false;
          streamedText = "";
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          running = true;
          clearPreviews();
          return update(flushText(), [], live(chrome.thinking));
        case "web_search":
          return update([], messageTail, live(webSearchStatus(event.search)));
        case "web_search_result":
          return update(
            [
              ...flushText(),
              ...markdownLines(
                webSearchDetails(event),
                options.width?.() ?? 80,
              ),
            ],
            [],
            live(chrome.thinking),
          );
        case "reasoning_delta": {
          running = true;
          const appended = updateReasoning(event.text);
          return update(appended, messageTail, live(chrome.thinking));
        }
        case "text_delta": {
          running = true;
          // The answer has begun; the transient reasoning preview is done.
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          streamedText += event.text;
          const chunk = markdown.push(event.text);
          return update(chunk.append, chunk.tail, live(chrome.responding));
        }
        case "tool_call_preview": {
          running = true;
          // Argument generation supersedes the transient reasoning row, but the
          // assistant body already streamed to messageTail stays visible.
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          if (!previews.has(event.previewId) && previews.size >= 256)
            return update([], messageTail, currentStatus);
          previews.set(event.previewId, {
            name: event.name,
            argumentsChars: previewChars(event.argumentsChars),
          });
          return update([], messageTail, live(previewName(event.name)));
        }
        case "tool_preview_reset":
          clearPreviews();
          return update(
            [],
            messageTail,
            running ? live(chrome.thinking) : null,
          );
        case "tool_started": {
          running = true;
          // A tool call ends the reasoning phase for this request.
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          const previewId = previewIdOf(event);
          if (previewId) previews.delete(previewId);
          if (!active.has(event.call.id)) toolCount += 1;
          tools.start(event.call, now());
          active.set(event.call.id, event.call);
          return update(
            flushText(),
            [],
            // The tail row already names the running tool, so the status keeps
            // the neutral activity word instead of repeating the verb.
            live(chrome.thinking),
          );
        }
        case "tool_finished": {
          active.delete(event.toolCallId);
          return update(
            [
              ...flushText(),
              ...tools.summary(
                event.toolCallId,
                event.result,
                options.width?.() ?? 80,
                now(),
              ),
            ],
            [],
            live(chrome.thinking),
          );
        }
        case "tool_hook":
          if (
            event.diagnostic.status === "ok" ||
            event.diagnostic.status === "skipped"
          )
            return update([], [], live(chrome.thinking));
          return update(
            [
              ...flushText(),
              [
                {
                  text: sanitizeText(
                    `Hook ${event.diagnostic.id}: ${event.diagnostic.reason ?? event.diagnostic.status}`,
                  ),
                  tone: "error",
                },
              ],
            ],
            [],
            live(chrome.thinking),
          );
        case "plan_updated":
          return update(
            [...flushText(), ...planEventLines(event.plan)],
            [],
            live(chrome.thinking),
          );
        case "error":
          running = false;
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          clearPreviews();
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
          reasoningLine = undefined;
          reasoningAccumulator = "";
          reasoningStreamed = "";
          clearPreviews();
          const tone =
            event.status === "completed"
              ? "success"
              : event.status === "failed"
                ? "error"
                : "warning";
          const outcome =
            event.status === "completed"
              ? chrome.completed
              : event.status === "failed"
                ? chrome.failed
                : event.status === "cancelled"
                  ? chrome.cancelled
                  : chrome.interrupted;
          // One quiet closing row: outcome, work done, and retries only when they happened.
          const facts = [
            `${event.steps ?? event.turns} ${chrome.steps}`,
            `${event.toolCalls} ${chrome.toolCalls}`,
          ];
          if (event.retries) facts.push(`${event.retries} ${chrome.retries}`);
          return update(
            [
              ...flushText(),
              ...stopTools(
                event.status === "cancelled"
                  ? chrome.cancelled
                  : chrome.interrupted,
              ),
              [
                {
                  text: `${uiSymbols().separator} ${outcome} ${uiSymbols().separator} ${facts.join(` ${uiSymbols().separator} `)}`,
                  tone,
                },
              ],
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
            reasoningLine = undefined;
            reasoningAccumulator = "";
            clearPreviews();
            return update(
              [...flushText(), ...stopTools(chrome.cancelled)],
              [],
              null,
            );
          }
          return {
            append: [],
            tail,
            ...(running ? { status: live(chrome.thinking) } : {}),
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
        case "advisor_update": {
          const request = event.request;
          const id = request.childSessionId;
          if (settled.has(id) || request.parentSessionId !== event.sessionId) return { append: [], tail };
          const pending = awaitingAdvisor.get(id);
          if (pending && pending !== request.id && request.status !== "pending") return { append: [], tail };
          const previous = children.get(id);
          if (!previous && (request.status !== "pending" || children.size >= 4)) return { append: [], tail };
          if (request.status === "pending") awaitingAdvisor.set(id, request.id);
          else awaitingAdvisor.delete(id);
          children.set(id, { model: previous?.model ?? "", status: request.status === "pending" ? "awaiting advisor" : "running",
            activity: request.status === "pending" ? `request ${request.id.slice(0, 8)}` : advisorLabel(request) });
          return update([], messageTail, currentStatus);
        }
        case "agent_update": {
          const id = event.childSessionId;
          if (settled.has(id)) return { append: [], tail };
          const child = {
            model: event.model,
            status: event.status,
            activity: event.currentTool
              ? `${event.currentTool.name} ${event.currentTool.target}`.trim()
              : "thinking",
          };
          if (
            ["completed", "failed", "cancelled", "interrupted"].includes(
              event.status,
            )
          ) {
            children.delete(id);
            awaitingAdvisor.delete(id);
            settled.add(id);
            // Do not dump the child's summary/logs or finalize parent Markdown.
            return update(
              [childLine(id, { ...child, activity: "" })],
              messageTail,
              currentStatus,
            );
          }
          const question = awaitingAdvisor.get(id);
          if (children.has(id) || children.size < 4) children.set(id, question
            ? { ...child, status: "awaiting advisor", activity: `request ${question.slice(0, 8)}` } : child);
          return update([], messageTail, currentStatus);
        }
        case "agent_progress": // Do not mix the child's reply into parent Markdown.
        case "approval_resolved":
        case "title_changed":
        case "generation_started":
        case "generation_finished":
        // Harness adaptation is a host-internal phase report; it is not a
        // reader-facing message, so the transcript stays unchanged.
        case "harness_adaptation":
          return { append: [], tail };
        case "permission_changed":
        case "context_compacted":
          return {
            append: [],
            tail,
            ...(running ? { status: live(chrome.thinking) } : {}),
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
      if (previous || children.size < 4)
        children.set(id, {
          model: previous?.model ?? "",
          status: "auto-approved",
          activity:
            `${request.toolName} ${approvalAuditArguments(request).join(" ")}`.slice(
              0,
              2048,
            ),
        });
      return update([], messageTail, currentStatus);
    },
    finish(): RenderUpdate {
      running = false;
      reasoningLine = undefined;
      reasoningAccumulator = "";
      clearPreviews();
      return update([...flushText(), ...stopTools()], [], null);
    },
  };
};

const planEventLines = (plan: TaskPlan): RichLine[] => {
  const rows: RichLine[] = [
    [{ text: plan.title ? `Plan: ${plan.title}` : "Plan", tone: "accent" }],
  ];
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
