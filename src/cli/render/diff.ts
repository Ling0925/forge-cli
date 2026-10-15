import type { FileChange } from "../../shared/schemas";
import type { RichLine, Span } from "../ui-contract";
import { type EditStep, editScript } from "./edit-script";
import { sanitizeText } from "./sanitize";

const MAX_LINES = 24;
const CONTEXT = 3;

const row = (text: string, tone?: Span["tone"]): RichLine => [
  tone ? { text: sanitizeText(text), tone } : { text: sanitizeText(text) },
];

const linesOf = (value: string): string[] => {
  const clean = sanitizeText(value).replace(/\n$/, "");
  return clean.length === 0 ? [] : clean.split("\n");
};

interface Side {
  readonly lines: readonly string[] | null;
  readonly known: boolean;
}

/** Null means unknown only when the change kind still requires that side. */
const side = (
  value: string | null,
  kind: FileChange["kind"],
  role: "before" | "after",
): Side => {
  if (value !== null) return { lines: linesOf(value), known: true };
  if (role === "before" && kind === "created")
    return { lines: [], known: true };
  if (role === "after" && kind === "deleted") return { lines: [], known: true };
  return { lines: null, known: false };
};

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: RichLine[];
}

const hunksOf = (
  before: readonly string[],
  after: readonly string[],
): Hunk[] => {
  const script: readonly EditStep[] | null = editScript(before, after);
  if (!script) {
    return [
      {
        oldStart: before.length === 0 ? 0 : 1,
        oldCount: before.length,
        newStart: after.length === 0 ? 0 : 1,
        newCount: after.length,
        rows: [
          ...before.map((line) => row(`-${line}`, "error")),
          ...after.map((line) => row(`+${line}`, "success")),
        ],
      },
    ];
  }
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;
  let index = 0;
  while (index < script.length) {
    if (script[index]?.op === "equal") {
      oldLine += 1;
      newLine += 1;
      index += 1;
      continue;
    }
    const changeAt = index;
    while (index < script.length && script[index]?.op !== "equal") index += 1;
    const changeEnd = index;
    let prefix = 0;
    while (
      prefix < CONTEXT &&
      changeAt - prefix - 1 >= 0 &&
      script[changeAt - prefix - 1]?.op === "equal"
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < CONTEXT &&
      changeEnd + suffix < script.length &&
      script[changeEnd + suffix]?.op === "equal"
    ) {
      suffix += 1;
    }
    const from = changeAt - prefix;
    const to = changeEnd + suffix;
    let oldCount = 0;
    let newCount = 0;
    const rows: RichLine[] = [];
    for (let cursor = from; cursor < to; cursor += 1) {
      const step = script[cursor];
      if (!step) continue;
      if (step.op === "equal") {
        rows.push(row(` ${step.text}`, "muted"));
        oldCount += 1;
        newCount += 1;
      } else if (step.op === "delete") {
        rows.push(row(`-${step.text}`, "error"));
        oldCount += 1;
      } else {
        rows.push(row(`+${step.text}`, "success"));
        newCount += 1;
      }
    }
    const oldStart = oldLine - prefix;
    const newStart = newLine - prefix;
    const previous = hunks.at(-1);
    if (
      previous &&
      oldStart <= previous.oldStart + Math.max(previous.oldCount, 1)
    ) {
      const overlap = previous.oldStart + previous.oldCount - oldStart;
      hunks[hunks.length - 1] = {
        oldStart: previous.oldStart,
        oldCount: previous.oldCount + oldCount - overlap,
        newStart: previous.newStart,
        newCount: previous.newCount + newCount - overlap,
        rows: [...previous.rows, ...rows.slice(overlap)],
      };
    } else {
      hunks.push({
        oldStart: oldCount === 0 ? oldStart - 1 : oldStart,
        oldCount,
        newStart: newCount === 0 ? newStart - 1 : newStart,
        newCount,
        rows,
      });
    }
    for (let cursor = changeAt; cursor < changeEnd; cursor += 1) {
      const step = script[cursor];
      if (step?.op === "delete") oldLine += 1;
      else if (step?.op === "insert") newLine += 1;
    }
  }
  return hunks;
};

const bounded = (lines: readonly RichLine[]): RichLine[] => {
  if (lines.length <= MAX_LINES) return [...lines];
  const head = [...lines.slice(0, MAX_LINES - 1)];
  const addition = lines
    .slice(MAX_LINES - 1)
    .find(
      (line) =>
        line[0]?.text.startsWith("+") && !line[0]?.text.startsWith("+++"),
    );
  if (addition) head.push(addition);
  else head.push(lines[MAX_LINES - 1] ?? []);
  return [
    ...head,
    row(`… ${lines.length - MAX_LINES} more diff lines`, "muted"),
  ];
};

export const diffStats = (change: FileChange): { added: number; removed: number } | null => {
  const before = side(change.before, change.kind, "before");
  const after = side(change.after, change.kind, "after");
  if (!before.known || !after.known || !before.lines || !after.lines) return null;
  const hunks = hunksOf(before.lines, after.lines);
  const changedRows = hunks.flatMap(hunk => hunk.rows);
  const added = changedRows.filter(line => line[0]?.tone === "success").length;
  const removed = changedRows.filter(line => line[0]?.tone === "error").length;
  return { added, removed };
};

/** Unified diff from real before/after text. Missing text is not invented. */
export const diffLines = (change: FileChange): readonly RichLine[] => {
  const before = side(change.before, change.kind, "before");
  const after = side(change.after, change.kind, "after");
  const header = row(`--- ${change.path}`, "muted");
  const next = row(`+++ ${change.path}`, "muted");
  if (!before.known || !after.known || !before.lines || !after.lines) {
    return [header, next, row("(changed; full content unavailable)", "muted")];
  }
  const body: RichLine[] = [];
  const hunks = hunksOf(before.lines, after.lines);
  const changedRows = hunks.flatMap(hunk => hunk.rows);
  const added = changedRows.filter(line => line[0]?.tone === "success").length;
  const removed = changedRows.filter(line => line[0]?.tone === "error").length;
  const stats = row(`${change.path} [+${added} -${removed}]${change.truncated ? " (partial preview)" : ""}`, "muted");
  if (hunks.length === 0) body.push(row("(no textual change)", "muted"));
  for (const hunk of hunks) {
    body.push(
      row(
        `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
        "muted",
      ),
    );
    body.push(...hunk.rows);
  }
  if (change.truncated)
    body.push(row("(content truncated at source)", "warning"));
  return bounded([stats, header, next, ...body]);
};
