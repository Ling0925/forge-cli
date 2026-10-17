import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { expect, it } from "vitest";
import { InkView } from "../../src/cli/ink/view";
import { initialInput } from "../../src/cli/ink/input-state";
import { createEventRenderer } from "../../src/cli/render/events";
import { stripAnsi } from "../../src/cli/render/width";
import type { InkViewState } from "../../src/cli/ink/types";
import type { AgentEvent } from "../../src/shared/schemas";

it("paints preparing and running tools in real incremental Ink output before any result arrives", async () => {
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 24 });
  let bytes = "";
  output.on("data", chunk => { bytes += chunk.toString(); });
  const producer = createEventRenderer({ width: () => 100, now: () => 0 });
  const base: InkViewState = { columns: 100, rows: 24, tail: [], status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: true, pendingInput: [], inputHint: "composer", now: 0, visibleHistory: [] };
  const app = render(createElement(InkView, { state: base, input: initialInput() }), {
    stdout: output as unknown as NodeJS.WriteStream, stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    incrementalRendering: true, maxFps: 30, patchConsole: false, exitOnCtrlC: false,
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  try {
    await settle(); bytes = "";
    const preparing = producer.push({ type: "tool_call_preview", previewId: "1:0:0", name: "write_file", argumentsChars: 123 } as AgentEvent);
    app.rerender(createElement(InkView, { state: { ...base, tail: preparing.tail, status: preparing.status ?? null }, input: initialInput() }));
    await settle();
    expect(stripAnsi(bytes)).toContain("write_file");
    expect(stripAnsi(bytes)).toContain("生成参数中");
    expect(stripAnsi(bytes)).toContain("123");
    expect(stripAnsi(bytes)).not.toContain("done");
    bytes = "";
    const started = producer.push({ type: "tool_started", previewId: "1:0:0", call: { id: "call", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"ready"}' } } } as AgentEvent);
    app.rerender(createElement(InkView, { state: { ...base, tail: started.tail, status: started.status ?? null }, input: initialInput() }));
    await settle();
    expect(stripAnsi(bytes)).toContain("running");
    expect(stripAnsi(bytes)).not.toContain("done");
  } finally { app.unmount(); app.cleanup(); }
});
