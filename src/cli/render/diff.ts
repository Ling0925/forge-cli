import type { FileChange } from "../../shared/schemas";
import { createDiffPatch, unavailablePatch } from "../../shared/diff";
import type { RichLine, Span } from "../ui-contract";
import { ControlFilter, sanitizeText } from "./sanitize";
import { graphemes, graphemeWidth, stringWidth, truncate } from "./width";

type Patch = ReturnType<typeof createDiffPatch>;
type PatchLine = Patch["hunks"][number]["lines"][number];
export interface DiffOptions { width?: number; maxRows?: number }
const unavailable: Patch = unavailablePatch();
const patchOf = (change: FileChange): Patch => change.patch ?? unavailable;
export const diffStats = (change: FileChange): { added: number; removed: number } | null => {
  const patch = patchOf(change);
  return patch.status !== "unavailable" && patch.added !== undefined && patch.removed !== undefined
    ? { added: patch.added, removed: patch.removed } : null;
};
const row = (text: string, tone: NonNullable<Span["tone"]> = "muted"): RichLine => [{ text: sanitizeText(text), tone }];
const toneOf = (op: PatchLine["op"]): NonNullable<Span["tone"]> =>
  op === "equal" ? "muted" : op === "delete" ? "diffRemoved" : "diffAdded";
const wordTone = (op: PatchLine["op"]): NonNullable<Span["tone"]> => op === "delete" ? "diffRemovedWord" : "diffAddedWord";

// Compare raw graphemes first: tabs, CRs and final newlines must not disappear
// before comparison. Only a bounded, similar replacement pair gets word emphasis.
const emphasis = (lines: readonly PatchLine[]): Map<number, readonly [number, number]> => {
  const result = new Map<number, readonly [number, number]>();
  for (let start = 0; start < lines.length;) {
    if (lines[start]?.op === "equal") { start += 1; continue; }
    let end = start;
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (end < lines.length && lines[end]?.op !== "equal") {
      if (lines[end]?.op === "delete") deleted.push(end); else inserted.push(end);
      end += 1;
    }
    for (let pair = 0; pair < Math.min(deleted.length, inserted.length, 32); pair += 1) {
      const aIndex = deleted[pair]!;
      const bIndex = inserted[pair]!;
      const aText = lines[aIndex]!.text;
      const bText = lines[bIndex]!.text;
      if (aText.length > 4096 || bText.length > 4096) continue;
      const a = graphemes(aText);
      const b = graphemes(bText);
      let prefix = 0;
      let suffix = 0;
      while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix += 1;
      while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix += 1;
      if (prefix + suffix < Math.max(3, Math.min(a.length, b.length) / 3)) continue;
      result.set(aIndex, [prefix, a.length - suffix]);
      result.set(bIndex, [prefix, b.length - suffix]);
    }
    start = end;
  }
  return result;
};

const displaySpans = (line: PatchLine, highlight?: readonly [number, number]): Span[] => {
  const result: Span[] = [];
  const baseTone = toneOf(line.op);
  let column = 0;
  const append = (text: string, tone = baseTone): void => {
    if (!text) return;
    const previous = result.at(-1);
    if (previous?.tone === tone) result[result.length - 1] = { ...previous, text: previous.text + text };
    else result.push({ text, tone });
  };
  const glyphs = graphemes(line.text);
  const filter = new ControlFilter();
  for (let index = 0; index < glyphs.length; index += 1) {
    const glyph = glyphs[index]!;
    const tone = highlight && index >= highlight[0] && index < highlight[1] ? wordTone(line.op) : baseTone;
    // Segmenter treats CRLF as one grapheme. Preserve the CR as an explicit marker.
    if (glyph === "\n") continue;
    let text: string;
    if (glyph === "\r\n" || glyph === "\r") text = " ⟪CR⟫";
    else if (glyph === "\t") text = " ".repeat(4 - column % 4);
    else text = glyph;
    // Preserve filter state across graphemes so OSC/CSI payloads cannot leak.
    text = filter.push(text);
    append(text, tone);
    column += stringWidth(text);
  }
  if (!line.text.endsWith("\n")) append(" ⟪no final newline⟫");
  return result;
};

