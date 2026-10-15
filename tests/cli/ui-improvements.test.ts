import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { TerminalReader } from "../../src/cli/terminal";
import { Controller } from "../../src/cli/terminal/controller";
import { Screen } from "../../src/cli/terminal/screen";
import { contextFooter } from "../../src/cli/terminal/context-footer";
import { MarkdownStream } from "../../src/cli/render/markdown";
import { diffLines } from "../../src/cli/render/diff";
import { visibleWidth } from "../../src/cli/theme";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (lines: readonly RichLine[]) => lines.map(l => l.map(s => s.text).join("")).join("\n");

it("wires mode and plan through the public Reader, not just Controller", async () => {
  const input = new PassThrough(); const output = Object.assign(new PassThrough(), {columns:80, rows:24});
  const reader = new TerminalReader({input, output, isTTY:true});
  const paint = vi.spyOn(Screen.prototype, "paint");
  try {
    await reader.ui.configure({theme:"dark"});
    const toggle = vi.fn(() => reader.ui.setMode?.("plan")); reader.ui.onModeToggle?.(toggle);
    input.write("\x1b[Z"); expect(toggle).toHaveBeenCalledOnce();
    expect(paint.mock.calls.at(-1)?.[0].flat()).toContainEqual({text:"❯ ", tone:"warning"});
    reader.ui.setPlan?.({explanation:"", steps:[{step:"Verify wiring",status:"in_progress"}]});
    expect(text(paint.mock.calls.at(-1)?.[0] ?? [])).toContain("Plan 0/1");
    const approval = reader.readApproval("Approve? [Y/n]", new AbortController().signal);
    input.write("\x1b[Z\r"); expect(await approval).toBe(true); expect(toggle).toHaveBeenCalledOnce();
  } finally {reader.dispose(); paint.mockRestore();}
});
it("coalesces resize, cancels timers on dispose, and shows honest copy feedback", async () => {
  vi.useFakeTimers();
  const output = Object.assign(new PassThrough(), {columns:80, rows:24});
  const c = new Controller(new PassThrough(), output, false, () => {}, () => {}, () => {}, async () => false);
  c.screen.enabled = true; c.screen.fixed = true;
  const paint = vi.spyOn(c.screen, "paint"); const invalidate = vi.spyOn(c.screen, "invalidate");
  try {
    for(let i=0;i<20;i++) {c.resize(); c.draw();}
    expect(invalidate).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(16);
    expect(invalidate).toHaveBeenCalledOnce(); expect(paint).toHaveBeenCalledOnce();
    vi.spyOn(c.screen, "hasSelection", "get").mockReturnValue(true);
    vi.spyOn(c.screen, "copySelection").mockReturnValue(true);
    c.handle({kind:"key",key:"interrupt",pasted:false});
    expect(c.notice).toContain("request sent"); expect(c.notice).not.toContain("success");
    await vi.advanceTimersByTimeAsync(1500); expect(c.notice).toBeNull();
    c.resize(); c.dispose(); const count = paint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50); expect(paint.mock.calls.length).toBe(count);
  } finally {c.dispose(); vi.useRealTimers();}
});
it("keeps compact footer bounded and tall picker useful", async () => {
  for(const width of [1,8,20,40,80]) {
    const lines = contextFooter({model:"中文-model", usage:null},width,true);
    expect(lines).toHaveLength(1); expect(visibleWidth(text(lines))).toBeLessThanOrEqual(width);
  }
  const c = new Controller(new PassThrough(), Object.assign(new PassThrough(),{columns:80,rows:60}),false,()=>{},()=>{},()=>{},async()=>false);
  c.screen.enabled = true; c.screen.fixed = true;
  const paint = vi.spyOn(c.screen,"paint");
  const choice = c.choose({title:"Models",items:Array.from({length:30},(_,i)=>({value:String(i),label:`model-${i}`}))},new AbortController().signal);
  const frame = paint.mock.calls.at(-1)?.[0] ?? [];
  expect(frame.length).toBeLessThanOrEqual(20);
  expect(frame.filter(l=>text([l]).includes("model-"))).toHaveLength(12);
  c.picker?.resolve(null); await choice; c.dispose();
});
it("renders code borders and lossless multicolor tokens identically across every split", () => {
  const source = '```ts\nconst n = 42; // note\n/* block\ncomment */ return "yes";\n```\n';
  const render = (split: number) => {const stream = new MarkdownStream(); return [...stream.push(source.slice(0,split)).append,...stream.push(source.slice(split)).append,...stream.finish().append];};
  const expected = render(0);
  for(let split=1;split<source.length;split++) expect(render(split)).toEqual(expected);
  expect(text(expected)).toContain('const n = 42; // note');
  expect(expected.flat()).toContainEqual({text:'42',tone:'warning'});
  expect(expected.flat()).toContainEqual({text:'"yes"',tone:'success'});
  expect(expected.flat().some(span => span.tone === 'muted' && span.text.includes('/* block'))).toBe(true);
  const unknown = new MarkdownStream(); const shown = [...unknown.push('```unknown\nkeep\x1b]52;c;bad\x07\n').append,...unknown.finish().append];
  expect(text(shown)).toContain("  keep"); expect(text(shown)).toContain("── unknown ──"); expect(text(shown)).not.toContain("bad");
});
it("shows diff statistics and labels source-limited counts", () => {
  const change = {path:"a.ts",kind:"modified" as const,before:"a\nb\nc",after:"a\nx\ny\nc",truncated:false};
  expect(text(diffLines(change))).toContain("[+2 -1]");
  expect(text(diffLines({...change,truncated:true}))).toContain("partial preview");
  expect(text(diffLines({...change,before:null}))).not.toContain("[+2");
});
