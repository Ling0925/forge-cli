import { describe, expect, it } from "vitest";

import {
  type ApprovalMode,
  COMMAND_APPROVAL_WARNING,
  shouldAutoApprove, DEFAULT_APPROVAL_MODE, parseApprovalMode, parseApprovalAnswer, approvalAudit,
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

it("normalizes manual/ask and defaults to full access", () => {
  expect(DEFAULT_APPROVAL_MODE).toBe("full-access");
  expect(parseApprovalMode("ask")).toBe("manual");
  for (const mode of ["full-access", "manual", "auto"]) expect(parseApprovalMode(mode)).toBe(mode);
  expect(() => parseApprovalMode("yes")).toThrow();
});
it("full access covers all eligible tool and child requests but never readonly or abort", () => {
  for (const toolName of ["run_command", "mcp_call_tool", "browser_open", "write_file"]) {
    for (const childSessionId of [undefined, baseRequest.sessionId]) {
      const req = request({toolName, childSessionId, command: undefined});
      expect(shouldAutoApprove("full-access", "workspace", req, new AbortController().signal)).toBe(true);
      expect(shouldAutoApprove("full-access", "readonly", req, new AbortController().signal)).toBe(false);
      expect(shouldAutoApprove("full-access", "workspace", req, AbortSignal.abort())).toBe(false);
      expect(shouldAutoApprove("manual", "workspace", req, new AbortController().signal)).toBe(false);
    }
  }
});
it("accepts only an exact empty answer or affirmative text", () => {
  for (const answer of ["", "y", "Y", "yes", " YES "]) expect(parseApprovalAnswer(answer)).toBe(true);
  for (const answer of ["n", "no", "maybe", " ", "\t"]) expect(parseApprovalAnswer(answer)).toBe(false);
});
it("audit masks common argv secrets without losing tool provenance", () => {
  const audit = approvalAudit(request({command: ["node", "--token", "private123", "password=hidden456", "Bearer secret789"]}));
  expect(audit).toContain("run_command"); expect(audit).toContain("node");
  expect(audit).not.toMatch(/private123|hidden456|secret789/);
});
