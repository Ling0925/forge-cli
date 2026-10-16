import type { ToolCall, ToolResult } from "../../shared/schemas";
import { toolActivity } from "../../shared/tool-activity";
import { uiSymbols } from "../symbols";
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
  const symbols = uiSymbols();
  return {
    headerTarget: "",
    branch: [
      ...shown,
      ...(rows.length > shown.length
        ? [`${symbols.ellipsis} ${rows.length - shown.length} more command lines`]
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
  // Shared extraction, including name-based command redaction, so the CLI line
  // and the desktop row describe the same thing. Falls back to the name when no
  // scalar target exists, and flags malformed arguments explicitly.
  const { target } = toolActivity(call);
  if (target) return target;
  return readObject(call.function.arguments) ? call.function.name : "(arguments unavailable)";
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
    : truncate(safeName, limit - suffixWidth, uiSymbols().ellipsis);
  const gap = safeTarget && shownName ? " " : "";
  const room = limit - stringWidth(shownName) - stringWidth(gap) - suffixWidth;
  const shown = room > 0 ? truncate(safeTarget, room, uiSymbols().ellipsis) : "";
  return line(
    span(shownName, "accent"),
    span(shown ? `${gap}${shown}` : ""),
    span(safeSuffix, suffixTone),
  );
};

export const toolStartLine = (
  call: ToolCall,
  width = DEFAULT_WIDTH,
): RichLine => {
  const symbols = uiSymbols();
  return compactToolLine(
    call.function.name,
    toolTarget(call),
    ` ${symbols.separator} running`,
    "muted",
    width,
  );
};

/** Animated only by the terminal; never committed as a completed record. */
export const toolRunningLine = (call: ToolCall, width = DEFAULT_WIDTH): RichLine => {
  const symbols = uiSymbols();
  return [
    { text: symbols.spinnerFrames[0] ?? symbols.active, tone: "muted", animation: "spinner" },
    span(" "),
    ...toolStartLine(call, Math.max(1, width - 2)),
  ];
};

export const toolArgumentLines = (call: ToolCall, width = DEFAULT_WIDTH, expanded = false): RichLine[] => {
  const args = readObject(call.function.arguments);
  if (!args) return [];
  const symbols = uiSymbols();
  const rows: RichLine[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) continue;
    const parts = textLines(text);
    const limit = expanded ? 80 : 3;
    rows.push(...parts.slice(0, limit).map((part, index) =>
      [span(`  ${index ? "  " : `${key}: `}${part}`, "muted")],
    ));
    if (parts.length > limit) rows.push([span(`  ${symbols.ellipsis} ${parts.length - limit} more ${key} lines`, "muted")]);
  }
  const clipped = clipRows(rows, width, expanded ? 120 : 6);
  return clipped.hidden ? [...clipped.shown, [span(`  ${symbols.ellipsis} ${clipped.hidden} more arguments`, "muted")]] : clipped.shown;
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
  const symbols = uiSymbols();
  const exit = parsed.exitCode === null ? "" : ` ${symbols.separator} exit ${parsed.exitCode}`;
  const changes = call && ["edit_file", "write_file"].includes(call.function.name) ? result.changes ?? [] : [];
  let statBadge = "";
  if (changes.length > 0) {
    let totalAdded = 0;
    let totalRemoved = 0;
    let valid = true;
    for (const ch of changes) {
      const stats = diffStats(ch);
      if (stats) {
        totalAdded += stats.added;
        totalRemoved += stats.removed;
      } else valid = false;
    }
    if (valid) statBadge = ` [+${totalAdded} -${totalRemoved}]`;
  }
  const name = call?.function.name ?? "tool";
  const target = call ? `${toolTarget(call)}${statBadge}` : "";
  const suffix = ` ${symbols.separator} ${label}${exit}${durationSuffix(call?.function.name, result, elapsed)}${index === undefined ? "" : ` ${symbols.separator} #${index}`}`;
  const statusTone: Tone = failed ? "error" : "success";
  const { headerTarget, branch } = commandLayout(name, target, suffix, width);
  const header = compactToolLine(name, headerTarget, suffix, statusTone, width);
  const safeWidth = Math.max(1, width);
  const fit = (value: string, tone: Tone, prefix = ""): RichLine => [
    span(truncate(`${prefix}${sanitizeText(value).replace(/\s+/g, " ").trim()}`, safeWidth, symbols.ellipsis), tone),
  ];
  // diffLines owns physical wrapping and preserves source order and whitespace.
  const shownDiff = changes.slice(0, 1).flatMap(change => [...diffLines(change, { width: safeWidth, maxRows: 20 })]);
  // Branch rows share one prefix convention: intermediate rows use the vertical
  // glyph, while the final row closes with the selected branch glyph.
  const branchItems: { value: string; tone: Tone }[] = [
    ...branch.map((value): { value: string; tone: Tone } => ({ value, tone: "muted" })),
    { value: parsed.detail, tone: failed ? "error" : "muted" },
    ...(parsed.warning ? [{ value: parsed.warning, tone: "warning" as Tone }] : []),
  ];
  const branchRows = branchItems.map((item, position) =>
    fit(item.value, item.tone, position === branchItems.length - 1 ? `  ${symbols.endBranch} ` : `  ${symbols.vertical} `),
  );
  return [
    // Preserve semantic hierarchy: accent tool name, neutral target, success/error
    // outcome. Only flatten when even the status suffix exceeds a tiny viewport.
    stringWidth(header.map(part => part.text).join("")) <= safeWidth
      ? header : fit(header.map(part => part.text).join(""), failed ? "error" : "accent"),
    ...branchRows,
    ...shownDiff,
    ...(changes.length > 1 ? [fit(`${symbols.ellipsis} more file changes`, "muted")] : []),
    ...(index !== undefined && shownDiff.some(row => row.some(part => part.text.includes("omitted")))
      ? [fit(`/tools ${index} ${symbols.separator} more diff details`, "muted")] : []),
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
  const symbols = uiSymbols();
  const exit = parsed.exitCode === null ? "" : ` ${symbols.separator} exit ${parsed.exitCode}`;
  const header = compactToolLine(
    name,
    target,
    ` ${symbols.separator} ${label}${exit}${durationSuffix(call?.function.name, result, elapsed)}`,
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
      span(`${symbols.ellipsis} ${stdoutAll.length - stdout.length} more lines`, "muted"),
    ]);
  }
  const stderrAll = textLines(parsed.stderr);
  const stderr = stderrAll.slice(0, expanded ? 40 : 2);
  for (const item of stderr) logical.push([span(`stderr ${item}`, "error")]);
  if (stderrAll.length > stderr.length) {
    logical.push([span(`${symbols.ellipsis} more stderr`, "muted")]);
  }
  const clipped = clipRows(logical, width, expanded ? 180 : PREVIEW_ROWS);
  const rows: RichLine[] = [header, ...clipped.shown];
  if (clipped.hidden > 0) {
    rows.push([span(`${symbols.ellipsis} ${clipped.hidden} more preview lines`, "muted")]);
  }
  const changes = result.changes ?? [];
  let remaining = expanded ? 200 : 24;
  let displayed = 0;
  for (const change of changes) {
    if (remaining < 3) break;
    const preview = diffLines(change, { width, maxRows: remaining });
    rows.push(...preview);
    remaining -= preview.length;
    displayed += 1;
  }
  if (changes.length > displayed) rows.push([span(truncate(`${symbols.ellipsis} more file changes`, Math.max(1, width), symbols.ellipsis), "muted")]);
  return rows;
};
