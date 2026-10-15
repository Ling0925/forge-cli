import type {
  ApprovalRequest,
  SessionSummary,
  TaskPlan,
} from "../shared/schemas";
import { SLASH_COMMANDS } from "./commands";
import { MarkdownStream } from "./render/markdown";
import { renderRichLine, wrapRichLines } from "./render/rich";
import { sanitizeText } from "./render/sanitize";
import {
  type Theme,
  defaultTheme,
  getTerminalWidth,
  padRight,
  stringWidth,
  truncate,
} from "./theme";
import type { RichLine, Span, Tone } from "./ui-contract";

export { plainLines, renderRichLine, wrapRichLines } from "./render/rich";
export { createEventRenderer } from "./render/events";

export const terminalText = sanitizeText;

const span = (text: string, tone?: Tone, bold?: boolean): Span => ({
  text,
  ...(tone ? { tone } : {}),
  ...(bold ? { bold } : {}),
});

const paint = (
  lines: readonly RichLine[],
  theme: Theme,
  width: number,
): string =>
  wrapRichLines(lines, width)
    .map((line) => renderRichLine(line, theme))
    .join("\n");

export interface BannerContext {
  readonly version?: string;
  readonly model: string;
  readonly workspace: string;
  readonly permission: string;
  readonly mode: string;
  readonly id?: string;
  readonly reasoningEffort?: string;
  readonly sessionTitle?: string;
}

const permissionLabel = (permission: string): string =>
  permission === "readonly"
    ? "只读"
    : permission === "workspace"
      ? "工作区审批"
      : "完全访问";

export const bannerLines = (
  context: BannerContext,
  width: number,
): readonly RichLine[] => {
  const modelName = sanitizeText(context.model).split("/").at(-1) ?? "";
  const effort = context.reasoningEffort
    ? ` (${sanitizeText(context.reasoningEffort)})`
    : "";
  const title = sanitizeText(context.sessionTitle ?? "").replace(/[\n\t]/g, " ").trim();
  const model = `${modelName}${effort}${title ? ` · ${title}` : ""}`;
  const version = context.version ? ` v${sanitizeText(context.version)}` : "";
  const id = context.id ? ` · ${sanitizeText(context.id).slice(0, 8)}` : "";
  const mode = context.mode === "plan" ? "计划" : "执行";
  const lines: RichLine[] = [
    [span("Forge", undefined, true), span(version, "muted")],
    [
      span(
        truncate(
          `${model} · ${permissionLabel(context.permission)} · ${mode}`,
          width,
        ),
        "muted",
      ),
    ],
    [span(truncate(`${sanitizeText(context.workspace)}${id}`, width), "muted")],
    [span(truncate("/ 命令  ·  /help 帮助", width), "muted")],
  ];
  return lines.slice(0, 4);
};

const HELP_GAP = 2;
const HELP_INDENT = "  ";

const commandUsage = (command: (typeof SLASH_COMMANDS)[number]): string =>
  command.args ? `${command.name} ${command.args}` : command.name;

const helpCommandLines = (
  usage: string,
  description: string,
  width: number,
): readonly RichLine[] => {
  const limit = Math.max(1, Math.floor(width));
  const command = sanitizeText(usage);
  const room = limit - stringWidth(command) - HELP_GAP;
  if (
    stringWidth(command) <= limit &&
    stringWidth(description) <= room &&
    room >= 8
  ) {
    return [
      [
        span(command, "accent"),
        span(`${" ".repeat(HELP_GAP)}${description}`, "muted"),
      ],
    ];
  }
  const wrapped = wrapRichLines(
    [[span(description, "muted")]],
    Math.max(1, limit - stringWidth(HELP_INDENT)),
  );
  return [
    [span(command, "accent")],
    ...wrapped.map((line) => [span(HELP_INDENT, "muted"), ...line]),
  ];
};

export const helpLines = (width: number): readonly RichLine[] => {
  const raw = SLASH_COMMANDS.map((command) =>
    helpCommandLines(commandUsage(command), command.description, width),
  );
  const inline = raw.flat().filter((line) => line.length > 1);
  const natural = Math.max(
    0,
    ...inline.map((line) => stringWidth(line[0]?.text.trimEnd() ?? "")),
  );
  const slack = Math.min(
    ...inline.map((line) => {
      const used = line.reduce((sum, item) => sum + stringWidth(item.text), 0);
      const command = stringWidth(line[0]?.text.trimEnd() ?? "");
      return Math.max(1, Math.floor(width)) - (used - command);
    }),
  );
  const column = Math.min(natural, Math.max(0, slack));
  const lines: RichLine[] = [[span("命令", "accent")]];
  for (const group of raw) {
    lines.push(
      ...group.map((line) =>
        line.length > 1
          ? [
              span(padRight(line[0]?.text.trimEnd() ?? "", column), "accent"),
              ...line.slice(1),
            ]
          : line,
      ),
    );
  }
  return lines;
};

const planStatus = (
  status: TaskPlan["steps"][number]["status"],
): { mark: string; label: string; tone: Tone } =>
  status === "completed"
    ? { mark: "✔", label: "[done]", tone: "success" }
    : status === "in_progress"
      ? { mark: "●", label: "[active]", tone: "warning" }
      : { mark: "○", label: "[pending]", tone: "muted" };

