import type { ToolCall, ToolResult } from "@forge/core/shared/schemas";
import { toolActivity } from "@forge/core/shared/tool-activity";
import { uiSymbols } from "../symbols";
import type { RichLine, Span, Tone } from "../ui-contract";
import { diffLines, diffStats } from "./diff";
import { formatDuration, toolDuration } from "./duration";
import { envelope, textLines } from "./envelope";
import { chrome, toolVerb } from "./labels";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { toolPresentation } from "./tool-presentation";
import { graphemes, stringWidth, truncate } from "./width";

const PREVIEW_LINES = 12;
const PREVIEW_ROWS = 18;
const DEFAULT_WIDTH = 80;
// Bound how many physical rows one run_command branch may occupy in the transcript.
const COMMAND_ROWS = 6;
// Below this width a wrapped command branch costs more rows than it clarifies.
const COMMAND_MIN_WIDTH = 24;
// A completed card keeps one result row plus a short diff; the rest is /tools N.
const SUMMARY_DIFF_ROWS = 8;
// Sub-second timings are noise on a scan row; the exact value stays in /tools N.
const DURATION_FLOOR_MS = 1000;

const span = (text: string, tone?: Tone): Span => ({
  text: sanitizeText(text),
  ...(tone ? { tone } : {}),
});

const line = (...parts: Span[]): RichLine => parts.filter((item) => item.text);

/** Committed-card status glyph; the animation variant stays in the live tail. */
export const statusGlyph = (failed: boolean): string =>
  failed ? uiSymbols().failure : uiSymbols().success;

