import { describe, expect, it } from "vitest";

import {
  type ApprovalMode,
  COMMAND_APPROVAL_WARNING,
  shouldAutoApprove,
} from "../../src/cli/approval-policy";
import {
  type ApprovalRequest,
  type Permission,
  parseSessionId,
} from "../../src/shared/schemas";

const baseRequest: ApprovalRequest = {
  id: "20000000-0000-4000-8000-000000000001",
  sessionId: parseSessionId("10000000-0000-4000-8000-000000000001"),
  toolCallId: "tool-call-1",
  toolName: "run_command",
  description: "Run a focused test",
  command: ["pnpm", "vitest", "run", "tests/cli/approval-policy.test.ts"],
};

const request = (
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest => ({
  ...baseRequest,
  ...overrides,
});

describe("CLI approval policy", () => {
  it.each(["workspace", "unrestricted"] satisfies Permission[])(
    "auto-approves run_command with argv for %s permission in auto mode",
    (permission) => {
      expect(
        shouldAutoApprove(
          "auto",
          permission,
          request(),
          new AbortController().signal,
        ),
      ).toBe(true);
    },
  );

  it.each(["ask", "auto"] satisfies ApprovalMode[])(
    "does not auto-approve readonly permission in %s mode",
    (mode) => {
      expect(
        shouldAutoApprove(
          "ask",
          "readonly",
          request(),
          new AbortController().signal,
        ),
      ).toBe(false);
      expect(
        shouldAutoApprove(
          mode,
          "readonly",
          request(),
          new AbortController().signal,
        ),
      ).toBe(false);
    },
  );

  it("requires explicit auto mode", () => {
    expect(
      shouldAutoApprove(
        "ask",
        "workspace",
        request(),
        new AbortController().signal,
      ),
    ).toBe(false);
  });

  it("does not auto-approve after abort", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      shouldAutoApprove("auto", "workspace", request(), controller.signal),
    ).toBe(false);
  });

  it.each([
    ["MCP tool", "mcp_call_tool"],
    ["browser tool", "browser_open"],
    ["filesystem tool", "read_file"],
  ] as const)("never auto-approves %s requests", (_label, toolName) => {
    expect(
      shouldAutoApprove(
        "auto",
        "workspace",
        request({ toolName, command: ["echo", "ignored"] }),
        new AbortController().signal,
      ),
    ).toBe(false);
  });

  it.each([undefined, []] as const)(
    "requires run_command argv to be present and non-empty: %s",
    (command) => {
      expect(
        shouldAutoApprove(
          "auto",
          "workspace",
          request({ command }),
          new AbortController().signal,
        ),
      ).toBe(false);
    },
  );

  it("exports a command approval warning that explains the session-wide risk", () => {
    expect(COMMAND_APPROVAL_WARNING).toContain("not sandboxed");
    expect(COMMAND_APPROVAL_WARNING).toContain("outside the workspace");
    expect(COMMAND_APPROVAL_WARNING).toContain("network");
    expect(COMMAND_APPROVAL_WARNING).toContain("this session");
    expect(COMMAND_APPROVAL_WARNING).toContain("automatically");
  });
});
