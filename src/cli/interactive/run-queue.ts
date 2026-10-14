import { ForgeError } from "../../shared/errors";
import { runInputSchema } from "../../shared/schemas";
import { terminalText } from "../format";
import { DEFAULT_MAX_QUEUE_BYTES, DEFAULT_MAX_QUEUE_LINES } from "../terminal";

type PendingMessage = Readonly<{ kind: "follow-up" | "steer"; text: string }>;

/** Session-local pending input, separate from the terminal's consent channel. */
export class RunQueue {
  private items: PendingMessage[] = [];
  private bytes = 0;
  paused = false;

  get length(): number { return this.items.length; }
  get steeringCount(): number { return this.items.filter(item => item.kind === "steer").length; }

  add(kind: PendingMessage["kind"], raw: string): void {
    const text = runInputSchema.unwrap().shape.prompt.parse(terminalText(raw));
    const size = Buffer.byteLength(text);
    if (this.items.length >= DEFAULT_MAX_QUEUE_LINES || this.bytes + size > DEFAULT_MAX_QUEUE_BYTES)
      throw new ForgeError("invalid_input", "Queue limit exceeded (1,000 messages / 1,000,000 bytes). Message rejected; earlier messages retained.");
    this.items.push({ kind, text });
    this.bytes += size;
  }

  drainSteering(): string[] {
    const selected = this.items.filter(item => item.kind === "steer");
    this.items = this.items.filter(item => item.kind !== "steer");
    this.bytes -= selected.reduce((total, item) => total + Buffer.byteLength(item.text), 0);
    return selected.map(item => item.text);
  }

  take(): string | undefined {
    if (this.paused) return undefined;
    const item = this.items.shift();
    if (item) this.bytes -= Buffer.byteLength(item.text);
    return item?.text;
  }

  /** Unconsumed steering is retained as a follow-up, never attached to a later run silently. */
  finish(completed: boolean): void {
    const unconsumed = this.steeringCount > 0;
    this.items = this.items.map(item => ({ ...item, kind: "follow-up" }));
    this.paused = this.paused || !completed || unconsumed;
  }

  clear(): void { this.items = []; this.bytes = 0; this.paused = false; }

  /** Bounded persistent previews, independent of transcript output. */
  preview(): string[] {
    const lines: string[] = [];
    for (const kind of ["steer", "follow-up"] as const) {
      const items = this.items.filter(item => item.kind === kind);
      if (!items.length) continue;
      const preview = items[0]!.text.replaceAll("\n", " ↵ ").slice(0, 200);
      const label = kind === "steer" ? "Steer" : "Queue";
      const state = kind === "steer" ? " · waiting" : this.paused ? " · paused" : " · next turn";
      lines.push(`${label} (${items.length})${state}: ${preview}${items[0]!.text.length > 200 ? "…" : ""}`);
    }
    return lines;
  }

  describe(): string {
    if (!this.length) return "Queue empty.\n";
    const previews = this.items.slice(0, 20).map((item, index) => {
      const text = item.text.replaceAll("\n", " ↵ ");
      return `${index + 1}. [${item.kind}] ${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`;
    });
    if (this.length > previews.length) previews.push(`… ${this.length - previews.length} more messages`);
    return `Queue: ${this.length}${this.paused ? " (paused; /queue run to continue)" : ""}\n${previews.join("\n")}\n`;
  }
}
