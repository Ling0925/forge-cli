import { describe, expect, it } from "vitest";
import { paintTone, resolvePalette, terminalColorDepth } from "../../src/cli/palette";
import { resolveTheme } from "../../src/cli/theme";
import { Transcript } from "../../src/cli/ink/transcript";
import type { Tone } from "../../src/cli/ui-contract";

const options = { setting: "dark" as const, background: "unknown" as const, colorDepth: 24, noColor: false, dumb: false };
const tones: Tone[] = ["text", "muted", "accent", "success", "warning", "error", "diffAdded", "diffRemoved", "diffAddedWord", "diffRemovedWord", "contextInstructions", "contextMemory", "contextConversation", "contextTools"];

describe("shared CLI palette", () => {
  it("preserves the DESIGN sage and semantic inks, and the original CLI diff/category colors", () => {
    const light = resolvePalette({ ...options, setting: "light" }).styles;
    const dark = resolvePalette(options).styles;
    expect(light).toMatchObject({ accent: { foreground: "#55684d" }, muted: { foreground: "#5c6357" },
      success: { foreground: "#226d40" }, warning: { foreground: "#975a06" }, error: { foreground: "#b82420" } });
    expect(dark).toMatchObject({ accent: { foreground: "#8fad82" }, muted: { foreground: "#a4aca0" },
      success: { foreground: "#7ed99e" }, warning: { foreground: "#f0be65" }, error: { foreground: "#ff8f85" } });
    expect(light.diffAdded).toEqual({ foreground: 22, background: 194 });
    expect(dark.diffRemovedWord).toEqual({ foreground: 231, background: 88, bold: true });
    expect(dark.contextInstructions.foreground).toBe(75);
    expect(light.text).toEqual({});
  });

  it.each(["light", "dark", "system"] as const)("uses the same palette for history in %s mode at every color depth", setting => {
    for (const colorDepth of [1, 4, 8, 24]) {
      const palette = resolvePalette({ ...options, setting, colorDepth });
      const theme = resolveTheme({ ...options, setting, colorDepth });
      for (const tone of tones) {
        const text = `value-${tone}`;
        const history = new Transcript();
        history.append([[{ text, tone, bold: true, inverse: true }]]);
        expect(history.drain(80, setting, false, colorDepth).join("")).toBe(`${paintTone(text, palette, tone, { bold: true, inverse: true })}\n`);
        expect(theme.tone(text, tone)).toBe(paintTone(text, palette, tone));
      }
    }
  });

  it("never emits extended colors on a 16-color terminal and retains semantic fallback for unknown backgrounds", () => {
    for (const setting of ["light", "dark", "system"] as const) {
      const palette = resolvePalette({ ...options, setting, colorDepth: 4 });
      for (const tone of tones) expect(paintTone("x", palette, tone)).not.toMatch(/(?:38|48);(?:2|5);/);
      expect(paintTone("accent", palette, "accent")).toContain("\x1b[32m");
      expect(paintTone("failed", palette, "error")).toContain("\x1b[31m");
      expect(paintTone("word", palette, "diffAddedWord")).toContain("\x1b[7m");
    }
    const unknown = resolvePalette({ ...options, setting: "system" });
    expect(unknown.variant).toBe("structural");
    expect(paintTone("approval", unknown, "warning")).toContain("\x1b[33m");
  });

  it("uses indexed sage on 256-color hosts and honors NO_COLOR/dumb/monochrome", () => {
    expect(paintTone("x", resolvePalette({ ...options, colorDepth: 8 }), "accent")).toContain("\x1b[38;5;108m");
    for (const override of [{ noColor: true }, { dumb: true }, { colorDepth: 1 }]) {
      const palette = resolvePalette({ ...options, ...override });
      for (const tone of tones) expect(paintTone("x", palette, tone, { bold: true, inverse: true })).toBe("x");
    }
  });

  it("uses the actual output capability rather than global Chalk detection", () => {
    const write = () => true;
    expect(terminalColorDepth({ write, getColorDepth: () => 24 })).toBe(24);
    expect(terminalColorDepth({ write, getColorDepth: () => 1 })).toBe(1);
    expect(terminalColorDepth({ write, getColorDepth: () => Number.NaN })).toBe(8);
    expect(terminalColorDepth({ write })).toBe(8);
  });
});
