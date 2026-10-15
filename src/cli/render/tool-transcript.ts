import type { ToolCall, ToolResult } from "../../shared/schemas";
import type { RichLine } from "../ui-contract";
import { toolArgumentLines, toolFinishLines, toolSummaryLines, toolStartLine } from "./tools";
import { wrapRichLines } from "./rich";

/** In-memory display index, scoped to one session. No tool result is re-executed. */
export class ToolTranscript {
  private readonly records: { call: ToolCall; result?: ToolResult; startedAt?: number; elapsed?: number }[] = [];
  private readonly positions = new Map<string, number>();

  start(call: ToolCall, startedAt?: number): number {
    const existing = this.positions.get(call.id);
    if (existing !== undefined) return existing;
    const index = this.records.push({ call, ...(startedAt !== undefined && Number.isFinite(startedAt) ? { startedAt } : {}) });
    this.positions.set(call.id, index);
    return index;
  }

  finish(id: string, result: ToolResult, finishedAt?: number): number | undefined {
    const index = this.positions.get(id);
    const record = index === undefined ? undefined : this.records[index - 1];
    if (record) {
      if (!record.result && record.startedAt !== undefined && finishedAt !== undefined && Number.isFinite(finishedAt)) {
        record.elapsed = Math.max(0, finishedAt - record.startedAt);
      }
      record.result = result;
    }
    return index;
  }

  summary(id: string, result: ToolResult, width: number, finishedAt?: number): RichLine[] {
    const index = this.finish(id, result, finishedAt);
    const record = index === undefined ? undefined : this.records[index - 1];
    return toolSummaryLines(record?.call, result, width, index, record?.elapsed);
  }

  list(width: number): readonly RichLine[] {
    if (!this.records.length) return [[{ text: "No tools in this session.", tone: "muted" }]];
    const recent = this.records.slice(-20);
    const first = this.records.length - recent.length + 1;
    const lines: RichLine[] = [];
    if (first > 1) lines.push([{ text: `Showing last 20 of ${this.records.length} tools. /tools N opens any tool.`, tone: "muted" }]);
    for (const [offset, record] of recent.entries()) {
      lines.push(...(record.result
        ? toolSummaryLines(record.call, record.result, width, first + offset, record.elapsed).slice(0, 1)
        : [[...toolStartLine(record.call, width), { text: ` · #${first + offset}`, tone: "muted" as const }]]));
    }
    return wrapRichLines(lines, width);
  }

  detail(index: number, width: number): readonly RichLine[] {
    const record = Number.isSafeInteger(index) && index > 0 ? this.records[index - 1] : undefined;
    if (!record) return [[{ text: `No tool #${index}. Use /tools to list recent tools.`, tone: "warning" }]];
    return wrapRichLines([
      [{ text: `Tool #${index}`, tone: "accent" }],
      ...(record.result ? [] : [toolStartLine(record.call, width)]),
      ...toolArgumentLines(record.call, width, true),
      ...(record.result ? toolFinishLines(record.call, record.result, width, true, record.elapsed) : [[{ text: "Result not recorded.", tone: "muted" as const }]]),
    ], width);
  }
}
