import type { AgentEvent, ApprovalRequest } from "../shared/schemas";
import type { CliIO } from "./cli";
import { createEventRenderer } from "./render/events";
import { renderRichLine } from "./render/rich";
import { ToolTranscript } from "./render/tool-transcript";
import { toolStartLine } from "./render/tools";
import type { Theme } from "./theme";
import type { TerminalUI } from "./ui-contract";

interface RichIO extends CliIO {
  readonly ui?: TerminalUI | undefined;
}

/** Maps run events to the terminal controller. It never writes cursor sequences. */
export class LiveRun {
  private readonly renderer: ReturnType<typeof createEventRenderer>;
  private readonly ui: TerminalUI | undefined;
  private readonly plain: boolean;
  constructor(
    private readonly io: RichIO,
    private readonly theme: Theme,
    tools: ToolTranscript = new ToolTranscript(),
  ) {
    this.renderer = createEventRenderer({ width: () => io.ui?.columns ?? 80, tools });
    this.ui = io.ui;
    this.plain =
      !io.isTTY ||
      process.env.NO_COLOR !== undefined ||
      process.env.TERM === "dumb";
  }

  private write(update: ReturnType<typeof this.renderer.push>): void {
    if (this.ui) {
      if (this.ui.update) {
        this.ui.update(update);
        return;
      }
      if (update.append.length) this.ui.append(update.append);
      this.ui.setTail(update.tail);
      if ("status" in update) this.ui.setStatus(update.status ?? null);
      return;
    }
    // Append-only sinks cannot replace tails: finalize them once at the next boundary.
    const lines = update.append;
    if (!lines.length) return;
    const text = lines
      .map((line) =>
        renderRichLine(
          line,
          this.plain
            ? { ...this.theme, enabled: false, tone: (value) => value }
            : this.theme,
        ),
      )
      .join("\n");
    this.io.stdout(`${text}\n`);
  }

  event(event: AgentEvent): void {
    this.write(this.renderer.push(event));
    if (!this.ui && event.type === "tool_started") {
      // Append-only terminals cannot repaint a tail. Emit immediate progress on
      // stderr, keeping stdout's final result single and free of cursor escapes.
      const line = toolStartLine(event.call).map((span) => span.text).join("");
      this.io.stderr(`${line}\n`);
    }
  }

  childApproval(request: ApprovalRequest): void {
    this.write(this.renderer.childApproval(request));
  }

  pause(): void {}

  resume(): void {}

  dispose(): void {
    this.write(this.renderer.finish());
  }
}
