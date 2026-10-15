import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type TerminalInput,
  TerminalModes,
  type TerminalOutput,
} from "../../src/cli/ink/terminal-modes";
import type { InputEvent } from "../../src/cli/terminal/decoder";

const light: InputEvent = { kind: "background", background: "light" };
const dark: InputEvent = { kind: "background", background: "dark" };
const key: InputEvent = { kind: "key", key: "enter", pasted: false };
const QUERY = "\x1b]11;?\x07";

function fixture(initialRaw = false, tty = true) {
  const input = {
    isTTY: tty,
    isRaw: initialRaw,
    setRawMode: vi.fn((value: boolean) => {
      input.isRaw = value;
      return input;
    }),
  };
  const writes: string[] = [];
  const output = {
    isTTY: tty,
    write: vi.fn((value: string) => {
      writes.push(value);
      return true;
    }),
  };
  const changes = vi.fn();
  const modes = new TerminalModes(
    input as unknown as TerminalInput,
    output as unknown as TerminalOutput,
    changes,
  );
  return { input, output, writes, changes, modes };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("COLORFGBG", undefined);
  vi.stubEnv("NO_COLOR", undefined);
  vi.stubEnv("INK_SCREEN_READER", undefined);
  vi.stubEnv("TERM", "xterm-256color");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Ink terminal modes", () => {
  it("enables paste and raw once, restores original mode on repeated disposal", () => {
    const f = fixture();
    f.modes.configure("dark");
    f.modes.configure("light");
    expect(f.modes.theme).toBe("light");
    expect(f.changes.mock.calls).toEqual([["dark"], ["light"]]);
    expect(f.input.setRawMode.mock.calls).toEqual([[true]]);
    expect(f.writes).toEqual(["\x1b[?2004h"]);
    expect(f.modes.handle(key)).toBe(false);
    f.modes.dispose();
    f.modes.dispose();
    f.modes.configure("dark");
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(f.writes).toEqual(["\x1b[?2004h", "\x1b[?2004l"]);
    expect(f.modes.theme).toBe("light");
  });

  it("does not alter raw when it was already enabled", () => {
    const f = fixture(true);
    f.modes.configure("light");
    f.modes.dispose();
    expect(f.input.setRawMode).not.toHaveBeenCalled();
    expect(f.input.isRaw).toBe(true);
  });

  it.each([
    ["0;0", "dark"],
    ["15;7", "light"],
    ["0;8", "dark"],
    ["2;15", "light"],
    ["", "system"],
    ["invalid", "system"],
    ["0;", "system"],
    ["0;256", "system"],
  ] as const)("detects COLORFGBG %j as %s", (value, expected) => {
    vi.stubEnv("COLORFGBG", value);
    const f = fixture();
    f.modes.configure("system");
    expect(f.modes.theme).toBe(expected);
    expect(f.writes.includes("\x1b]11;?\x07")).toBe(expected === "system");
    f.modes.dispose();
  });

  it("accepts just the first OSC 11 response during the query window", () => {
    const f = fixture();
    f.modes.configure("system");
    expect(f.modes.theme).toBe("system");
    expect(f.writes).toEqual(["\x1b[?2004h", "\x1b]11;?\x07"]);
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("light");
    expect(f.modes.handle(dark)).toBe(true);
    expect(f.changes.mock.calls).toEqual([["light"]]);
    f.modes.dispose();
  });

  it("expires a pending query and never issues a second one", () => {
    const f = fixture();
    f.modes.configure("system");
    vi.advanceTimersByTime(350);
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("system");
    f.modes.configure("system");
    expect(f.writes.filter((write) => write === "\x1b]11;?\x07")).toHaveLength(
      1,
    );
    f.modes.dispose();
  });

  it("rejects late replies after changing theme or disposing", () => {
    const f = fixture();
    f.modes.configure("system");
    f.modes.configure("dark");
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("dark");
    f.modes.dispose();
    expect(f.modes.handle(light)).toBe(true);
    expect(f.changes.mock.calls).toEqual([["dark"]]);
  });

  it("skips active terminal probing for NO_COLOR, screen readers, dumb or non-TTY terminals", () => {
    for (const env of ["NO_COLOR", "INK_SCREEN_READER", "TERM"] as const) {
      vi.stubEnv(
        env,
        env === "TERM" ? "dumb" : env === "NO_COLOR" ? "" : "true",
      );
      const f = fixture();
      f.modes.configure("system");
      expect(f.modes.theme).toBe("system");
      expect(f.modes.screenReader).toBe(env === "INK_SCREEN_READER");
      expect(f.writes).not.toContain("\x1b]11;?\x07");
      f.modes.dispose();
      vi.stubEnv(env, env === "TERM" ? "xterm-256color" : undefined);
    }
    const f = fixture(false, false);
    f.modes.configure("system");
    expect(f.writes).toEqual([]);
    expect(f.input.setRawMode).not.toHaveBeenCalled();
    f.modes.dispose();
    expect(f.writes).toEqual([]);
  });

  it("honors explicit settings despite NO_COLOR and does not query or accept unsolicited replies", () => {
    vi.stubEnv("NO_COLOR", "");
    const f = fixture();
    f.modes.configure("light");
    expect(f.modes.handle(dark)).toBe(true);
    expect(f.modes.theme).toBe("light");
    expect(f.writes).toEqual(["\x1b[?2004h"]);
    f.modes.dispose();
  });

  it("restores raw on a failed paste enable or query write", () => {
    for (const failingWrite of [1, 2]) {
      const f = fixture();
      f.output.write.mockImplementationOnce((value: string) => {
        f.writes.push(value);
        if (failingWrite === 1) throw new Error("write failed");
        return true;
      });
      if (failingWrite === 2) {
        f.output.write.mockImplementationOnce((value: string) => {
          f.writes.push(value);
          throw new Error("write failed");
        });
      }
      expect(() => f.modes.configure("system")).toThrow("write failed");
      expect(f.input.isRaw).toBe(false);
      expect(f.writes).toContain("\x1b[?2004l");
      expect(f.modes.handle(light)).toBe(true);
      f.modes.dispose();
    }
  });

  it("restores raw even when disabling paste fails", () => {
    const f = fixture();
    f.modes.configure("dark");
    f.output.write.mockImplementationOnce(() => {
      throw new Error("disable failed");
    });
    expect(() => f.modes.dispose()).toThrow("disable failed");
    expect(f.input.isRaw).toBe(false);
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it("restores raw if enabling raw throws after changing the mode", () => {
    const f = fixture();
    f.input.setRawMode.mockImplementationOnce((value) => {
      f.input.isRaw = value;
      throw new Error("raw failed");
    });
    expect(() => f.modes.configure("dark")).toThrow("raw failed");
    expect(f.input.isRaw).toBe(false);
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(f.writes).toEqual([]);
  });

  it("keeps a pending probe and its reply when reconfiguring to the same system setting", () => {
    const f = fixture();
    f.modes.configure("system");
    expect(f.writes).toEqual(["\x1b[?2004h", QUERY]);
    f.modes.configure("system");
    expect(f.input.setRawMode.mock.calls).toEqual([[true]]);
    expect(f.writes).toEqual(["\x1b[?2004h", QUERY]);
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("light");
    expect(f.changes.mock.calls).toEqual([["light"]]);
    f.modes.dispose();
  });

  it("keeps an already-detected theme across repeated system configuration", () => {
    vi.stubEnv("COLORFGBG", "0;15");
    const f = fixture();
    f.modes.configure("system");
    expect(f.modes.theme).toBe("light");
    f.modes.configure("system");
    expect(f.modes.theme).toBe("light");
    expect(f.changes.mock.calls).toEqual([["light"]]);
    expect(f.writes).toEqual(["\x1b[?2004h"]);
    f.modes.dispose();
  });

  it("starts a probe after an inconclusive COLORFGBG but not twice", () => {
    vi.stubEnv("COLORFGBG", "0;256");
    const f = fixture();
    f.modes.configure("system");
    expect(f.modes.theme).toBe("system");
    expect(f.writes).toEqual(["\x1b[?2004h", QUERY]);
    f.modes.configure("system");
    expect(f.writes.filter((write) => write === QUERY)).toHaveLength(1);
    f.modes.dispose();
  });

  it("cancels a pending probe when switching away and reverts to the explicit theme", () => {
    const f = fixture();
    f.modes.configure("system");
    f.modes.configure("dark");
    vi.advanceTimersByTime(350);
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("dark");
    f.modes.configure("system");
    f.modes.configure("system");
    expect(f.modes.theme).toBe("system");
    expect(f.writes.filter((write) => write === QUERY)).toHaveLength(1);
    f.modes.dispose();
  });

  it("consumes every background reply even when no probe is pending", () => {
    const f = fixture();
    expect(f.modes.handle(dark)).toBe(true);
    expect(f.modes.theme).toBe("system");
    f.modes.configure("light");
    expect(f.modes.handle(dark)).toBe(true);
    expect(f.modes.theme).toBe("light");
    expect(f.modes.handle(key)).toBe(false);
    f.modes.dispose();
  });

  it.each(["1", "true", "YES", "on"])(
    "honors INK_SCREEN_READER value %s",
    (value) => {
      vi.stubEnv("INK_SCREEN_READER", value);
      const f = fixture();
      expect(f.modes.screenReader).toBe(true);
      f.modes.configure("system");
      expect(f.writes).toEqual(["\x1b[?2004h"]);
      f.modes.dispose();
    },
  );

  it.each(["", "0", "false", "no", "off", "maybe"])(
    "ignores non-enabling INK_SCREEN_READER value %j",
    (value) => {
      vi.stubEnv("INK_SCREEN_READER", value);
      const f = fixture();
      expect(f.modes.screenReader).toBe(false);
      f.modes.configure("system");
      expect(f.writes).toEqual(["\x1b[?2004h", QUERY]);
      f.modes.dispose();
    },
  );

  it("turns paste off exactly once and disables raw only after an unreleased probe", () => {
    const f = fixture();
    f.modes.configure("system");
    f.modes.dispose();
    f.modes.dispose();
    expect(f.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(f.writes).toEqual(["\x1b[?2004h", QUERY, "\x1b[?2004l"]);
    expect(f.modes.handle(light)).toBe(true);
    expect(f.modes.theme).toBe("system");
    expect(f.changes).not.toHaveBeenCalled();
  });
});
