import { ForgeError } from "../shared/errors";
import { redactCommandArguments } from "../shared/tool-activity";
import type { ApprovalRequest, Permission } from "../shared/schemas";

export type ApprovalMode = "full-access" | "manual" | "auto" | "ask";
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "full-access";

export const parseApprovalMode = (value: string): ApprovalMode => {
  if (value === "ask") return "manual";
  if (value !== "manual" && value !== "auto" && value !== "full-access")
    throw new ForgeError("invalid_input", "Expected approval mode full-access, auto or manual (ask is an alias).");
  return value;
};

export const COMMAND_APPROVAL_WARNING =
  "Commands are not sandboxed: they can access files outside the workspace and the network. In auto mode, eligible command approvals will be granted automatically for this session.";
export const approvalWarning = (mode: ApprovalMode): string => mode === "full-access"
  ? "FULL ACCESS: tool approval requests (including MCP, browser and child requests) will be granted automatically for this session, within existing permissions. Commands are not sandboxed: they can access files outside the workspace and the network. Use /approval manual for per-request confirmation."
  : mode === "auto" ? COMMAND_APPROVAL_WARNING
  : "MANUAL: each approval asks Approve? [Y/n]. A fresh Enter approves; n/no or Esc denies. Commands are not sandboxed and can access external files and the network.";

/** Only call after obtaining a fresh, untainted answer; empty is a real Enter. */
export const parseApprovalAnswer = (answer: string): boolean =>
  answer === "" || /^(y|yes)$/i.test(answer.trim());

export const shouldAutoApprove = (
  mode: ApprovalMode,
  permission: Permission,
  request: ApprovalRequest,
  signal: AbortSignal,
): boolean =>
  (permission === "workspace" || permission === "unrestricted") &&
  !signal.aborted &&
  (mode === "full-access" || (
    mode === "auto" &&
    !request.childSessionId &&
    request.toolName === "run_command" &&
    request.command !== undefined &&
    request.command.length > 0
  ));

/** Tool registries reject known configured secrets; additionally mask common CLI secrets. */
export const approvalAuditArguments = (request: ApprovalRequest): readonly string[] =>
  redactCommandArguments(request.command);
