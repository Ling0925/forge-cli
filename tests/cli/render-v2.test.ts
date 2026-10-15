import { describe, expect, it } from "vitest";
import {
  approvalLines,
  bannerLines,
  helpLines,
  renderRichLine,
  wrapRichLines,
} from "../../src/cli/format";
import { LiveRun } from "../../src/cli/live-run";
import { diffLines } from "../../src/cli/render/diff";
import { createEventRenderer } from "../../src/cli/render/events";
import { MarkdownStream } from "../../src/cli/render/markdown";
import { plainLines } from "../../src/cli/render/rich";
import { ControlFilter } from "../../src/cli/render/sanitize";
import { ToolTranscript } from "../../src/cli/render/tool-transcript";
import {
  compactToolLine,
  toolArgumentLines,
  toolFinishLines,
  toolStartLine,
} from "../../src/cli/render/tools";
import { createTheme, resolveTheme, stringWidth } from "../../src/cli/theme";
import type { TerminalUI } from "../../src/cli/ui-contract";
import type {
  AgentEvent,
  FileChange,
  ToolCall,
  ToolResult,
} from "../../src/shared/schemas";
import { parseSessionId } from "../../src/shared/schemas";

const theme = resolveTheme({
  setting: "dark",
  background: "dark",
  colorDepth: 24,
  noColor: false,
  dumb: false,
});

const textOf = (lines: readonly (readonly { text: string }[])[]): string =>
  lines.map((line) => line.map((span) => span.text).join("")).join("\n");

const call = (id: string, name: string, args: string): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

describe("rich lines", () => {
  it("sanitizes OSC before styling and wraps graphemes", () => {
    const rendered = renderRichLine(
      [{ text: "\u001b]0;title\u0007中文" }],
      theme,
    );
    expect(rendered).not.toContain("]0;");
    expect(rendered).toContain("中文");
    const wrapped = wrapRichLines([[{ text: "中文ab", tone: "accent" }]], 3);
    expect(textOf(wrapped)).toBe("中\n文a\nb");
    expect(plainLines("a\nb\n")).toEqual([[{ text: "a" }], [{ text: "b" }]]);
  });

  it("keeps the banner within four lines and shares command metadata", () => {
    const banner = bannerLines(
      {
        version: "2",
        model: "org/model",
        workspace: "/work",
        permission: "workspace",
        mode: "exec",
      },
      80,
    );
    expect(banner.length).toBeLessThanOrEqual(4);
    expect(banner[0]?.[0]).toMatchObject({ text: "Forge", bold: true });
    expect(banner[0]?.slice(1).every((item) => item.bold !== true)).toBe(true);
    expect(textOf(banner)).toContain("v2");
    expect(textOf(banner)).toContain("/ 命令");
    expect(textOf(banner)).toContain("/help 帮助");
    expect(textOf(banner)).not.toMatch(/token|cost|\\$\\d/i);
    expect(textOf(helpLines(40))).toContain("/help");
  });

  it("aligns CJK help at 80 and 120 and wraps long syntax at 40", () => {
    const lineWidth = (line: readonly { text: string }[]): number =>
      line.reduce((sum, item) => sum + stringWidth(item.text), 0);
    for (const width of [80, 120]) {
      const lines = helpLines(width);
      expect(Math.max(...lines.map(lineWidth))).toBeLessThanOrEqual(width);
      const model = lines.find((line) => line[0]?.text.startsWith("/model "));
      expect(model?.[0]?.text.trimEnd()).toBe("/model [id]");
      expect(model?.[1]?.text).toContain("无参数选择模型");
      const resume = lines.find((line) => line[0]?.text.startsWith("/resume "));
      expect(resume?.[1]?.text).toContain("选择会话恢复");
      const help = lines.find((line) => line[0]?.text.startsWith("/help"));
      expect(stringWidth(model?.[0]?.text ?? "")).toBe(
        stringWidth(help?.[0]?.text ?? ""),
      );
      expect(model?.[1]?.text.startsWith("  ")).toBe(true);
      const permission = textOf(lines);
      expect(permission).toContain(
        "/permission [readonly|workspace|unrestricted]",
      );
      expect(permission).toContain("查看或更改权限");
    }

    const narrow = helpLines(40);
    const descriptionWidth = (line: readonly { text: string }[]): number =>
      line[0]?.text.trim() === "" ? lineWidth(line) : 0;
    expect(Math.max(0, ...narrow.map(descriptionWidth))).toBeLessThanOrEqual(
      40,
    );
    const permissionIndex = narrow.findIndex(
      (line) =>
        line[0]?.text === "/permission [readonly|workspace|unrestricted]",
    );
    expect(permissionIndex).toBeGreaterThanOrEqual(0);
    expect(narrow[permissionIndex]).toHaveLength(1);
    expect(textOf([narrow[permissionIndex + 1] ?? []]).trim()).toBe(
      "查看或更改权限",
    );
    expect(textOf(narrow).replaceAll("\n", "")).toContain(
      "[list|register|enable|disable|remove|health]",
    );
    expect(textOf(narrow)).toContain("/resume [uuid]");
  });
});

