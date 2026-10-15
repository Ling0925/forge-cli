import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { Controller } from "../../src/cli/terminal/controller";
import type { RichLine } from "../../src/cli/ui-contract";
const text = (line: RichLine | undefined) => line?.map(s => s.text).join("") ?? "";
it.each([2, 4, 12, 24, 30, 40, 60])("keeps cursor and activity stable across background updates at %s rows", rows => {
  const c = new Controller(new PassThrough(), Object.assign(new PassThrough(), { columns: 80, rows }), false, () => {}, () => {}, () => {}, async () => false);
  c.screen.enabled = true; c.screen.fixed = true;
  const paint = vi.spyOn(c.screen, "paint");
  try {
    for (const draft of ["", "long line\n".repeat(40)]) {
      c.editor.set(draft); c.draw();
      const before = paint.mock.calls.at(-1)!;
      c.setPlan({ explanation: "", steps: [{ step: "Review files", status: "in_progress" }] });
      c.setStatus({ label: "thinking", startedAt: Date.now(), toolCount: 1, cancellable: true });
      const after = paint.mock.calls.at(-1)!;
      expect(after[1]).toBe(before[1]); expect(after[0].length).toBe(before[0].length);
      expect(after[0].length).toBeLessThanOrEqual(Math.max(1, rows - 1));
      expect(after[1]).toBeGreaterThanOrEqual(0); expect(after[1]).toBeLessThan(after[0].length);
      if (rows >= 30) { expect(text(after[0][0])).toContain("Plan"); expect(text(after[0][1])).toContain("thinking"); }
      c.notify("Clipboard request sent");
      if (rows >= 30) { const frame = paint.mock.calls.at(-1)!; expect(text(frame[0][0])).toContain("Clipboard"); expect(text(frame[0][1])).toContain("thinking"); }
      c.setStatus(null); c.setPlan(null); c.notice = null;
    }
    c.fresh = true; c.prompt = "Approve? [Y/n] "; c.editor.clear(); c.draw();
    expect(paint.mock.calls.at(-1)?.[0].some(line => text(line).includes("Plan"))).toBe(false);
  } finally { c.dispose(); }
});
