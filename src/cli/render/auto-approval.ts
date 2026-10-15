import type { ApprovalRequest } from "../../shared/schemas";
import { approvalAuditArguments } from "../approval-policy";
import type { RichLine } from "../ui-contract";
import { sanitizeText } from "./sanitize";
import { truncate } from "./width";

/** Approval is permission to attempt a tool, not a successful tool result. */
export function autoApprovalLines(request: ApprovalRequest, columns = 80): readonly RichLine[] {
  const width = Math.max(1, columns);
  const clean = (value: string) => sanitizeText(value).replace(/\s+/g, " ").trim();
  // This is a display preview, never a shell command to replay. Quote argument
  // boundaries where needed without printing a JSON array or raw description.
  const argv = approvalAuditArguments(request).map(arg => {
    const value = clean(arg);
    return !value || /[\s"'\\]/.test(value) ? `'${value.replaceAll("'", "'\\''")}'` : value;
  }).join(" ");
  return [
    [{ text: truncate(`Auto-approved · ${clean(request.toolName)}`, width), tone: "warning" }],
    ...(request.childSessionId ? [[{ text: truncate(`  │ child ${clean(request.childSessionId)}`, width), tone: "muted" as const }]] : []),
    ...(argv ? [[{ text: truncate(`  ╰ ${argv}`, width), tone: "muted" as const }]] : []),
  ];
}
