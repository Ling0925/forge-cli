import type { ToolCall, ToolResult } from "../../shared/schemas";
import type { RichLine, Span, Tone } from "../ui-contract";
import { diffLines } from "./diff";
import { envelope, textLines } from "./envelope";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { stringWidth, truncate } from "./width";

const PREVIEW_LINES = 4;
const PREVIEW_ROWS = 6;
const DEFAULT_WIDTH = 80;

const span = (text: string, tone?: Tone): Span => ({
  text: sanitizeText(text),
  ...(tone ? { tone } : {}),
});

const line = (...parts: Span[]): RichLine => parts.filter((item) => item.text);

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
  if (!args) return sanitizeText(call.function.arguments);
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

export const toolFinishLines = (
  call: ToolCall | undefined,
  result: ToolResult,
  width = DEFAULT_WIDTH,
): RichLine[] => {
  const name = call?.function.name ?? "tool";
  const target = call ? toolTarget(call) : "";
  const parsed = envelope(result);
  const failed =
    result.isError || (parsed.exitCode !== null && parsed.exitCode !== 0);
  const status: Tone = failed ? "error" : "success";
  const label = failed ? "failed" : "done";
  const exit = parsed.exitCode === null ? "" : ` · exit ${parsed.exitCode}`;
  const header = compactToolLine(
    name,
    target,
    ` · ${label}${exit}`,
    status,
    width,
  );
  const logical: RichLine[] = [];
  if (parsed.note) logical.push([span(parsed.note, "muted")]);
  const stdout = textLines(parsed.body || parsed.stdout).slice(
    0,
    PREVIEW_LINES,
  );
  const stdoutAll = textLines(parsed.body || parsed.stdout);
  for (const item of stdout)
    logical.push([span(parsed.body ? item : `stdout ${item}`, "muted")]);
  if (stdoutAll.length > stdout.length) {
    logical.push([
      span(`… ${stdoutAll.length - stdout.length} more lines`, "muted"),
    ]);
  }
  const stderr = textLines(parsed.stderr).slice(0, 2);
  for (const item of stderr) logical.push([span(`stderr ${item}`, "error")]);
  if (textLines(parsed.stderr).length > stderr.length) {
    logical.push([span("… more stderr", "muted")]);
  }
  const clipped = clipRows(logical, width, PREVIEW_ROWS);
  const rows: RichLine[] = [header, ...clipped.shown];
  if (clipped.hidden > 0) {
    rows.push([span(`… ${clipped.hidden} more preview lines`, "muted")]);
  }
  const changes = result.changes ?? [];
  for (const change of changes.slice(0, 3)) rows.push(...diffLines(change));
  if (changes.length > 3) rows.push([span("… more file changes", "muted")]);
  return rows;
};