describe("streaming markdown", () => {
  it("finalizes a fence split across deltas without losing text", () => {
    const stream = new MarkdownStream();
    const first = stream.push("```ts\nconst ");
    expect(first.append).toEqual([]);
    expect(textOf(first.tail)).toContain("const");
    const second = stream.push("value\n```\n# Title");
    expect(textOf(second.tail)).toContain("const value");
    const done = stream.finish();
    const all = `${textOf(first.append)}\n${textOf(second.append)}\n${textOf(done.append)}`;
    expect(all).toContain("# Title");
    expect(all.match(/const value/g)).toHaveLength(1);
  });

  it("drops split OSC and CR controls", () => {
    const filter = new ControlFilter();
    expect(filter.push("ok\u001b]8;;")).toBe("ok");
    expect(filter.push("http://x\u0007next\r")).toBe("next");
    expect(filter.finish()).toBe("");
  });
});

describe("tools and diffs", () => {
  it("tracks one tool line and parses the real exit envelope", () => {
    const renderer = createEventRenderer({ now: () => 10 });
    const started = renderer.push({
      type: "tool_started",
      call: call(
        "1",
        "run_command",
        JSON.stringify({ command: ["ls", "src"] }),
      ),
    } as AgentEvent);
    expect(started.append).toEqual([]);
    expect(textOf(started.tail)).toContain("run_command");
    expect(textOf(started.tail)).toContain("running");
    expect(started.tail[0]?.[0]?.animation).toBe("spinner");
    const result: ToolResult = {
      content: JSON.stringify({
        stdout: "a\nb\nc\nd\ne\n",
        stderr: "",
        exit_code: 2,
      }),
      isError: true,
    };
    const finished = toolFinishLines(
      call("1", "run_command", '{"command":["ls"]}'),
      result,
    );
    const body = textOf(finished);
    expect(body).toContain("exit 2");
    expect(body).not.toContain("more lines");
    expect(
      body.split("\n").filter((line) => /^stdout [abcde]$/.test(line)),
    ).toHaveLength(5);
  });

  it("shows bounded arguments and more structured matches", () => {
    const args = textOf(toolArgumentLines(call("x", "run_command", JSON.stringify({
      argv: ["node", "script.mjs"], cwd: "repo", note: "safe",
    })), 80));
    expect(args).toContain('argv: ["node","script.mjs"]');
    expect(args).toContain("cwd: repo");
    const matches = toolFinishLines(call("x", "search_files", '{"query":"needle"}'), {
      content: JSON.stringify({ matches: Array.from({ length: 15 }, (_, i) => ({
        path: `file-${i}.ts`, line: i + 1, excerpt: `hit-${i}`,
      })) }),
      isError: false,
    }, 80);
    const preview = textOf(matches);
    expect(preview).toContain("file-10.ts:11 hit-10");
    expect(preview).not.toContain("file-14.ts");
    expect(matches.length).toBeLessThanOrEqual(20);
  });

  it("indexes tool summaries and expands bounded details without rerunning", () => {
    const tools = new ToolTranscript();
    const command = call("cmd", "run_command", JSON.stringify({ argv: ["echo"], note: "private-text" }));
    expect(tools.start(command)).toBe(1);
    expect(tools.start(command)).toBe(1);
    const result = { content: JSON.stringify({ stdout: "first\nsecond", exit_code: 0 }), isError: false };
    const summary = textOf(tools.summary(command.id, result, 80));
    expect(summary).toContain("#1");
    expect(summary).toContain("first");
    expect(summary).not.toContain("second");
    expect(summary).not.toContain("private-text");
    expect(textOf(tools.list(80))).toContain("#1");
    const detail = textOf(tools.detail(1, 80));
    expect(detail).toContain("private-text");
    expect(detail).toContain("second");
    expect(textOf(tools.detail(2, 80))).toContain("No tool #2");
    const renderer = createEventRenderer({ tools });
    const next = call("next", "read_file", '{"path":"next.txt"}');
    expect(textOf(renderer.push({ type: "tool_started", call: next } as AgentEvent).tail)).toContain("read_file");
    expect(textOf(renderer.push({ type: "tool_finished", toolCallId: next.id, result } as AgentEvent).append)).toContain("#2");
  });

  it("bounds a real unified diff and does not invent missing content", () => {
    const before = Array.from(
      { length: 30 },
      (_, index) => `old ${index}`,
    ).join("\n");
    const after = Array.from({ length: 30 }, (_, index) => `new ${index}`).join(
      "\n",
    );
    const change: FileChange = {
      path: "src/a.ts",
      kind: "modified",
      before,
      after,
      truncated: false,
    };
    const lines = diffLines(change);
    expect(lines.length).toBeLessThanOrEqual(25);
    expect(textOf(lines)).toContain("-old 0");
    expect(textOf(lines)).toContain("+new 0");
    const missing = diffLines({ ...change, before: null, kind: "modified" });
    expect(textOf(missing)).toContain("unavailable");
    expect(textOf(missing)).not.toContain("-old");
  });

  it("shows created and deleted content instead of calling it unknown", () => {
    const created = diffLines({
      path: "src/new.ts",
      kind: "created",
      before: null,
      after: "export const ready = true;\n",
      truncated: false,
    });
    const createdText = textOf(created);
    expect(createdText).toContain("+export const ready = true;");
    expect(createdText).not.toContain("unavailable");
    expect(createdText).toContain("@@ -0,0 +1,1 @@");

    const deleted = diffLines({
      path: "src/old.ts",
      kind: "deleted",
      before: "export const gone = true;",
      after: null,
      truncated: false,
    });
    expect(textOf(deleted)).toContain("-export const gone = true;");
    expect(textOf(deleted)).toContain("@@ -1,1 +0,0 @@");
  });

  it("keeps a late insertion visible with nearby context", () => {
    const before = Array.from({ length: 120 }, (_, index) => `line ${index}`);
    const after = [
      ...before.slice(0, 100),
      "inserted change",
      ...before.slice(100),
    ];
    const lines = diffLines({
      path: "src/late.ts",
      kind: "modified",
      before: before.join("\n"),
      after: after.join("\n"),
      truncated: false,
    });
    const body = textOf(lines);
    expect(body).toContain("+inserted change");
    expect(body).toContain(" line 99");
    expect(body).toContain(" line 100");
    expect(body).not.toContain(" line 0");
    expect(body).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(lines.length).toBeLessThanOrEqual(25);
  });

  it("previews read_file content and bounds a long physical row", () => {
    const read = toolFinishLines(
      call("r", "read_file", JSON.stringify({ path: "src/a.ts" })),
      {
        content: JSON.stringify({
          path: "src/a.ts",
          content: "alpha\nbeta\ngamma\ndelta\nepsilon",
          offset: 0,
          next_offset: null,
          total_lines: 5,
          truncated: false,
          partial_line: false,
          cache_hit: false,
        }),
        isError: false,
      },
      80,
    );
    const readText = textOf(read);
    expect(readText).toContain("alpha");
    expect(readText).not.toContain('\\"content\\"');
    expect(readText).toContain("5 lines");

    const wide = "x".repeat(400);
    const narrow = toolFinishLines(
      call("c", "run_command", JSON.stringify({ argv: ["echo"] })),
      {
        content: JSON.stringify({
          stdout: `${wide}\n${wide}\n${wide}\n${wide}`,
          stderr: "warn",
          exit_code: 0,
        }),
        isError: false,
      },
      40,
    );
    expect(narrow.length).toBeLessThan(30);
    expect(textOf(narrow)).toContain("stdout");
    expect(textOf(narrow)).toContain("stderr warn");
    expect(textOf(narrow)).toContain("exit 0");
    expect(textOf(narrow)).toMatch(/more preview lines|more lines/);
  });

  it("wraps tool rows and tails to 40 and 120 columns", () => {
    for (const width of [40, 120]) {
      const renderer = createEventRenderer({
        width: () => width,
        now: () => 1,
      });
      const update = renderer.push({
        type: "text_delta",
        text: `${"word ".repeat(80)}\n`,
      } as AgentEvent);
      const longest = Math.max(
        ...[...update.append, ...update.tail].map((line) =>
          line.reduce((sum, item) => sum + item.text.length, 0),
        ),
        0,
      );
      expect(longest).toBeLessThanOrEqual(width);
      const started = renderer.push({
        type: "tool_started",
        call: call("t", "read_file", JSON.stringify({ path: "p".repeat(200) })),
      } as AgentEvent);
      const toolWidth = Math.max(
        ...started.tail.map((line) =>
          line.reduce((sum, item) => sum + item.text.length, 0),
        ),
      );
      expect(toolWidth).toBeLessThanOrEqual(width);
    }
  });
});

