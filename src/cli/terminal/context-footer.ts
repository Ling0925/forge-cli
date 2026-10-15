import { compactTokens } from "../render/token-count";
import { sanitizeText } from "../render/sanitize";
import { truncate, visibleWidth } from "../theme";
import type { ComposerContext, RichLine, Span, Tone } from "../ui-contract";

const categories = [
  ["instructions", "指令", "contextInstructions"],
  ["memory", "记忆", "contextMemory"],
  ["conversation", "对话", "contextConversation"],
  ["tools", "工具", "contextTools"],
] as const;

function formatModelSpans(
  rawModel: string,
  rawEffort: string | undefined,
  maxRoom: number,
): Span[] {
  if (maxRoom <= 0) return [];
  const modelText = sanitizeText(rawModel).replace(/[\n\t]/g, " ");
  if (!rawEffort) {
    const text = truncate(modelText, maxRoom);
    return text ? [{ text, tone: "accent" }] : [];
  }
  const effortText = ` (${sanitizeText(rawEffort).replace(/[\n\t]/g, " ")})`;
  const modelWidth = visibleWidth(modelText);
  const effortWidth = visibleWidth(effortText);
  if (modelWidth + effortWidth <= maxRoom) {
    return [
      { text: modelText, tone: "accent" },
      { text: effortText, tone: "muted" },
    ];
  }
  if (maxRoom <= modelWidth) {
    const text = truncate(modelText, maxRoom);
    return text ? [{ text, tone: "accent" }] : [];
  }
  const remaining = maxRoom - modelWidth;
  return [
    { text: modelText, tone: "accent" },
    { text: truncate(effortText, remaining), tone: "muted" },
  ];
}

function formatIdentitySpans(context: ComposerContext, room: number): Span[] {
  const spans = formatModelSpans(context.model, context.reasoningEffort, room);
  const used = spans.reduce((sum, span) => sum + visibleWidth(span.text), 0);
  const title = sanitizeText(context.sessionTitle ?? "").replace(/[\n\t]/g, " ").trim();
  const remaining = room - used;
  // Model/effort and the right-hand usage summary retain priority on narrow screens.
  if (title && remaining > 3) {
    spans.push({ text: ` · ${truncate(title, remaining - 3)}`, tone: "muted" });
  }
  return spans;
}

/** Full-width track; the red right-hand segment marks compression headroom. */
export function contextFooter(context: ComposerContext, columns: number, compact = false): readonly RichLine[] {
  const width = Math.max(1, Math.floor(columns));
  const usage = context.usage;
  const ratio = usage?.windowTokens ? usage.usedTokens / usage.windowTokens : 0;
  const percentage = usage?.windowTokens ? `${usage.estimated ? "≈" : ""}${(ratio * 100).toFixed(1)}%` : "?%";
  const count = usage?.windowTokens ? compactTokens(usage.windowTokens) : "?";
  const cached = usage?.cachedPromptTokens;
  const input = usage?.promptTokens;
  const cacheRate = usage?.basis !== "projected" && input !== undefined && input > 0
    && cached !== undefined && Number.isFinite(cached) && cached >= 0 && cached <= input
    ? `${Number((cached / input * 100).toFixed(1))}%` : "—";
  const summaryText = `${percentage} · R${cacheRate} · ${count}`;
  if (compact) {
    const miniWidth = width >= 40 ? 6 : 0;
    const filled = Math.round(Math.min(1, Math.max(0, ratio)) * miniWidth);
    const mini = miniWidth ? ` [${"━".repeat(filled)}${"·".repeat(miniWidth - filled)}]` : "";
    const summary = truncate(`${summaryText}${mini}`, width);
    const room = Math.max(0, width - visibleWidth(summary) - 1);
    const modelSpans = formatIdentitySpans(context, room);
    const modelWidth = modelSpans.reduce((sum, s) => sum + visibleWidth(s.text), 0);
    return [[
      ...modelSpans,
      { text: " ".repeat(Math.max(0, width - modelWidth - visibleWidth(summary))) },
      { text: summary, tone: ratio >= 0.8 ? "warning" : "muted" },
    ]];
  }
  const right = truncate(summaryText, width);
  // Only token budgets with a known window define a meaningful reserved fraction.
  const reserveStart = usage?.windowTokens && usage.budgetTokens !== undefined
    ? Math.round(Math.min(1, Math.max(0, usage.budgetTokens / usage.windowTokens)) * width)
    : width;
  const room = Math.max(0, width - visibleWidth(right) - 2);
  const modelSpans = formatIdentitySpans(context, room);
  const modelWidth = modelSpans.reduce((sum, s) => sum + visibleWidth(s.text), 0);
  const info: Span[] = [
    ...modelSpans,
    { text: " ".repeat(Math.max(0, width - modelWidth - visibleWidth(right))) },
    { text: right, tone: ratio >= 0.9 ? "warning" : "muted" },
  ];
  const filled = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  const total = usage ? categories.reduce((sum, [key]) => sum + usage.parts[key], 0) : 0;
  const allocations = categories.map(([key, , tone], index) => {
    const exact = total && usage ? usage.parts[key] / total * filled : 0;
    return { index, tone: tone as Tone, count: Math.floor(exact), remainder: exact % 1 };
  });
  let remaining = filled - allocations.reduce((sum, item) => sum + item.count, 0);
  for (const item of [...allocations].sort((a, b) => b.remainder - a.remainder)) {
    if (remaining <= 0) break;
    item.count++;
    remaining--;
  }
  const bar: Span[] = [];
  let used = 0;
  for (const item of allocations) {
    // Keep the full-window scale; reserved cells take precedence over usage color.
    const count = Math.min(item.count, Math.max(0, reserveStart - used));
    if (count) bar.push({ text: "─".repeat(count), tone: item.tone });
    used += count;
  }
  if (used < reserveStart) bar.push({ text: "─".repeat(reserveStart - used), tone: "muted" });
  if (reserveStart < width) bar.push({ text: "─".repeat(width - reserveStart), tone: "error" });
  return [info, bar];
}
