import type { SessionSnapshot } from "../../shared/schemas";
import type { RichLine } from "../ui-contract";
import { markdownLines } from "./markdown";
import { wrapRichLines } from "./rich";
import { sanitizeText } from "./sanitize";
import { ToolTranscript } from "./tool-transcript";
import { toolStartLine } from "./tools";
import { savedToolResult } from "./tool-presentation";

/** Rebuild the transcript from messages, not events: older sessions may have no
 * text_delta events, and a tool result is persisted as a message even after a crash. */
export const historyLines = (session: SessionSnapshot, width: number, tools = new ToolTranscript()): readonly RichLine[] => {
  const lines: RichLine[] = [];
  const starts = new Map<string, number>();
  const finishes = new Map<string, number>();
  for (const event of session.events) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) continue;
    if (event.type === "tool_started" && !starts.has(event.call.id)) starts.set(event.call.id, time);
    if (event.type === "tool_finished" && !finishes.has(event.toolCallId)) finishes.set(event.toolCallId, time);
  }
  const messages = session.messages.filter((message) => message.role !== "system");
  const completed = new Set(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
  if (!messages.length) return lines;
  lines.push([{ text: `History · ${sanitizeText(session.title)}`, tone: "accent" }]);
  for (const message of messages) {
    if (message.role === "user") {
      lines.push([{ text: message.origin === "agent_reconciliation" ? "↳ Agent results" : "❯ You", tone: "accent" }]);
      lines.push(...markdownLines(message.content, width));
    } else if (message.role === "assistant") {
      if (message.content) {
        lines.push([{ text: "Forge", tone: "accent" }]);
        lines.push(...markdownLines(message.content, width));
      }
      for (const call of message.tool_calls ?? []) {
        tools.start(call, starts.get(call.id));
        // Do not show a redundant running line for a completed tool.
        if (!completed.has(call.id)) {
          lines.push(toolStartLine(call, width));
        }
      }
    } else {
      lines.push(...tools.summary(message.tool_call_id, savedToolResult(message.content), width, finishes.get(message.tool_call_id)));
    }
  }
  lines.push([{ text: "End of history", tone: "muted" }]);
  return wrapRichLines(lines, width);
};
