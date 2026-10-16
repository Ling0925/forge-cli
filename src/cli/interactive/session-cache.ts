import type { AgentEvent, SessionSnapshot } from "../../shared/schemas";
import { uiSymbols } from "../symbols";

export interface SessionCacheUsage {
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  /** Some requests did not report a valid input/cache pair. */
  readonly partial: boolean;
}
const empty = (): SessionCacheUsage => ({ promptTokens: 0, cachedPromptTokens: 0, partial: false });
const add = (a: SessionCacheUsage, b: SessionCacheUsage): SessionCacheUsage => ({
  promptTokens: a.promptTokens + b.promptTokens,
  cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
  partial: a.partial || b.partial,
});
function reported(prompt: number | undefined, cached: number | undefined): SessionCacheUsage {
  if (prompt === undefined || cached === undefined || !Number.isSafeInteger(prompt) || !Number.isSafeInteger(cached)
    || prompt < 0 || cached < 0 || cached > prompt) return { ...empty(), partial: true };
  return { promptTokens: prompt, cachedPromptTokens: cached, partial: false };
}

/** Session-wide token-weighted cache usage, independent of the current context window. */
export class SessionCache {
  private sessionId: string | undefined;
  private completed = empty();
  private run = empty();
  private detailed = false;
  private pending: SessionCacheUsage | undefined;
  constructor(session?: Pick<SessionSnapshot, "id" | "events">) { this.restore(session); }
  restore(session?: Pick<SessionSnapshot, "id" | "events">): void {
    this.sessionId = session?.id;
    this.completed = empty(); this.run = empty(); this.detailed = false; this.pending = undefined;
    for (const event of session?.events ?? []) this.push(event);
  }
  ensureSession(session?: Pick<SessionSnapshot, "id" | "events">): void {
    if (session?.id !== this.sessionId) this.restore(session);
  }
  private flush(): void {
    if (this.pending) { this.run = add(this.run, this.pending); this.pending = undefined; }
  }
  push(event: AgentEvent): void {
    if (event.sessionId !== this.sessionId) return;
    if (event.type === "run_started") {
      this.flush(); this.completed = add(this.completed, this.run);
      this.run = empty(); this.detailed = false;
    } else if (event.type === "context_usage") {
      const usage = event.usage;
      if (usage.basis === "projected") { this.flush(); return; }
      this.detailed = true;
      // request-with-output supersedes an input-only report for the same request.
      const value = reported(usage.promptTokens, usage.cachedPromptTokens);
      if (usage.basis === "request") this.pending = value;
      else { this.pending = undefined; this.run = add(this.run, value); }
    } else if (event.type === "run_finished") {
      this.flush();
      // Older records may only contain run totals. Never count both totals and requests.
      const value = this.detailed ? this.run : reported(event.usage?.promptTokens, event.usage?.cachedPromptTokens);
      this.completed = add(this.completed, { ...value, partial: value.partial || event.usageComplete === false });
      this.run = empty(); this.detailed = false;
    }
  }
  snapshot(): SessionCacheUsage { return add(add(this.completed, this.run), this.pending ?? empty()); }
}

export function cacheRate(usage?: SessionCacheUsage): string {
  const prompt = usage?.promptTokens ?? 0;
  const cached = usage?.cachedPromptTokens ?? 0;
  const valid = Number.isFinite(prompt) && Number.isFinite(cached) && prompt > 0 && cached >= 0 && cached <= prompt;
  const rate = valid ? Number((cached / prompt * 100).toFixed(1)) : 0;
  return `${usage?.partial ? uiSymbols().approximate : ""}${rate}%`;
}
