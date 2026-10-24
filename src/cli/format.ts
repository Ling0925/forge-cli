import type {
  ApprovalRequest,
  SessionSummary,
  TaskPlan,
} from "@forge/core/shared/schemas";
import { SLASH_COMMANDS, commandDescription } from "./commands";
import { commandGroups } from "./render/labels";
import { MarkdownStream } from "./render/markdown";
import { renderRichLine, wrapRichLines } from "./render/rich";
import { sanitizeText } from "./render/sanitize";
import { uiSymbols } from "./symbols";
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
    ? "readonly"
    : permission === "workspace"
      ? "workspace approval"
      : "full access";

export const bannerLines = (
  context: BannerContext,
  width: number,
): readonly RichLine[] => {
  const modelName = sanitizeText(context.model).split("/").at(-1) ?? "";
  const effort = context.reasoningEffort
    ? ` (${sanitizeText(context.reasoningEffort)})`
    : "";
  const title = sanitizeText(context.sessionTitle ?? "")
    .replace(/[\n\t]/g, " ")
    .trim();
  const model = `${modelName}${effort}${title ? ` · ${title}` : ""}`;
  const version = context.version ? ` v${sanitizeText(context.version)}` : "";
  // The session id belongs to the identity row, not glued onto the workspace
  // path where it reads as part of the directory.
  const id = context.id ? `  ${sanitizeText(context.id).slice(0, 8)}` : "";
  const mode = context.mode === "plan" ? "plan" : "build";
  const lines: RichLine[] = [
    [span("Forge", undefined, true), span(version, "muted"), span(id, "muted")],
    [
      span(
        truncate(
          `${model} · ${permissionLabel(context.permission)} · ${mode}`,
          width,
        ),
        "muted",
      ),
    ],
    [span(truncate(sanitizeText(context.workspace), width), "muted")],
    [span(truncate("/ commands  ·  /help", width), "muted")],
  ];
  return lines.slice(0, 4);
};

const HELP_GAP = 2;

/**
 * Word wrap for help prose. The shared wrapper splits per grapheme, which is
 * right for code and paths but breaks sentences mid-word; help text is prose,
 * so it wraps on spaces and only splits a token longer than the line.
 */
const wordWrap = (text: string, width: number): readonly string[] => {
  const limit = Math.max(1, width);
  const rows: string[] = [];
  let current = "";
  for (const word of sanitizeText(text).split(/\s+/).filter(Boolean)) {
    if (!current) {
      current = word;
      continue;
    }
    if (stringWidth(`${current} ${word}`) <= limit) {
      current = `${current} ${word}`;
      continue;
    }
    rows.push(current);
    current = word;
  }
  if (current) rows.push(current);
  // A single token wider than the line still has to be bounded.
  return rows.flatMap((row) =>
    stringWidth(row) <= limit
      ? [row]
      : wrapRichLines([[span(row)]], limit).map((line) =>
          line.map((item) => item.text).join(""),
        ),
  );
};

/** Group caption for /help: quiet, so the commands themselves stay scannable. */
const heading = (title: string): RichLine => [span(title, "muted", true)];

const commandUsage = (command: (typeof SLASH_COMMANDS)[number]): string =>
  command.args ? `${command.name} ${command.args}` : command.name;

/**
 * One help entry, laid out against a shared description column.
 *
 * Alignment wins when it fits: the syntax is padded to the column and the
 * description follows on the same row. Otherwise the entry stacks — syntax on
 * its own row, description beneath it — so a continuation line never starts
 * mid-word in whatever narrow strip the column would have left.
 */
const helpCommandLines = (
  usage: string,
  description: string,
  width: number,
  column: number,
): readonly RichLine[] => {
  const limit = Math.max(1, Math.floor(width));
  // A syntax longer than the terminal cannot be shown as-is.
  const command = truncate(sanitizeText(usage), limit);
  const commandWidth = stringWidth(command);
  const descriptionWidth = stringWidth(description);
  const aligned = limit - column - HELP_GAP;
  // Two shapes, in order of preference:
  //   1. aligned — padded to the shared column, description beside it;
  //   2. stacked — syntax alone, description wrapped beneath it.
  // A row is only aligned when the whole description fits: the shared wrapper
  // splits per grapheme, so wrapping beside a column would break words.
  if (commandWidth <= column && descriptionWidth <= aligned && aligned >= 8) {
    return [
      [
        span(padRight(command, column), "accent"),
        span(`${" ".repeat(HELP_GAP)}${description}`, "muted"),
      ],
    ];
  }
  const indent = "  ";
  return [
    [span(command, "accent")],
    ...wordWrap(description, Math.max(1, limit - stringWidth(indent))).map(
      (text) => [span(indent, "muted"), span(text, "muted")],
    ),
  ];
};

export const helpLines = (width: number): readonly RichLine[] => {
  const limit = Math.max(1, Math.floor(width));
  const groups = commandGroups.map(({ title, category }) => ({
    title,
    commands: SLASH_COMMANDS.filter((command) => command.category === category),
  }));
  // The column is the widest syntax that still leaves room for the longest
  // description. Entries wider than that stack beneath it, so one long outlier
  // never widens the column and pushes everyone else off the screen. Keying the
  // column to the longest description (not to each pairing) keeps it stable and
  // the list aligned whatever width the terminal has.
  const widestProse = Math.max(
    0,
    ...groups.flatMap((group) =>
      group.commands.map((command) => stringWidth(commandDescription(command))),
    ),
  );
  const fits: number[] = [];
  for (const group of groups) {
    for (const command of group.commands) {
      const size = stringWidth(commandUsage(command));
      if (size + HELP_GAP + widestProse <= limit) fits.push(size);
    }
  }
  const column = Math.max(0, ...fits);
  const raw: RichLine[] = groups.flatMap(({ title, commands }) =>
    commands.length === 0
      ? []
      : [
          heading(title),
          ...commands.flatMap((command) =>
            helpCommandLines(
              commandUsage(command),
              commandDescription(command),
              limit,
              column,
            ),
          ),
        ],
  );
  return raw;
};

const planStatus = (
  status: TaskPlan["steps"][number]["status"],
): { mark: string; label: string; tone: Tone } =>
  status === "completed"
    ? { mark: uiSymbols().success, label: "[done]", tone: "success" }
    : status === "in_progress"
      ? { mark: uiSymbols().active, label: "[active]", tone: "warning" }
      : { mark: uiSymbols().pending, label: "[pending]", tone: "muted" };

export const planLines = (
  plan: TaskPlan | null,
  width: number,
): readonly RichLine[] => {
  if (!plan) return [[span("No active execution plan.", "muted")]];
  const lines: RichLine[] = [
    [
      span(
        plan.title
          ? `Execution Plan: ${sanitizeText(plan.title)}`
          : "Execution Plan",
        "accent",
      ),
    ],
  ];
  if (plan.id) lines.push([span(`ID: ${sanitizeText(plan.id)}`, "muted")]);
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
  // One prompt, not a warning followed by the same question again. The reader
  // is told what Enter does and what is not protected, then asked once.
  lines.push([span("Enter approves; commands are not sandboxed.", "warning")]);
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
  if (!sessions.length)
    return theme.dim("No saved sessions yet. Use /new to create one.");
  const width = getTerminalWidth();
  const lines: RichLine[] = [[span(`Sessions (${sessions.length})`, "accent")]];
  for (const session of sessions.slice(0, 30)) {
    const marker = session.id === activeId ? uiSymbols().bullet : " ";
    lines.push([
      span(
        truncate(
          `${marker} ${sanitizeText(session.title || "Untitled")} · ${session.status}`,
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
