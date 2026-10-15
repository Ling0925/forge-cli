import { describe, expect, it } from "vitest";
import { createTheme, resolveTheme } from "../../src/cli/theme";

const linear = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const luminance = (rgb: readonly [number, number, number]): number =>
  0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);

const contrast = (
  ink: readonly [number, number, number],
  canvas: readonly [number, number, number],
): number => {
  const hi = Math.max(luminance(ink), luminance(canvas));
  const lo = Math.min(luminance(ink), luminance(canvas));
  return (hi + 0.05) / (lo + 0.05);
};

const CUBE = [0, 95, 135, 175, 215, 255];

const cube = (index: number): readonly [number, number, number] => {
  const offset = index - 16;
  return [
    CUBE[Math.floor(offset / 36)] ?? 0,
    CUBE[Math.floor((offset % 36) / 6)] ?? 0,
    CUBE[offset % 6] ?? 0,
  ];
};

const numbers = (styled: string, prefix: string): number[] => {
  const start = styled.indexOf(prefix);
  if (start < 0) return [];
  const end = styled.indexOf("m", start);
  return styled
    .slice(start + prefix.length, end)
    .split(";")
    .map(Number);
};

const rgbOf = (styled: string): readonly [number, number, number] | null => {
  const truecolor = numbers(styled, "\u001b[38;2;");
  if (truecolor.length === 3) {
    return [truecolor[0] ?? 0, truecolor[1] ?? 0, truecolor[2] ?? 0];
  }
  const indexed = numbers(styled, "\u001b[38;5;");
  return indexed[0] === undefined ? null : cube(indexed[0]);
};

describe("resolveTheme", () => {
  it("emits no escapes for NO_COLOR, dumb terminals, or low color depth", () => {
    for (const theme of [
      resolveTheme({
        setting: "dark",
        background: "dark",
        colorDepth: 24,
        noColor: true,
        dumb: false,
      }),
      resolveTheme({
        setting: "dark",
        background: "dark",
        colorDepth: 24,
        noColor: false,
        dumb: true,
      }),
      resolveTheme({
        setting: "light",
        background: "light",
        colorDepth: 1,
        noColor: false,
        dumb: false,
      }),
      createTheme({ forceColor: false }),
    ]) {
      expect(theme.red("error")).toBe("error");
      expect(theme.bold("Forge")).toBe("Forge");
      expect(theme.variant).toBe("plain");
    }
  });

  it("keeps unknown system backgrounds on terminal-native semantic colors", () => {
    const theme = resolveTheme({
      setting: "system",
      background: "unknown",
      colorDepth: 24,
      noColor: false,
      dumb: false,
    });
    expect(theme.variant).toBe("structural");
    expect(theme.dim("context")).toContain("\u001b[90m");
    expect(theme.bold("Forge")).toContain("\u001b[1m");
    expect(theme.cyan("accent")).toContain("\u001b[32m");
    expect(theme.red("error")).toContain("\u001b[31m");
  });

  it("uses one sage accent and semantic colors with contrast >= 4.5", () => {
    const canvases = {
      light: [0xfd, 0xfd, 0xfb],
      dark: [0x16, 0x19, 0x15],
    } as const;
    for (const variant of ["light", "dark"] as const) {
      for (const depth of [8, 24]) {
        const theme = resolveTheme({
          setting: variant,
          background: "unknown",
          colorDepth: depth,
          noColor: false,
          dumb: false,
        });
        expect(theme.cyan("a")).toBe(theme.blue("a"));
        expect(theme.magenta("a")).toBe(theme.cyan("a"));
        const roles = [
          theme.dim("m"),
          theme.cyan("a"),
          theme.green("s"),
          theme.yellow("w"),
          theme.red("e"),
        ];
        for (const styled of roles) {
          const ink = rgbOf(styled);
          expect(ink).not.toBeNull();
          if (ink)
            expect(contrast(ink, canvases[variant])).toBeGreaterThanOrEqual(
              4.5,
            );
        }
      }
    }
  });
});
