import { describe, expect, it } from "vitest";
import {
  getTerminalWidth,
  stringWidth,
  stripAnsi,
  truncate,
  visibleWidth,
} from "../../src/cli/theme";

describe("width v2", () => {
  it("measures CJK, emoji, and combining marks without ANSI width", () => {
    expect(stringWidth("中文")).toBe(4);
    expect(stringWidth("🙂")).toBe(2);
    expect(stringWidth("e\u0301")).toBe(1);
    expect(visibleWidth("\u001b[38;2;255;0;0m中\u001b[0m")).toBe(2);
  });

  it("strips OSC and CSI, including a truncated truecolor sequence", () => {
    const osc = "\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007";
    expect(stripAnsi(osc)).toBe("link");
    const styled = "\u001b[38;2;255;0;0mabcdef";
    const cut = truncate(styled, 4);
    expect(stripAnsi(cut)).toBe("abc…");
    expect(cut).toContain("\u001b[0m");
    expect(stringWidth(cut)).toBeLessThanOrEqual(4);
  });

  it("does not clamp terminal width to 40", () => {
    const columns = process.stderr.columns;
    Object.defineProperty(process.stderr, "columns", {
      configurable: true,
      value: 20,
    });
    expect(getTerminalWidth()).toBe(20);
    Object.defineProperty(process.stderr, "columns", {
      configurable: true,
      value: columns,
    });
  });
});
