import type { RichLine } from "../ui-contract";

/** Local rendering cache only; never changes provider prompts. Cost bounds UTF-16
 * text plus a conservative per-span allowance, not an exact JS heap measurement. */
export class MarkdownCache {
  private readonly entries = new Map<string, { lines: RichLine[]; cost: number }>();
  private cost = 0;
  constructor(private readonly maxEntries = 128, private readonly maxCost = 2_000_000) {}
  get size(): number { return this.entries.size; }
  get retainedCost(): number { return this.cost; }
  get(key: string): RichLine[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.lines.map(line => line.map(span => ({ ...span })));
  }
  set(key: string, lines: readonly RichLine[]): void {
    const previous = this.entries.get(key);
    if (previous) { this.cost -= previous.cost; this.entries.delete(key); }
    const cost = key.length * 2 + lines.reduce((sum, line) =>
      sum + 32 + line.reduce((n, span) => n + span.text.length * 2 + 96, 0), 0);
    if (cost > this.maxCost || this.maxEntries < 1) return;
    while (this.entries.size >= this.maxEntries || this.cost + cost > this.maxCost) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]); this.cost -= oldest[1].cost;
    }
    this.entries.set(key, { lines: lines.map(line => line.map(span => ({ ...span }))), cost });
    this.cost += cost;
  }
}