describe("approval context", () => {
  it("keeps a long command and description by wrapping", () => {
    const description =
      "Execute argv in workspace cwd src/deep and report the full action without hiding the trailing directory.";
    const command = ["npm", "test", "--", "tests/cli/render-v2.test.ts"];
    const lines = approvalLines(
      {
        id: "10000000-0000-4000-8000-000000000010",
        sessionId: parseSessionId("10000000-0000-4000-8000-000000000001"),
        toolCallId: "call-approve",
        toolName: "run_command",
        description,
        command,
      },
      36,
      "/home/workspace",
    );
    const body = textOf(lines)
      .replaceAll("\u001b[7m", "")
      .replaceAll("\u001b[27m", "");
    expect(body).toContain("Workspace:");
    expect(body).toContain("/home/workspace");
    expect(body.replaceAll("\n", "")).toContain(description);
    expect(body.replaceAll("\n", "")).toContain(command.join(" "));
    expect(body).toContain("Approve? [Y/n]");
    expect(lines.length).toBeGreaterThan(4);
    expect(
      Math.max(
        ...lines.map((line) =>
          line.reduce((sum, item) => sum + stringWidth(item.text), 0),
        ),
      ),
    ).toBeLessThanOrEqual(36);
  });

  it("shows the embedded command once and keeps cwd and child context", () => {
    const command = [
      "node",
      "-e",
      "require(\"node:fs\").appendFileSync('qa-审批','中文')",
    ];
    const description = `Execute argv ${JSON.stringify(command)} in workspace cwd ".". This is not an OS sandbox.`;
    const child = "10000000-0000-4000-8000-000000000099";
    const lines = approvalLines(
      {
        id: "10000000-0000-4000-8000-000000000010",
        sessionId: parseSessionId("10000000-0000-4000-8000-000000000001"),
        toolCallId: "call-approve",
        toolName: "run_command\u001b[31m",
        description,
        command,
        childSessionId: parseSessionId(child),
      },
      40,
    );
    const flat = textOf(lines).replaceAll("\n", "");
    expect(flat).toContain("Approval required");
    expect(flat).toContain("run_command");
    expect(flat).not.toContain("\u001b");
    expect(flat).toContain("Execute the command below");
    expect(flat).toContain('in workspace cwd "."');
    expect(flat).toContain("This is not an OS sandbox.");
    expect(flat).not.toContain(JSON.stringify(command));
    expect(flat.match(/Command:/g)).toHaveLength(1);
    expect(flat.indexOf("node -e")).toBe(flat.lastIndexOf("node -e"));
    expect(flat).toContain("-e");
    expect(flat).toContain("qa-审批");
    expect(flat).toContain("中文");
    expect(flat).toContain(`child ${child}`);
    expect(flat).toContain("Approve? [Y/n]");
    expect(
      Math.max(
        ...lines.map((line) =>
          line.reduce((sum, item) => sum + stringWidth(item.text), 0),
        ),
      ),
    ).toBeLessThanOrEqual(40);
  });
});