/** Whitespace-preserving soft wrap; continuation rows keep the gutter, not a new line number. */
function* wrapSource(parts: readonly Span[], prefix: string, continuation: string, width: number): Generator<RichLine> {
  let current: Span[] = [{ text: prefix, tone: "muted" }];
  let used = stringWidth(prefix);
  let content = false;
  const push = (text: string, tone: NonNullable<Span["tone"]>): void => {
    const previous = current.at(-1);
    if (previous?.tone === tone) current[current.length - 1] = { ...previous, text: previous.text + text };
    else current.push({ text, tone });
  };
  for (const part of parts) for (const glyph of graphemes(part.text)) {
    const size = graphemeWidth(glyph);
    if (used + size > width && content) {
      yield current;
      current = [{ text: continuation, tone: "muted" }];
      used = stringWidth(continuation);
      content = false;
    }
    // A two-cell grapheme cannot fit a one-cell viewport. Mark the omission,
    // never emit half of a surrogate pair / combining sequence or overflow.
    if (used + size > width) { push("…", "muted"); used += 1; content = true; continue; }
    push(glyph, part.tone ?? "text");
    used += size;
    content = true;
  }
  yield current;
}

/** Unified preview of this tool operation, not the repository's accumulated git diff. */
export const diffLines = (change: FileChange, options: DiffOptions = {}): readonly RichLine[] => {
  const width = Math.max(1, Math.floor(options.width ?? 80));
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? 24));
  const patch = patchOf(change);
  const meta = (text: string, tone: NonNullable<Span["tone"]> = "muted"): RichLine => row(truncate(sanitizeText(text), width), tone);
  function* render(): Generator<RichLine> {
    const stats = diffStats(change);
    const created = change.kind === "created";
    yield meta(stats ? created ? `${change.path} · new file · ${stats.added} lines` : `${change.path} [+${stats.added} -${stats.removed}]` : `${change.path} · changed`);
    if (patch.status === "unavailable") {
      yield meta(`(exact diff unavailable; ${patch.reason === "budget" ? "diff computation budget exceeded" : "full content unavailable"})`, "warning");
      return;
    }
    if (patch.hunks.length === 0 && patch.status === "complete") {
      yield meta(change.kind === "created" ? "(empty file created)" : "(no textual change)");
    }
    for (const hunk of patch.hunks) {
      if (!created) yield meta(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      const highlights = emphasis(hunk.lines);
      const digits = String(Math.max(hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines)).length;
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (let index = 0; index < hunk.lines.length; index += 1) {
        const item = hunk.lines[index]!;
        const number = item.op === "delete" ? oldLine : newLine;
        const sign = created ? " " : item.op === "delete" ? "-" : item.op === "insert" ? "+" : " ";
        // Reserve two cells of source room whenever possible, collapsing only
        // the gutter at very narrow terminal sizes.
        const fullPrefix = `${String(number).padStart(digits)} ${sign} `;
        const prefix = stringWidth(fullPrefix) + 2 <= width ? fullPrefix : width >= 4 ? `${sign} ` : "";
        const continuation = prefix ? `${" ".repeat(Math.max(0, stringWidth(prefix) - 2))}${sign} ` : "";
        const parts = displaySpans(item, highlights.get(index));
        yield* wrapSource(created ? parts.map(part => ({ ...part, tone: "text" as const })) : parts, prefix, continuation, width);
        if (item.op !== "insert") oldLine += 1;
        if (item.op !== "delete") newLine += 1;
      }
    }
    if (patch.status === "truncated") {
      yield meta(`… patch truncated: ${patch.omittedLines} lines / ${patch.omittedHunks} hunks omitted`, "warning");
    }
  }
  const rows: RichLine[] = [];
  for (const item of render()) {
    if (rows.length === maxRows) {
      // Keep an honest prefix of the diff. Never swap a later green row into it.
      rows[maxRows - 1] = meta(`… more diff content omitted${patch.status === "truncated" ? " (patch also truncated)" : ""}`, "warning");
      break;
    }
    rows.push(item);
  }
  return rows;
};
