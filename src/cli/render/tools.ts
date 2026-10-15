import type { ToolCall, ToolResult } from "../../shared/schemas";
import type { RichLine, Span, Tone } from "../ui-contract";
import { diffLines, diffStats } from "./diff";
import { envelope, textLines } from "./envelope";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { graphemes, stringWidth, truncate } from "./width";
import { toolPresentation } from "./tool-presentation";
import { durationSuffix } from "./duration";

const PREVIEW_LINES = 12;
const PREVIEW_ROWS = 18;
const DEFAULT_WIDTH = 80;
// Bound how many physical rows one run_command branch may occupy in the transcript.
const COMMAND_ROWS = 6;
// Below this width a wrapped command branch costs more rows than it clarifies.
const COMMAND_MIN_WIDTH = 24;

const span = (text: string, tone?: Tone): Span => ({
  text: sanitizeText(text),
  ...(tone ? { tone } : {}),
});

const line = (...parts: Span[]): RichLine => parts.filter((item) => item.text);

/** Greedy word wrap for a hanging command branch; hard-splits over-long tokens. */
const wrapCommand = (value: string, limit: number): string[] => {
  const width = Math.max(1, limit);
  const words = sanitizeText(value).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const rows: string[] = [];
  let current = "";
  const push = (): void => {
    if (current) {
      rows.push(current);
      current = "";
    }
  };
  for (let word of words) {
    while (stringWidth(word) > width) {
      let cut = "";
      for (const glyph of graphemes(word)) {
        if (cut && stringWidth(cut + glyph) > width) break;
        cut += glyph;
      }
      if (!cut) break;
      push();
      rows.push(cut);
      word = word.slice(cut.length);
    }
    if (!current) current = word;
    else if (stringWidth(current) + 1 + stringWidth(word) <= width) current += ` ${word}`;
    else {
      rows.push(current);
      current = word;
    }
  }
  push();
  return rows;
};

/** run_command keeps its status/exit on the header and moves the command itself
 * to a wrapped branch. Other tools (and short commands) keep one header line. */
const commandLayout = (
  name: string,
  target: string,
  suffix: string,
  width: number,
): { headerTarget: string; branch: string[] } => {
  const limit = Math.max(1, width);
  if (name !== "run_command" || !target || limit < COMMAND_MIN_WIDTH)
    return { headerTarget: target, branch: [] };
  // Branch only when the command cannot fit beside the status/exit suffix;
  // a command that fits stays a single quiet header line.
  const fits = stringWidth(name) + 1 + stringWidth(target) + stringWidth(suffix) <= limit;
  if (fits) return { headerTarget: target, branch: [] };
  const rows = wrapCommand(target, Math.max(1, limit - 4));
  const shown = rows.slice(0, COMMAND_ROWS);
  return {
    headerTarget: "",
    branch: [
      ...shown,
      ...(rows.length > shown.length
        ? [`… ${rows.length - shown.length} more command lines`]
        : []),
    ],
  };
};

const readValue = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readObject = (raw: string): Record<string, unknown> | null => {
  const value = readValue(raw);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value));
  }
  return null;
};

export const toolTarget = (call: ToolCall): string => {
  const args = readObject(call.function.arguments);
  if (!args) return "(arguments unavailable)";
  for (const key of ["path", "argv", "command", "query", "url", "id", "cwd"]) {
    const field = args[key];
    if (typeof field === "string" && field) return field;
    if (Array.isArray(field)) {
      return field.filter((item) => typeof item === "string").join(" ");
    }
  }
  return call.function.name;
};

/**
 * Status and exit stay whole. The target is bounded first.
 * The tool name is ellipsized only when name plus suffix cannot fit.
 */
export const compactToolLine = (
  name: string,
  target: string,
  suffix: string,
  suffixTone: Tone,
  width: number,
): RichLine => {
  const limit = Math.max(1, width);
  const safeName = sanitizeText(name).replace(/\s+/g, " ").trim() || "tool";
  const safeTarget = sanitizeText(target).replace(/\s+/g, " ").trim();
  const safeSuffix = sanitizeText(suffix);
  const suffixWidth = stringWidth(safeSuffix);
  const nameFits = stringWidth(safeName) + suffixWidth <= limit;
  const shownName = nameFits
    ? safeName
    : truncate(safeName, limit - suffixWidth);
  const gap = safeTarget && shownName ? " " : "";
  const room = limit - stringWidth(shownName) - stringWidth(gap) - suffixWidth;
  const shown = room > 0 ? truncate(safeTarget, room) : "";
  return line(
    span(shownName, "accent"),
    span(shown ? `${gap}${shown}` : ""),
    span(safeSuffix, suffixTone),
  );
};