export const planLines = (
  plan: TaskPlan | null,
  width: number,
): readonly RichLine[] => {
  if (!plan) return [[span("No active execution plan.", "muted")]];
  const lines: RichLine[] = [[span("Execution Plan", "accent")]];
  if (plan.explanation)
    lines.push([
      span(
        `Goal: ${truncate(sanitizeText(plan.explanation), Math.max(8, width - 6))}`,
      ),
    ]);
  if (!plan.steps.length) lines.push([span("(no steps planned)", "muted")]);
  for (const [index, step] of plan.steps.entries()) {
    const status = planStatus(step.status);
    lines.push([
      span(
        `${status.mark} ${index + 1}. ${truncate(sanitizeText(step.step), Math.max(8, width - 16))} `,
        status.tone,
      ),
      span(status.label, status.tone),
    ]);
  }
  return lines;
};

const wrappedField = (
  label: string,
  value: string,
  tone?: Tone,
): RichLine[] => {
  const text = sanitizeText(value);
  if (!text) return [];
  return [[span(`${label} ${text}`, tone)]];
};

/** Readable shell quoting. The value is sanitized and never shortened. */
const quoteArg = (value: string): string => {
  const text = sanitizeText(value);
  if (text === "") return "''";
  if (/^[\w./:@%=+,~-]+$/u.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
};

/**
 * The core command description embeds the exact argv JSON. Replace only that
 * copy; every other word, including cwd and the sandbox warning, stays.
 */
const approvalDescription = (
  description: string,
  command: readonly string[] | undefined,
): string => {
  if (!command?.length) return description;
  const embedded = `Execute argv ${JSON.stringify(command)}`;
  if (!description.includes(embedded)) return description;
  return description.replace(embedded, "Execute the command below");
};

export const approvalLines = (
  request: ApprovalRequest,
  width: number,
  workspace = "",
): readonly RichLine[] => {
  const child = request.childSessionId
    ? ` (child ${request.childSessionId})`
    : "";
  const command = request.command;
  const lines: RichLine[] = [
    [
      span("Approval required:", "warning"),
      span(` ${sanitizeText(request.toolName)}${child}`, "accent"),
    ],
  ];
  if (workspace) lines.push(...wrappedField("Workspace:", workspace, "muted"));
  lines.push(
    ...wrappedField(
      "Description:",
      approvalDescription(request.description, command),
    ),
  );
  if (command?.length) {
    lines.push([
      span("Command:", "muted"),
      span(` ${command.map(quoteArg).join(" ")}`),
    ]);
  }
  lines.push([span("Enter approves; commands are not sandboxed.", "warning")]);
  lines.push([span("Approve? [Y/n]", "warning")]);
  return wrapRichLines(lines, Math.max(8, width));
};

export const renderMarkdown = (
  text: string,
  theme: Theme = defaultTheme,
): string => {
  const stream = new MarkdownStream(() => getTerminalWidth());
  stream.push(text);
  return paint(stream.finish().append, theme, getTerminalWidth());
};

export const formatBanner = (
  context: BannerContext,
  theme: Theme = defaultTheme,
): string =>
  `${paint(bannerLines(context, getTerminalWidth()), theme, getTerminalWidth())}\n`;

export const formatSessions = (
  sessions: readonly SessionSummary[],
  activeId?: string,
  theme: Theme = defaultTheme,
): string => {
  if (!sessions.length) return theme.dim("暂无历史会话。使用 /new 创建。");
  const width = getTerminalWidth();
  const lines: RichLine[] = [[span(`会话 (${sessions.length})`, "accent")]];
  for (const session of sessions.slice(0, 30)) {
    const marker = session.id === activeId ? "•" : " ";
    lines.push([
      span(
        truncate(
          `${marker} ${sanitizeText(session.title || "未命名")} · ${session.status}`,
          width,
        ),
      ),
    ]);
    lines.push([span(`  ${session.id}`)]);
  }
  return paint(lines, theme, width);
};

export const formatModels = (
  models: readonly string[],
  activeModel: string,
  theme: Theme = defaultTheme,
): string => {
  const lines: RichLine[] = [[span("Available Models", "accent")]];
  const shown = models.length ? models.slice(0, 12) : [activeModel];
  for (const model of shown) {
    const current = model === activeModel;
    lines.push([
      span(
        `  ${current ? "*" : " "} ${sanitizeText(model)}${current ? " (active)" : ""}`,
        current ? "accent" : "text",
      ),
    ]);
  }
  return lines.map((line) => renderRichLine(line, theme)).join("\n");
};

export const formatPlan = (
  plan: TaskPlan | null,
  theme: Theme = defaultTheme,
): string =>
  paint(planLines(plan, getTerminalWidth()), theme, getTerminalWidth());

export const formatApprovalCard = (
  request: ApprovalRequest,
  _workspace: string,
  theme: Theme = defaultTheme,
): string =>
  paint(
    approvalLines(request, getTerminalWidth(), _workspace),
    theme,
    getTerminalWidth(),
  );