/** Greedy word wrap for a hanging command branch; hard-splits over-long tokens. */
const wrapCommand = (value: string, limit: number): string[] => {
  const width = Math.max(1, limit);
  const words = sanitizeText(value)
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
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
    else if (stringWidth(current) + 1 + stringWidth(word) <= width)
      current += ` ${word}`;
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
  const fits =
    stringWidth(name) + 1 + stringWidth(target) + stringWidth(suffix) <= limit;
  if (fits) return { headerTarget: target, branch: [] };
  const rows = wrapCommand(target, Math.max(1, limit - 4));
  const shown = rows.slice(0, COMMAND_ROWS);
  const symbols = uiSymbols();
  return {
    headerTarget: "",
    branch: [
      ...shown,
      ...(rows.length > shown.length
        ? [
            `${symbols.ellipsis} ${rows.length - shown.length} more command lines`,
          ]
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
  return readObject(call.function.arguments)
    ? call.function.name
    : "(arguments unavailable)";
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
  const shown =
    room > 0 ? truncate(safeTarget, room, uiSymbols().ellipsis) : "";
  return line(
    span(shownName, "accent"),
    span(shown ? `${gap}${shown}` : ""),
    span(safeSuffix, suffixTone),
  );
};

/** A tool call with no recorded result yet: quiet, because the live tail owns
 * the animated row while the call is actually running. */
export const toolStartLine = (
  call: ToolCall,
  width = DEFAULT_WIDTH,
): RichLine => {
  const symbols = uiSymbols();
  return [
    span(`${symbols.branch} `, "muted"),
    ...compactToolLine(
      toolVerb(call.function.name),
      toolTarget(call),
      "",
      "muted",
      Math.max(1, width - 2),
    ),
  ];
};

/** Animated only by the terminal; never committed as a completed record. */
export const toolRunningLine = (
  call: ToolCall,
  width = DEFAULT_WIDTH,
): RichLine => {
  const symbols = uiSymbols();
  return [
    {
      text: symbols.spinnerFrames[0] ?? symbols.active,
      tone: "muted",
      animation: "spinner",
    },
    span(" "),
    ...compactToolLine(
      toolVerb(call.function.name),
      toolTarget(call),
      "",
      "muted",
      Math.max(1, width - 2),
    ),
  ];
};

export const toolArgumentLines = (
  call: ToolCall,
  width = DEFAULT_WIDTH,
  expanded = false,
): RichLine[] => {
  const args = readObject(call.function.arguments);
  if (!args) return [];
  const symbols = uiSymbols();
  const rows: RichLine[] = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) continue;
    const parts = textLines(text);
    const limit = expanded ? 80 : 3;
    rows.push(
      ...parts
        .slice(0, limit)
        .map((part, index) => [
          span(`  ${index ? "  " : `${key}: `}${part}`, "muted"),
        ]),
    );
    if (parts.length > limit)
      rows.push([
        span(
          `  ${symbols.ellipsis} ${parts.length - limit} more ${key} lines`,
          "muted",
        ),
      ]);
  }
  const clipped = clipRows(rows, width, expanded ? 120 : 6);
  return clipped.hidden
    ? [
        ...clipped.shown,
        [
          span(
            `  ${symbols.ellipsis} ${clipped.hidden} more arguments`,
            "muted",
          ),
        ],
      ]
    : clipped.shown;
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

/** Exact timings stay available on demand; a scan row shows only human-scale ones. */
const summaryDuration = (
  name: string | undefined,
  result: ToolResult,
  elapsed: number | undefined,
  exact = false,
): string => {
  const duration = toolDuration(name, result, elapsed);
  if (duration === undefined) return "";
  if (!exact && duration < DURATION_FLOOR_MS) return "";
  return ` ${uiSymbols().separator} ${formatDuration(duration)}`;
};

const editStats = (call: ToolCall | undefined, result: ToolResult): string => {
  const changes =
    call &&
    ["edit_file", "write_file", "append_file"].includes(call.function.name)
      ? (result.changes ?? [])
      : [];
  if (!changes.length) return "";
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const stats = diffStats(change);
    // One unavailable patch makes the totals a half-truth; omit them instead.
    if (!stats) return "";
    added += stats.added;
    removed += stats.removed;
  }
  return ` +${added} −${removed}`;
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
  const symbols = uiSymbols();
  // Only abnormal exits earn header space; `exit 0` is the expected case.
  const exit =
    parsed.exitCode === null || parsed.exitCode === 0
      ? ""
      : ` ${symbols.separator} exit ${parsed.exitCode}`;
  const name = call?.function.name ?? "tool";
  const verb = toolVerb(name);
  const target = call ? `${toolTarget(call)}${editStats(call, result)}` : "";
  const suffix = failed
    ? ` ${symbols.separator} ${chrome.failed}${exit}${summaryDuration(name, result, elapsed)}`
    : `${exit}${summaryDuration(name, result, elapsed)}`;
  const statusTone: Tone = failed ? "error" : "success";
  const { headerTarget, branch } = commandLayout(
    name,
    target,
    suffix,
    Math.max(1, width - 2),
  );
  const header = compactToolLine(
    verb,
    headerTarget,
    suffix,
    statusTone,
    Math.max(1, width - 2),
  );
  const safeWidth = Math.max(1, width - 2);
  const fit = (
    value: string,
    tone: Tone,
    prefix = "",
    room = width,
  ): RichLine => [
    span(
      truncate(
        `${prefix}${sanitizeText(value).replace(/\s+/g, " ").trim()}`,
        Math.max(1, room),
        symbols.ellipsis,
      ),
      tone,
    ),
  ];
  // diffLines owns physical wrapping and preserves source order and whitespace.
  // Its own path/stats row is omitted here: the header already names the file.
  // It signals clipping by replacing its last row, so a full budget means the
  // diff was cut off and the on-demand view has more.
  const firstChange = result.changes?.[0];
  const diffRows = firstChange
    ? [
        ...diffLines(firstChange, {
          width: safeWidth,
          maxRows: SUMMARY_DIFF_ROWS,
        }),
      ]
    : [];
  const diffClipped = diffRows.length >= SUMMARY_DIFF_ROWS;
  const shownDiff = diffRows
    .slice(1)
    .map((row) => [{ text: "    ", tone: "muted" as Tone }, ...row]);
  // Branch rows share one prefix convention: intermediate rows use the vertical
  // glyph, while the final row closes with the selected branch glyph.
  const branchItems: { value: string; tone: Tone }[] = [
    ...branch.map((value): { value: string; tone: Tone } => ({
      value,
      tone: "muted",
    })),
    { value: parsed.detail, tone: failed ? "error" : "muted" },
    ...(parsed.warning
      ? [{ value: parsed.warning, tone: "warning" as Tone }]
      : []),
  ];
  const branchRows = branchItems.map((item, position) =>
    fit(
      item.value,
      item.tone,
      position === branchItems.length - 1
        ? `  ${symbols.endBranch} `
        : `  ${symbols.vertical} `,
    ),
  );
  // Only a genuinely omitted result earns the hint; a warning already printed
  // in full must not advertise more detail than the card is hiding.
  const overflowHint =
    index !== undefined &&
    (diffClipped || Boolean(result.changes && result.changes.length > 1))
      ? [fit(`/tools ${index} ${symbols.separator} 完整输出`, "muted")]
      : [];
  // Preserve semantic hierarchy: status glyph, accent verb, neutral target,
  // success/error outcome. The glyph owns two cells, so the header is truncated
  // to the room that is actually left; a viewport too narrow for both drops the
  // glyph rather than overflowing the row.
  const glyph = `${statusGlyph(failed)} `;
  const glyphWidth = stringWidth(glyph);
  const shownGlyph = width > glyphWidth ? glyph : "";
  const headerRoom = Math.max(1, width - stringWidth(shownGlyph));
  const composed = header.map((part) => part.text).join("");
  return [
    [
      ...(shownGlyph ? [span(shownGlyph, statusTone)] : []),
      ...(stringWidth(composed) <= headerRoom
        ? header
        : fit(composed, statusTone, "", headerRoom)),
    ],
    ...branchRows,
    ...shownDiff,
    ...(result.changes && result.changes.length > 1
      ? [
          fit(
            `${symbols.ellipsis} 还有 ${result.changes.length - 1} 个文件变更`,
            "muted",
          ),
        ]
      : []),
    ...overflowHint,
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
  const failed =
    toolPresentation(name, result).failed ||
    (!call && parsed.exitCode !== null && parsed.exitCode !== 0);
  const status: Tone = failed ? "error" : "success";
  const symbols = uiSymbols();
  const exit =
    parsed.exitCode === null || parsed.exitCode === 0
      ? ""
      : ` ${symbols.separator} exit ${parsed.exitCode}`;
  const glyph = statusGlyph(failed);
  // The status cell precedes the header; budget it so the whole row fits.
  const glyphPrefix = width > `${glyph} `.length ? `${glyph} ` : "";
  const header = compactToolLine(
    toolVerb(name),
    target,
    `${failed ? ` ${symbols.separator} ${chrome.failed}` : ""}${exit}${summaryDuration(name, result, elapsed, true)}`,
    status,
    Math.max(1, width - glyphPrefix.length),
  );
  const logical: RichLine[] = [];
  if (parsed.note) logical.push([span(parsed.note, "muted")]);
  // Explicit expansion may show bounded JSON; default transcript never does.
  const structured =
    expanded && name !== "run_command" && name !== "read_file"
      ? readValue(result.content)
      : null;
  const stdoutAll = textLines(
    structured !== null
      ? JSON.stringify(structured, null, 2)
      : parsed.body || parsed.stdout,
  );
  const stdout = stdoutAll.slice(0, expanded ? 80 : PREVIEW_LINES);
  for (const item of stdout)
    logical.push([span(parsed.body ? item : `stdout ${item}`, "muted")]);
  if (stdoutAll.length > stdout.length) {
    logical.push([
      span(
        `${symbols.ellipsis} 另有 ${stdoutAll.length - stdout.length} 行`,
        "muted",
      ),
    ]);
  }
  const stderrAll = textLines(parsed.stderr);
  const stderr = stderrAll.slice(0, expanded ? 40 : 2);
  for (const item of stderr) logical.push([span(`stderr ${item}`, "error")]);
  if (stderrAll.length > stderr.length) {
    logical.push([span(`${symbols.ellipsis} 更多 stderr`, "muted")]);
  }
  const clipped = clipRows(logical, width, expanded ? 180 : PREVIEW_ROWS);
  const rows: RichLine[] = [
    [...(glyphPrefix ? [span(glyphPrefix, status)] : []), ...header],
    ...clipped.shown,
  ];
  if (clipped.hidden > 0) {
    rows.push([
      span(`${symbols.ellipsis} 另有 ${clipped.hidden} 行预览`, "muted"),
    ]);
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
  if (changes.length > displayed)
    rows.push([
      span(
        truncate(
          `${symbols.ellipsis} 还有更多文件变更`,
          Math.max(1, width),
          symbols.ellipsis,
        ),
        "muted",
      ),
    ]);
  return rows;
};