export const toolStartLine = (
  call: ToolCall,
  width = DEFAULT_WIDTH,
): RichLine =>
  compactToolLine(
    call.function.name,
    toolTarget(call),
    " · running",
    "muted",
    width,
  );

/** Animated only by the terminal; never committed as a completed record. */
export const toolRunningLine = (call: ToolCall, width = DEFAULT_WIDTH): RichLine => [
  { text: "⠋", tone: "muted", animation: "spinner" },
  span(" "),
  ...toolStartLine(call, Math.max(1, width - 2)),
];

export const toolArgumentLines = (call: ToolCall, width = DEFAULT_WIDTH, expanded = false): RichLine[] => {
  const args = readObject(call.function.arguments);
  if (!args) return [];
  const rows: RichLine[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) continue;
    const parts = textLines(text);
    const limit = expanded ? 80 : 3;
    rows.push(...parts.slice(0, limit).map((part, index) =>
      [span(`  ${index ? "  " : `${key}: `}${part}`, "muted")],
    ));
    if (parts.length > limit) rows.push([span(`  … ${parts.length - limit} more ${key} lines`, "muted")]);
  }
  const clipped = clipRows(rows, width, expanded ? 120 : 6);
  return clipped.hidden ? [...clipped.shown, [span(`  … ${clipped.hidden} more arguments`, "muted")]] : clipped.shown;
};

const clipRows = (
  rows: readonly RichLine[],
  width: number,
  budget: number,
): { shown: RichLine[]; hidden: number } => {
  const limit = Math.max(1, width);
  const shown: RichLine[] = [];
  let used = 0;
  let hidden = 0;
  for (const row of rows) {
    const wrapped = wrapRichLines([row], limit);
    const cost = Math.max(1, wrapped.length);
    if (used + cost > budget) {
      const available = Math.max(0, budget - used - 1);
      if (available) {
        shown.push(...wrapped.slice(0, available));
        used += available;
      }
      hidden += 1;
      continue;
    }
    shown.push(...wrapped);
    used += cost;
  }
  return { shown, hidden };
};

