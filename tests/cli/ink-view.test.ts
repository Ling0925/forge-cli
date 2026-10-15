import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { InkView } from "../../src/cli/ink/view";
import type { InkViewState } from "../../src/cli/ink/types";
import { emptyEditor, setText } from "../../src/cli/ink/input-editor";
import { initialInput, type InputState } from "../../src/cli/ink/input-state";
import { stripAnsi, visibleWidth } from "../../src/cli/theme";
import { measureContext } from "../../src/shared/context-usage";

const base: InkViewState = {
  columns: 80, rows: 24, tail: [], status: null, context: null, plan: null,
  mode: "build", theme: "dark", noColor: true, pendingInput: [], inputHint: null, now: 2000,
};
function frame(patch: Partial<InkViewState>, input: InputState = initialInput()): string {
  const state = { ...base, ...patch };
  const output = Object.assign(new PassThrough(), { columns: state.columns, rows: state.rows, isTTY: true });
  let latest = "";
  output.on("data", chunk => { const text = stripAnsi(chunk.toString()); if (text) latest = text; });
  const app = render(createElement(InkView, { state, input }), { stdout: output as unknown as NodeJS.WriteStream,
    stdin: new PassThrough() as unknown as NodeJS.ReadStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  const result = latest;
  app.unmount(); app.cleanup();
  return result;
}

describe("Ink view components", () => {
  it.each([[80, 24], [24, 8], [8, 4], [2, 2]])("bounds live output at %sx%s without losing the insertion point", (columns, rows) => {
    const output = frame({ columns, rows,
      tail: Array.from({ length: 100 }, (_, i) => [{ text: `tail-${i}` }]), pendingInput: ["queued message"],
      status: { label: "Thinking", startedAt: 0, toolCount: 2, cancellable: true },
    }, { ...initialInput(), composer: { ...setText(emptyEditor(), "中文👩‍💻ab\nnext"), cursor: 7 } });
    const lines = output.replace(/\n$/, "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(rows - 1);
    expect(lines.every(line => visibleWidth(line) <= Math.max(1, columns - 1))).toBe(true);
    expect(output).toContain("▏");
  });

  it("shows picker identity, selected detail, filtering hint and empty state", () => {
    const focus = { kind: "picker" as const, id: 1, editor: emptyEditor(), index: 0,
      spec: { title: "Resume session", placeholder: "Filter sessions",
        items: [{ value: "one", label: "Selected session", detail: "/workspace\nmodel/exact", active: true }] } };
    const output = frame({}, { ...initialInput(), focus });
    expect(output).toContain("Resume session");
    expect(output).toContain("Selected session");
    expect(output).toContain("/workspace");
    expect(output).toContain("Enter select");
    expect(frame({}, { ...initialInput(), focus: { ...focus, spec: { ...focus.spec, items: [] } } })).toContain("No matches");
  });

  it("renders plan, context, pending input and runtime usage without inventing observed metrics", () => {
    const output = frame({ context: { model: "exact-model", reasoningEffort: "high", sessionTitle: "Task", usage: measureContext([], 10000) },
      plan: { explanation: "Migrate TUI", steps: [{ step: "Implement", status: "in_progress" }] }, pendingInput: ["next request"],
      status: { label: "Thinking", startedAt: 0, toolCount: 3, cancellable: true, tokens: 123 },
    });
    expect(output).toContain("Plan 0/1");
    expect(output).toContain("exact-model");
    expect(output).toContain("next request");
    expect(output).toContain("0.1k tokens");
    expect(output).toContain("Ctrl+C cancel");
    const observing = frame({ status: { label: "会话仍在运行", startedAt: 0, toolCount: 0, cancellable: false, observing: true } });
    expect(observing).not.toMatch(/tokens|tools|cancel/);
  });

  it("mounts only fresh approval, not the saved composer or suggestions", () => {
    const input: InputState = { ...initialInput(), composer: setText(emptyEditor(), "saved secret draft"),
      prompt: "Approve? [Y/n] ", focus: { kind: "approval", editor: emptyEditor() } };
    const output = frame({ inputHint: "Enter queues" }, input);
    expect(output).toContain("Approve?");
    expect(output).not.toMatch(/Ask anything|Enter queues|saved secret draft/);
  });

  it("sanitizes untrusted history, picker and tail spans", () => {
    const bad = "safe\x1b]52;c;attack\x07\x1b[2J";
    const output = frame({ tail: [[{ text: bad }]] });
    expect(output).toContain("safe");
    expect(output).not.toContain("attack");
    expect(output).not.toContain("\x1b");
  });
});
