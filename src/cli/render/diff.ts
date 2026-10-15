import type { FileChange } from "../../shared/schemas";
import type { RichLine, Span } from "../ui-contract";
import { type EditStep, editScript } from "./edit-script";
import { sanitizeText } from "./sanitize";

const MAX_LINES = 24;
const CONTEXT = 3;
const row = (text: string, tone?: Span["tone"]): RichLine => [
  tone ? { text: sanitizeText(text), tone } : { text: sanitizeText(text) },
];

// Compare actual text, not sanitized display strings. Preserve CR and final-newline
// differences so visually similar lines are never silently treated as identical.
const linesOf = (value: string): string[] => value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const displayLine = (value: string): string => {
  const terminated = value.endsWith("\n");
  const text = terminated ? value.slice(0, -1) : value;
  return `${text.replace(/\r/g, " ⟪CR⟫")}${terminated ? "" : " ⟪no final newline⟫"}`;
};
const sides = (change: FileChange): readonly [string[], string[]] | null => {
  if (change.truncated) return null;
  if (change.before === null && change.kind !== "created") return null;
  if (change.after === null && change.kind !== "deleted") return null;
  return [linesOf(change.before ?? ""), linesOf(change.after ?? "")];
};
interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: RichLine[];
}

const hunksOf = (script: readonly EditStep[]): Hunk[] => {
  // Merge context ranges in script coordinates. Counting row overlap by old-file
  // line numbers loses insertions/deletions when neighboring hunks overlap.
  const ranges: { from: number; to: number }[] = [];
  for (let index = 0; index < script.length; index += 1) {
    if (script[index]?.op === "equal") continue;
    const range = { from: Math.max(0, index - CONTEXT), to: Math.min(script.length, index + CONTEXT + 1) };
    const previous = ranges.at(-1);
    if (previous && range.from <= previous.to) previous.to = range.to;
    else ranges.push(range);
  }
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const range of ranges) {
    while (cursor < range.from) {
      const step = script[cursor++];
      if (step?.op !== "insert") oldLine += 1;
      if (step?.op !== "delete") newLine += 1;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const rows: RichLine[] = [];
    while (cursor < range.to) {
      const step = script[cursor++];
      if (!step) continue;
      if (step.op !== "insert") oldLine += 1;
      if (step.op !== "delete") newLine += 1;
      rows.push(row(`${step.op === "equal" ? " " : step.op === "delete" ? "-" : "+"}${displayLine(step.text)}`,
        step.op === "equal" ? "muted" : step.op === "delete" ? "error" : "success"));
    }
    const oldCount = oldLine - oldStart;
    const newCount = newLine - newStart;
    hunks.push({ oldStart: oldCount ? oldStart : oldStart - 1, oldCount,
      newStart: newCount ? newStart : newStart - 1, newCount, rows });
  }
  return hunks;
};
const bounded = (lines: readonly RichLine[]): RichLine[] => {
  if (lines.length <= MAX_LINES) return [...lines];
  const head = [...lines.slice(0, MAX_LINES - 1)];
  const addition = lines.slice(MAX_LINES - 1).find(line => line[0]?.tone === "success");
  head.push(addition ?? lines[MAX_LINES - 1] ?? []);
  return [...head, row(`… ${lines.length - MAX_LINES} more diff lines`, "muted")];
};
const scriptOf = (change: FileChange): readonly EditStep[] | null => {
  const pair = sides(change);
  return pair ? editScript(...pair) : null;
};
export const diffStats = (change: FileChange): { added: number; removed: number } | null => {
  const script = scriptOf(change);
  if (!script) return null;
  return { added: script.filter(step => step.op === "insert").length,
    removed: script.filter(step => step.op === "delete").length };
};

/** Unified preview of this tool operation, not the repository's accumulated git diff. */
export const diffLines = (change: FileChange): readonly RichLine[] => {
  const header = row(`--- ${change.path}`, "muted");
  const next = row(`+++ ${change.path}`, "muted");
  const script = scriptOf(change);
  if (!script) {
    const reason = change.truncated
      ? "partial preview; content truncated at source, exact diff unavailable"
      : "full content unavailable or diff computation budget exceeded";
    return [header, next, row(`(changed; ${reason})`, "warning")];
  }
  const added = script.filter(step => step.op === "insert").length;
  const removed = script.filter(step => step.op === "delete").length;
  const stats = row(`${change.path} [+${added} -${removed}]`, "muted");
  const body: RichLine[] = [];
  const hunks = hunksOf(script);
  if (hunks.length === 0) body.push(row("(no textual change)", "muted"));
  for (const hunk of hunks) {
    body.push(row(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`, "muted"));
    body.push(...hunk.rows);
  }
  return bounded([stats, header, next, ...body]);
};