describe("compact tool header", () => {
  const longCall = (argv: readonly string[]) =>
    call("1", "run_command", JSON.stringify({ argv }));

  it("keeps status and exit on one row at 40, 80, and 120", () => {
    const argv = [
      "/home/ling/.local/share/pi-node/node-v22.23.1-linux-x64/bin/node",
      "-e",
      'require("node:fs").appendFileSync("qa-approval-counter","x")',
    ];
    for (const width of [40, 80, 120]) {
      const started = toolStartLine(longCall(argv), width);
      const startText = textOf([started]);
      expect(startText.split("\n")).toHaveLength(1);
      expect(stringWidth(startText)).toBeLessThanOrEqual(width);
      expect(startText.startsWith("run_command ")).toBe(true);
      expect(startText.endsWith(" · running")).toBe(true);
      expect(startText).toContain("…");

      const finished = toolFinishLines(
        longCall(argv),
        {
          content: JSON.stringify({
            stdout: "",
            stderr: "",
            exit_code: 2,
          }),
          isError: true,
        },
        width,
      );
      const header = textOf(finished.slice(0, 1));
      expect(stringWidth(header)).toBeLessThanOrEqual(width);
      expect(header.startsWith("run_command ")).toBe(true);
      expect(header.endsWith(" · failed · exit 2")).toBe(true);
      expect(textOf(finished)).toContain("exit 2");
    }
  });

  it("ellipsizes a long CJK argv without hiding the exit", () => {
    const argv = ["npm", "测试".repeat(80), "--", "src/渲染.ts"];
    const finished = toolFinishLines(
      longCall(argv),
      {
        content: JSON.stringify({ stdout: "ok", stderr: "", exit_code: 7 }),
        isError: false,
      },
      40,
    );
    const header = textOf(finished.slice(0, 1));
    expect(stringWidth(header)).toBeLessThanOrEqual(40);
    expect(header.endsWith(" · failed · exit 7")).toBe(true);
    expect(header).toContain("…");
    expect(header).not.toContain("src/渲染.ts");
  });

  it("keeps the real suffix when a long name leaves no room for the target", () => {
    const huge = "x".repeat(3000);
    const suffix = " · failed · exit 3";
    const finished = toolFinishLines(
      call("2", "run_command", JSON.stringify({ argv: ["node", huge] })),
      {
        content: JSON.stringify({ stdout: "", stderr: "", exit_code: 3 }),
        isError: true,
      },
      20,
    );
    const narrow = textOf(finished.slice(0, 1));
    expect(narrow.split("\n")).toHaveLength(1);
    expect(stringWidth(narrow)).toBeLessThanOrEqual(20);
    expect(narrow.endsWith(suffix)).toBe(true);
    expect(narrow.startsWith("r…")).toBe(true);
    expect(narrow).not.toContain("run_command");
    expect(narrow).not.toContain(huge.slice(0, 8));

    const wideName = "mcp_very_long_server_tool_operation";
    const cjk = `路径${"测".repeat(30)}${huge}`;
    const crowded = textOf([
      compactToolLine(wideName, cjk, suffix, "error", 40),
    ]);
    expect(crowded.split("\n")).toHaveLength(1);
    expect(stringWidth(crowded)).toBeLessThanOrEqual(40);
    expect(crowded.endsWith(suffix)).toBe(true);
    expect(crowded.startsWith("mcp_")).toBe(true);
    expect(crowded).toContain("…");
    expect(crowded).not.toContain(wideName);
    expect(crowded).not.toContain("路径");
    expect(crowded).not.toContain(huge.slice(0, 8));

    const fitted = textOf([
      compactToolLine("run_command", cjk, " · running", "muted", 40),
    ]);
    expect(fitted.split("\n")).toHaveLength(1);
    expect(stringWidth(fitted)).toBeLessThanOrEqual(40);
    expect(fitted.startsWith("run_command ")).toBe(true);
    expect(fitted.endsWith(" · running")).toBe(true);
    expect(fitted).toContain("路径");
    expect(fitted).toContain("…");
    expect(fitted).not.toContain(huge.slice(0, 8));

    const emptyRoom = textOf([
      compactToolLine("run_command", huge, suffix, "error", 20),
    ]);
    expect(emptyRoom.split("\n")).toHaveLength(1);
    expect(stringWidth(emptyRoom)).toBeLessThanOrEqual(20);
    expect(emptyRoom.endsWith(suffix)).toBe(true);
    expect(emptyRoom).not.toContain(huge.slice(0, 4));

    const zero = textOf([
      compactToolLine(wideName, `中文${huge}`, suffix, "error", 1),
    ]);
    expect(zero.split("\n")).toHaveLength(1);
    expect(zero.endsWith(suffix)).toBe(true);
    expect(zero).not.toContain("中文");
    expect(zero).not.toContain(huge.slice(0, 4));
    expect(zero).not.toContain("exit 30");
  });
});

