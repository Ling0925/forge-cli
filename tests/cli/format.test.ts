import { describe, expect, it } from "vitest";
import {
  formatApprovalCard,
  formatBanner,
  formatModels,
  formatPlan,
  formatSessions,
  renderMarkdown,
  terminalText,
} from "../../src/cli/format";
import {
  createTheme,
  graphemeWidth,
  stringWidth,
  truncate,
} from "../../src/cli/theme";
import { type TaskPlan, parseSessionId } from "../../src/shared/schemas";

describe("Theme utilities", () => {
  it("calculates string width for ASCII, CJK, and emoji", () => {
    expect(stringWidth("hello")).toBe(5);
    expect(stringWidth("你好")).toBe(4);
    // Standard emoji with ZWJ sequence (e.g. 👨‍💻)
    expect(stringWidth("👨‍💻")).toBe(2);
  });

  it("graphemeWidth handles single and multi-codepoint graphemes", () => {
    expect(graphemeWidth("a")).toBe(1);
    expect(graphemeWidth("中")).toBe(2);
    expect(graphemeWidth("👨‍👩‍👦")).toBe(2);
  });

  it("truncates plain text cleanly with ellipsis", () => {
    expect(truncate("hello world", 6)).toBe("hello…");
    expect(truncate("你好世界", 5)).toBe("你好…");
  });

  it("truncates ANSI styled strings without breaking escape codes", () => {
    const theme = createTheme({ forceColor: true });
    const styled = theme.green("hello world");
    const result = truncate(styled, 6);
    expect(terminalText(result)).toBe("hello…");
  });
});

describe("Formatters", () => {
  const theme = createTheme({ forceColor: false });

  it("strips terminal controls and C1 characters safely", () => {
    const tainted = "\u001b[31mRed\u001b[0m\u0007\u0000Text";
    expect(terminalText(tainted)).toBe("RedText");
  });

  it("renders banner cleanly without heavy boxes", () => {
    const banner = formatBanner(
      {
        workspace: "/home/user/project",
        model: "gpt-4o",
        permission: "workspace",
        mode: "build",
        version: "0.1.0",
      },
      theme,
    );
    expect(banner).toContain("Forge");
    expect(banner).toContain("v0.1.0");
    expect(banner).toContain("工作区审批");
    expect(banner).toContain("gpt-4o");
    expect(banner).not.toContain("┌");
  });

  it("renders sessions list with alignment", () => {
    const output = formatSessions(
      [
        {
          version: 1,
          id: parseSessionId("10000000-0000-4000-8000-000000000001"),
          workspace: "/test",
          model: "gpt-4o",
          createdAt: "2026-10-13T12:00:00Z",
          updatedAt: "2026-10-13T12:30:00Z",
          status: "completed",
          title: "Setup build",
        },
      ],
      "10000000-0000-4000-8000-000000000001",
      theme,
    );
    expect(output).toContain("会话 (1)");
    expect(output).toContain("completed");
    expect(output).toContain("10000000");
    expect(output).toContain("Setup build");
    expect(output).toContain("•"); // active marker
  });

  it("renders models list", () => {
    const output = formatModels(["gpt-4o", "claude-3-5"], "gpt-4o", theme);
    expect(output).toContain("Available Models");
    expect(output).toContain("* gpt-4o (active)");
    expect(output).toContain("claude-3-5");
  });

  it("renders execution plan with statuses", () => {
    const plan: TaskPlan = {
      explanation: "Deploy service",
      steps: [
        { step: "Build binary", status: "completed" },
        { step: "Run tests", status: "in_progress" },
        { step: "Deploy", status: "pending" },
      ],
    };
    const output = formatPlan(plan, theme);
    expect(output).toContain("Execution Plan");
    expect(output).toContain("Deploy service");
    expect(output).toContain("✔ 1. Build binary [done]");
    expect(output).toContain("● 2. Run tests [active]");
    expect(output).toContain("○ 3. Deploy [pending]");
  });

  it("renders approval card with command and child details", () => {
    const output = formatApprovalCard(
      {
        id: "req1",
        sessionId: parseSessionId("10000000-0000-4000-8000-000000000001"),
        childSessionId: parseSessionId("10000000-0000-4000-8000-000000000099"),
        toolCallId: "call1",
        toolName: "run_command",
        description: "Execute bash command",
        command: ["npm", "test"],
      },
      "/home/workspace",
      theme,
    );
    expect(output).toContain(
      "Approval required: run_command (child 10000000-0000-4000-8000-000000000099)",
    );
    expect(output).toContain("Workspace:");
    expect(output).toContain("Execute bash command");
    expect(output).toContain("npm test");
    expect(output).not.toContain('["npm","test"]');
    expect(output).toContain("Approve? [Y/n]");
  });

  it("renders markdown without box-drawing walls", () => {
    const md = "# Title\n## Section\n- item 1\n```ts\nconst x = 1;\n```";
    const output = renderMarkdown(md, theme);
    expect(output).toContain("# Title");
    expect(output).toContain("## Section");
    expect(output).toContain("* item 1");
    expect(output).toContain("const x = 1;");
    expect(output).not.toContain("┌");
  });
});

describe("renderer security and emoji regressions", () => {
  it("counts flag and keycap as two cells and removes OSC links before truncation", () => {
    expect(stringWidth("🇨🇳1️⃣")).toBe(4);
    const linked = "\u001b]8;;https://example.test\u0007abcdef\u001b]8;;\u0007";
    expect(truncate(linked, 4)).toBe("abc…");
    expect(terminalText(linked)).toBe("abcdef");
  });
  it("sanitizes dynamic fields before trusted styling", () => {
    const theme = createTheme({ forceColor: true });
    const out = formatModels(["evil\u001b[2J"], "evil", theme);
    expect(out).not.toContain("\u001b[2J");
    expect(out).toContain("evil");
  });
});
