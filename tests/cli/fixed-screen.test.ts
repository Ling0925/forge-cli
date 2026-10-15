import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Screen, plain } from "./legacy/screen";
import { createTheme } from "../../src/cli/theme";

function fixture() {
  const output = new PassThrough();
  let bytes = "";
  output.on("data", (chunk: Buffer) => { bytes += chunk.toString(); });
  const dimensions = { columns: 18, rows: 5 };
  const screen = new Screen(output, () => dimensions, createTheme({ isTTY: false }));
  screen.enabled = true;
  screen.fixed = true;
  return { screen, dimensions, output: () => bytes, reset: () => { bytes = ""; } };
}

describe("fixed terminal screen", () => {
  it("docks the composer while scrolling and follows new output", () => {
    const { screen, output, reset } = fixture();
    screen.append(Array.from({ length: 8 }, (_, index) => plain(`message ${index}`)));
    screen.paint([plain("❯ draft"), plain("status")], 0, 2);
    expect(output()).toContain("message 7");
    expect(output()).not.toContain("message 0");
    expect(output()).toContain("\x1b[4;1H");
    expect(output()).toContain("\x1b[4;3H");
    reset();
    screen.scroll(3);
    expect(output()).toContain("message 4");
    expect(output()).not.toContain("message 7");
    screen.append([plain("message 8")]);
    reset();
    screen.paint([plain("❯ draft"), plain("status")], 0, 2);
    expect(output()).not.toContain("message 8");
    screen.scroll(-100);
    expect(output()).toContain("message 8");
  });

  it("reflows transcript on resize and does not write outside the viewport", () => {
    const { screen, dimensions, output, reset } = fixture();
    screen.append([plain("abcdefghijklmnopqrstu")]);
    screen.paint([plain("❯ ")], 0, 2);
    dimensions.columns = 10;
    dimensions.rows = 3;
    reset();
    screen.invalidate();
    screen.paint([plain("❯ ")], 0, 2);
    expect(output()).toContain("\x1b[2J");
    expect(output()).toContain("\x1b[3;1H");
    expect(output()).not.toContain("\x1b[4;1H");
  });
});
