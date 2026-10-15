import { expect, it } from "vitest";
import { diffLines, diffStats } from "../../src/cli/render/diff";
import { editScript } from "../../src/cli/render/edit-script";
import type { FileChange } from "../../src/shared/schemas";
const change = (before: string, after: string): FileChange => ({
  path: "a.ts", kind: "modified", before, after, truncated: false,
});
// Ignore the presentation gutter here; structured-diff covers its exact numbering.
const text = (value: FileChange) => diffLines(value).map(line => line.map(span => span.text).join("").replace(/^\s*\d+ ([ +\-]) /, "$1")).join("\n");

it("keeps unchanged lines neutral in long files with one edit", () => {
  const before = Array.from({ length: 600 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[300] = "changed";
  const value = change(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
  expect(diffStats(value)).toEqual({ added: 1, removed: 1 });
  expect(text(value)).toContain("-line 300\n+changed");
  expect(text(value)).toContain(" line 299");
  expect(text(value)).not.toContain("-line 299");
});
it("handles distant changes without a product-size fallback", () => {
  const before = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[5] = "changed early";
  after[990] = "changed late";
  const value = change(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
  expect(diffStats(value)).toEqual({ added: 2, removed: 2 });
  expect(text(value)).toContain("+changed early");
  expect(text(value)).toContain("+changed late");
});
it("merges nearby change hunks without duplicating context or changed rows", () => {
  const value = change("a\nb\nc\nd\ne\nf\ng\nh\n", "a\nB\nc\nd\ne\nF\ng\nh\n");
  expect(diffStats(value)).toEqual({ added: 2, removed: 2 });
  const rendered = text(value);
  expect(rendered.match(/@@ -/g)).toHaveLength(1);
  expect(rendered.match(/^ c$/gm)).toHaveLength(1);
  expect(rendered.match(/^-b$/gm)).toHaveLength(1);
  expect(rendered.match(/^\+F$/gm)).toHaveLength(1);
});
it("reports identical large content as unchanged", () => {
  const same = "unchanged\n".repeat(1000);
  expect(diffStats(change(same, same))).toEqual({ added: 0, removed: 0 });
  expect(text(change(same, same))).toContain("no textual change");
});
it("does not invent +/- rows or exact counts from truncated previews", () => {
  const value = { ...change("unchanged prefix\npart", "unchanged prefix\npartial"), truncated: true };
  expect(diffStats(value)).toBeNull();
  expect(text(value)).toContain("exact diff unavailable");
  expect(text(value)).not.toContain("-part");
  expect(text(value)).not.toContain("[+");
});
it("does not invent a full-file replacement when the search budget is exhausted", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join("\n");
  const value = change(before, after);
  expect(diffStats(value)).toBeNull();
  expect(text(value)).toContain("budget exceeded");
  expect(text(value)).not.toContain("-old 0");
});
it("distinguishes final-newline changes and marks missing final newlines", () => {
  const value = change("same\n", "same");
  expect(diffStats(value)).toEqual({ added: 1, removed: 1 });
  expect(text(value)).toContain("no final newline");
});
it("makes CR-only differences visible instead of showing identical +/- text", () => {
  const value = change("same\r\n", "same\n");
  expect(diffStats(value)).toEqual({ added: 1, removed: 1 });
  expect(text(value)).toContain("-same ⟪CR⟫");
});
it("reconstructs both sides for insertions, deletions, empty and repeated inputs", () => {
  const inputs = [[], ["a"], ["b"], ["a", "a"], ["a", "b"], ["b", "a", "b"], ["a", "c", "a", "b"]];
  for (const before of inputs) for (const after of inputs) {
    const script = editScript(before, after);
    expect(script).not.toBeNull();
    expect(script?.filter(step => step.op !== "insert").map(step => step.text)).toEqual(before);
    expect(script?.filter(step => step.op !== "delete").map(step => step.text)).toEqual(after);
  }
});
