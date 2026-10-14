import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNodeIO } from "../../src/cli/node-io";
import { sessionSnapshotSchema } from "../../src/shared/schemas";

describe("v2 actual CliIO and persisted fixtures", () => {
  it("validates every resume fixture with the production schema", () => {
    const sessions = JSON.parse(
      readFileSync("tests/cli/fixtures/cli-v2/sessions.json", "utf8"),
    );
    expect(sessions).toHaveLength(3);
    for (const session of sessions)
      expect(sessionSnapshotSchema.parse(session)).toEqual(session);
    expect(
      new Set(sessions.map((x: { workspace: string }) => x.workspace)).size,
    ).toBe(3);
  });
  it("actual rich CliIO controller preserves a busy draft and restores raw mode", async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode(raw: boolean) {
        this.isRaw = raw;
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    output.resume();
    const io = createNodeIO({ stdin: input, stdout: output, stderr: output });
    try {
      const ui = io.ui;
      if (!ui) throw new Error("Expected rich terminal UI");
      await ui.configure({ theme: "dark" });
      expect(input.isRaw).toBe(true);
      ui.setBusy(true);
      const read = io.question("❯ ", new AbortController().signal);
      let resolved = false;
      void read.then(() => {
        resolved = true;
      });
      input.write("中文 e\u0301 🎉 exact\x1b[D\r");
      await new Promise((resolve) => setImmediate(resolve));
      expect(resolved).toBe(false);
      ui.setBusy(false);
      input.write("\x1b[C\r");
      expect(await read).toBe("中文 e\u0301 🎉 exact");
    } finally {
      io.dispose?.();
    }
    expect(input.isRaw).toBe(false);
  });
  it("nonTTY reads exact UTF8 and emits no terminal control bytes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.on("data", (chunk) => {
      captured += chunk.toString();
    });
    const io = createNodeIO({
      stdin: input,
      stdout: output,
      stderr: output,
      isTTY: false,
    });
    try {
      expect(io.ui).toBeUndefined();
      const read = io.readStdin(1024, new AbortController().signal);
      input.end("中文 e\u0301 🎉\n");
      expect(await read).toBe("中文 e\u0301 🎉\n");
      io.stdout("plain output\n");
      expect(captured).toBe("plain output\n");
      expect(captured).not.toContain("\x1b");
    } finally {
      io.dispose?.();
    }
  });
});