describe("live width", () => {
  it("asks the terminal for columns while a tail is streaming", () => {
    let columns = 40;
    const appended: string[] = [];
    const tails: string[] = [];
    const ui = {
      get columns() {
        return columns;
      },
      rows: 24,
      configure: async () => undefined,
      append: (lines: readonly { text: string }[][]) => {
        appended.push(textOf(lines));
      },
      setTail: (lines: readonly { text: string }[][]) => {
        tails.push(textOf(lines));
      },
      setStatus: () => undefined,
      setBusy: () => undefined,
      choose: async () => null,
      approve: async () => false,
      dispose: () => undefined,
    } as TerminalUI;
    const io = {
      isTTY: true,
      stdout: () => undefined,
      stderr: () => undefined,
      readStdin: async () => "",
      question: async () => "",
      onInterrupt: () => () => undefined,
      ui,
    };
    const run = new LiveRun(io, theme);
    run.event({
      type: "text_delta",
      text: `${"abcd ".repeat(30)}`,
    } as AgentEvent);
    columns = 120;
    run.event({ type: "text_delta", text: " more\n" } as AgentEvent);
    expect(
      tails
        .at(-1)
        ?.split("\n")
        .every((line) => line.length <= 120),
    ).toBe(true);
    expect(
      tails.at(-1)?.split("\n").some((line) => line.length > 40),
    ).toBe(true);
    const narrow = tails[0]?.split("\n") ?? [];
    expect(narrow.length).toBeGreaterThan(1);
    expect(narrow.every((line) => line.length <= 40)).toBe(true);
    run.dispose();
  });
});

describe("plain theme compatibility", () => {
  it("leaves disabled themes unstyled", () => {
    expect(
      renderRichLine(
        [{ text: "Forge", bold: true }],
        createTheme({ forceColor: false }),
      ),
    ).toBe("Forge");
  });
});