export const toolSummaryLines = (
  call: ToolCall | undefined,
  result: ToolResult,
  width = DEFAULT_WIDTH,
  index?: number,
  elapsed?: number,
): RichLine[] => {
  const parsed = toolPresentation(call?.function.name ?? "", result);
  const failed = parsed.failed;
  const label = failed ? "failed" : "done";
  const exit = parsed.exitCode === null ? "" : ` · exit ${parsed.exitCode}`;
  const changes = call?.function.name === "edit_file" ? result.changes ?? [] : [];
  let statBadge = "";
  if (changes.length > 0) {
    let totalAdded = 0;
    let totalRemoved = 0;
    let valid = false;
    for (const ch of changes) {
      const stats = diffStats(ch);
      if (stats) {
        valid = true;
        totalAdded += stats.added;
        totalRemoved += stats.removed;
      }
    }
    if (valid) statBadge = ` [+${totalAdded} -${totalRemoved}]`;
  }
  const name = call?.function.name ?? "tool";
  const target = call ? `${toolTarget(call)}${statBadge}` : "";
  const suffix = ` · ${label}${exit}${durationSuffix(call?.function.name, result, elapsed)}${index === undefined ? "" : ` · #${index}`}`;
  const statusTone: Tone = failed ? "error" : "success";
  const { headerTarget, branch } = commandLayout(name, target, suffix, width);
  const header = compactToolLine(name, headerTarget, suffix, statusTone, width);
  const safeWidth = Math.max(1, width);
  const fit = (value: string, tone: Tone, prefix = ""): RichLine => [
    span(truncate(`${prefix}${sanitizeText(value).replace(/\s+/g, " ").trim()}`, safeWidth), tone),
  ];
  // Bound physical rows as well as logical diff lines, so long source lines
  // cannot flood the transcript. Expanded details retain the existing preview.
  const preview = changes.slice(0, 1).flatMap(change => [...diffLines(change)]);
  const diffBudget = 18;
  const selectedDiff = preview.slice(0, diffBudget);
  if (!selectedDiff.some(row => row[0]?.tone === "success")) {
    const addition = preview.slice(diffBudget).find(row => row[0]?.tone === "success");
    if (addition && selectedDiff.length) selectedDiff[selectedDiff.length - 1] = addition;
  }
  const shownDiff = selectedDiff.map(row => row.map(part => ({ ...part,
    text: truncate(sanitizeText(part.text), safeWidth),
  })));
  // Branch rows share one prefix convention: intermediate rows use │, the final
  // row closes with ╰. Command rows (run_command) precede the detail/warning.
  const branchItems: { value: string; tone: Tone }[] = [
    ...branch.map((value): { value: string; tone: Tone } => ({ value, tone: "muted" })),
    { value: parsed.detail, tone: failed ? "error" : "muted" },
    ...(parsed.warning ? [{ value: parsed.warning, tone: "warning" as Tone }] : []),
  ];
  const branchRows = branchItems.map((item, position) =>
    fit(item.value, item.tone, position === branchItems.length - 1 ? "  ╰ " : "  │ "),
  );
  return [
    // Keep physical rows bounded even when the status suffix exceeds tiny widths.
    fit(header.map(part => part.text).join(""), failed ? "error" : "accent"),
    ...branchRows,
    ...shownDiff,
    ...(preview.length > diffBudget || changes.length > 1 ? [fit("… more diff content", "muted")] : []),
  ];
};

export const toolFinishLines = (
  call: ToolCall | undefined,
  result: ToolResult,
  width = DEFAULT_WIDTH,
  expanded = false,
  elapsed?: number,
): RichLine[] => {
  const name = call?.function.name ?? "tool";
  const target = call ? toolTarget(call) : "";
  const parsed = envelope(result);
  const failed = toolPresentation(name, result).failed
    || (!call && parsed.exitCode !== null && parsed.exitCode !== 0);
  const status: Tone = failed ? "error" : "success";
  const label = failed ? "failed" : "done";
  const exit = parsed.exitCode === null ? "" : ` · exit ${parsed.exitCode}`;
  const header = compactToolLine(
    name,
    target,
    ` · ${label}${exit}${durationSuffix(call?.function.name, result, elapsed)}`,
    status,
    width,
  );
  const logical: RichLine[] = [];
  if (parsed.note) logical.push([span(parsed.note, "muted")]);
  // Explicit expansion may show bounded JSON; default transcript never does.
  const structured = expanded && name !== "run_command" && name !== "read_file"
    ? readValue(result.content) : null;
  const stdoutAll = textLines(structured !== null ? JSON.stringify(structured, null, 2) : parsed.body || parsed.stdout);
  const stdout = stdoutAll.slice(0, expanded ? 80 : PREVIEW_LINES);
  for (const item of stdout)
    logical.push([span(parsed.body ? item : `stdout ${item}`, "muted")]);
  if (stdoutAll.length > stdout.length) {
    logical.push([
      span(`… ${stdoutAll.length - stdout.length} more lines`, "muted"),
    ]);
  }
  const stderrAll = textLines(parsed.stderr);
  const stderr = stderrAll.slice(0, expanded ? 40 : 2);
  for (const item of stderr) logical.push([span(`stderr ${item}`, "error")]);
  if (stderrAll.length > stderr.length) {
    logical.push([span("… more stderr", "muted")]);
  }
  const clipped = clipRows(logical, width, expanded ? 180 : PREVIEW_ROWS);
  const rows: RichLine[] = [header, ...clipped.shown];
  if (clipped.hidden > 0) {
    rows.push([span(`… ${clipped.hidden} more preview lines`, "muted")]);
  }
  const changes = result.changes ?? [];
  for (const change of changes.slice(0, 3)) rows.push(...diffLines(change));
  if (changes.length > 3) rows.push([span("… more file changes", "muted")]);
  return rows;
};
