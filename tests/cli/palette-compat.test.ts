import { describe, expect, it } from "vitest";
import { paintTone, resolvePalette } from "../../src/cli/palette";
import { resolveTheme } from "../../src/cli/theme";
import type { Tone } from "../../src/cli/ui-contract";

const base = { setting: "system" as const, background: "unknown" as const, colorDepth: 24, noColor: false, dumb: false };
describe("readable terminal palette fallbacks", () => {
  it.each([4, 8, 24])("keeps unknown-background prose on default foreground at depth %s", colorDepth => {
    const palette = resolvePalette({ ...base, colorDepth });
    const theme = resolveTheme({ ...base, colorDepth });
    expect(paintTone("hints / elapsed / cache", palette, "muted")).toBe("hints / elapsed / cache");
    expect(theme.dim("hint")).toBe("hint");
    expect(theme.gray("hint")).toBe("hint");
    expect(paintTone("rule", palette, "decoration")).toContain("\x1b[90m");
    expect(paintTone("warning", palette, "warning")).toContain("\x1b[33m");
  });

  it.each(["light", "dark"] as const)("uses readable 16-color text on %s backgrounds", background => {
    const palette = resolvePalette({ ...base, background, colorDepth: 4 });
    expect(paintTone("hint", palette, "muted")).toContain(background === "light" ? "\x1b[30m" : "\x1b[37m");
    expect(paintTone("hint", palette, "muted")).not.toContain("\x1b[90m");
    expect(paintTone("state", palette, "success")).toContain(background === "light" ? "\x1b[32m" : "\x1b[92m");
    expect(resolvePalette({ ...base, background, colorDepth: 4, setting: background === "light" ? "dark" : "light" }).variant)
      .toBe(background === "light" ? "dark" : "light");
  });

  it("never uses faint SGR and removes all styling for plain output across the matrix", () => {
    for (const background of ["unknown", "light", "dark"] as const) for (const colorDepth of [1, 4, 8, 24]) {
      const options = { ...base, background, colorDepth };
      const palette = resolvePalette(options);
      for (const tone of Object.keys(palette.styles) as Tone[]) {
        expect(paintTone("x", palette, tone)).not.toContain("\x1b[2m");
        for (const override of [{ noColor: true }, { dumb: true }, { colorDepth: 1 }]) {
          expect(paintTone("x", resolvePalette({ ...options, ...override }), tone, { bold: true, inverse: true })).toBe("x");
        }
      }
    }
  });
});
