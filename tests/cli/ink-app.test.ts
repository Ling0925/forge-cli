import { createElement } from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { expect, it } from "vitest";
import { InkApp } from "../../src/cli/ink/app";
import { InputStore } from "../../src/cli/ink/input-store";
import { stripAnsi } from "../../src/cli/theme";
import type { InkViewState } from "../../src/cli/ink/types";

it("React subscribes to input focus without controller rerenders or a second stream listener", async () => {
  const stdin = new PassThrough();
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 });
  let latest = "";
  stdout.on("data", chunk => { const value = stripAnsi(chunk.toString()); if (value) latest = value; });
  const store = new InputStore(effect => { if (effect.type === "approval") store.end(); });
  const state: InkViewState = { columns: 80, rows: 24, tail: [], status: null, context: null, plan: null,
    mode: "build", theme: "dark", noColor: true, pendingInput: [], inputHint: null, now: 0 };
  const app = render(createElement(InkApp, { state, input: store }), {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    await flush();
    store.dispatch({ kind: "text", text: "saved-draft", pasted: false }, false, false);
    await flush();
    expect(latest).toContain("saved-draft");
    const picked = store.choose({ title: "Pick model", items: [{ value: "m", label: "model-one" }] }, new AbortController().signal);
    await flush();
    expect(latest).toContain("Pick model");
    expect(latest).not.toContain("saved-draft");
    store.begin("Approve? [Y/n] ", true);
    expect(await picked).toBeNull();
    await flush();
    expect(latest).toContain("Approve?");
    expect(latest).not.toMatch(/Pick model|saved-draft/);
    store.dispatch({ kind: "key", key: "escape", pasted: false }, true, true);
    await flush();
    expect(latest).toContain("saved-draft");
    expect(latest).not.toContain("Approve?");
    expect(stdin.listenerCount("data")).toBe(0);
    expect(stdin.listenerCount("readable")).toBe(0);
  } finally { app.unmount(); app.cleanup(); store.dispose(); }
});
