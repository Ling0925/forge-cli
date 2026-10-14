import { ForgeError } from "../shared/errors";
import type { ApprovalRequest, Permission } from "../shared/schemas";

export type ApprovalMode = "ask" | "auto";

export const parseApprovalMode = (value: string): ApprovalMode => {
  if (value !== "ask" && value !== "auto")
    throw new ForgeError("invalid_input", "Expected approval mode ask or auto.");
  return value;
};

export const COMMAND_APPROVAL_WARNING =
  "Commands are not sandboxed: they can access files outside the workspace and the network. In auto mode, eligible command approvals will be granted automatically for this session.";

export const shouldAutoApprove = (
  mode: ApprovalMode,
  permission: Permission,
  request: ApprovalRequest,
  signal: AbortSignal,
): boolean =>
  mode === "auto" &&
  (permission === "workspace" || permission === "unrestricted") &&
  !signal.aborted &&
  !request.childSessionId &&
  request.toolName === "run_command" &&
  request.command !== undefined &&
  request.command.length > 0;
