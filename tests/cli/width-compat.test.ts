import libraryStringWidth from "string-width";
import { describe, expect, it } from "vitest";
import {
  graphemes,
  graphemeWidth,
  stringWidth,
  stripAnsi,
  truncate,
} from "../../src/cli/render/width";

const compatibilityCases = [
  ["ASCII", "forge"],
  ["Chinese", "中文"],
  ["combining mark", "e\u0301"],
  ["ZWJ emoji", "👩🏽‍🚀"],
  ["flag", "🇨🇳"],
  ["VS16 emoji", "☀️"],
  ["keycap", "1️⃣"],
  ["Indic conjunct", "क्‍ष"],
  ["Indic spacing mark", "क्‍षि"],
  ["Hangul Jamo", "가"],
] as const;

describe("Ink string-width compatibility", () => {
  it.each(compatibilityCases)("matches string-width for %s", (_name, value) => {
    expect(stringWidth(value)).toBe(libraryStringWidth(value));
  });

  it.each(compatibilityCases.slice(2))(
    "keeps the %s cluster intact",
    (_name, value) => {
      expect(graphemes(value)).toEqual([value]);
      expect(graphemeWidth(value)).toBe(libraryStringWidth(value));
    },
  );

  it("sanitizes terminal controls before measuring", () => {
    const linked = "\u001b]8;;https://example.test\u0007中文\u001b]8;;\u0007";
    const controls = "a\u0000\u0007b\u009bc";

    expect(stripAnsi(linked)).toBe("中文");
    expect(stringWidth(linked)).toBe(libraryStringWidth("中文"));
    expect(stripAnsi(controls)).toBe("ab");
    expect(stringWidth(controls)).toBe(libraryStringWidth("ab"));
  });

  it.each([
    ["👩🏽‍🚀x", 2, "…"],
    ["🇨🇳x", 2, "…"],
    ["☀️x", 2, "…"],
    ["क्‍षx", 1, "…"],
    ["क्‍षिx", 2, "…"],
  ] as const)("does not split the leading grapheme in %s at width %i", (value, width, expected) => {
    const result = truncate(value, width);

    expect(result).toBe(expected);
    expect(stringWidth(result)).toBeLessThanOrEqual(width);
  });

  it("handles narrower limits and unsafe suffix/input without leaking controls", () => {
    expect(truncate("中文", 1)).toBe("…");
    expect(truncate("中文", 1, "..")).toBe("");

    const result = truncate(
      "\u001b[31m👩‍💻x\u001b]8;;https://example.test\u0007hidden",
      2,
      "\u001b[2J…",
    );
    expect(stripAnsi(result)).toBe("…");
    expect(result).not.toContain("\u001b[2J");
    expect(result).not.toContain("https://example.test");
    expect(stringWidth(result)).toBeLessThanOrEqual(2);
  });
});
