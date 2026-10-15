import { expect, it } from "vitest";
import { resolveTheme } from "../../src/cli/theme";
import { renderRichLine, wrapRichLines } from "../../src/cli/render/rich";
import type { Tone } from "../../src/cli/ui-contract";
const roles: Tone[] = ["diffAdded", "diffRemoved", "diffAddedWord", "diffRemovedWord"];
it("renders distinct diff row and word backgrounds in light/dark palettes", () => {
  for (const setting of ["light", "dark"] as const) {
    const theme = resolveTheme({ setting, background: setting, colorDepth: 24, noColor: false, dumb: false });
    const styles = roles.map(role => theme.tone("code", role));
    expect(new Set(styles).size).toBe(4);
    for (const style of styles) { expect(style).toContain("48;5;"); expect(style).toContain("code"); }
  }
});
it("degrades diff styles safely without color and preserves semantic spans when wrapping", () => {
  for (const options of [{ noColor: true, dumb: false }, { noColor: false, dumb: true }]) {
    const theme = resolveTheme({ setting: "dark", background: "dark", colorDepth: 24, ...options });
    for (const role of roles) expect(theme.tone("code", role)).toBe("code");
  }
  const unknown = resolveTheme({ setting: "system", background: "unknown", colorDepth: 4, noColor: false, dumb: false });
  expect(unknown.tone("+new", "diffAdded")).toContain("\u001b[32m");
  const line = [{ text: "abc", tone: "diffAdded" as const }, { text: "XYZ", tone: "diffAddedWord" as const }];
  const rows = wrapRichLines([line], 4);
  expect(rows.flat().filter(span => span.tone === "diffAddedWord").map(span => span.text).join("")).toBe("XYZ");
  expect(renderRichLine([{ text: "unsafe\u001b]52;c;payload\u0007", tone: "diffRemoved" }], unknown)).not.toContain("]52;");
});
