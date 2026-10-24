import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("keeps the built non-interactive CLI free of Ink output", async () => {
  const home = await mkdtemp(join(tmpdir(), "forge-ink-help-"));
  try {
    const result = spawnSync(process.execPath, [resolve("dist/cli.mjs"), "--help"], {
      env: { PATH: "/usr/bin:/bin", HOME: home, FORGE_HOME: home, TERM: "dumb", NO_COLOR: "1" },
      encoding: "utf8", timeout: 10000, maxBuffer: 100000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Forge");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\x1b");
  } finally { await rm(home, { recursive: true, force: true }); }
});

it.each(["none", "light", "dark"] as const)("starts the built Ink chat with %s colors in a real PTY and restores terminal modes", async color => {
  const home = await mkdtemp(join(tmpdir(), "forge-ink-pty-"));
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const child = spawn("script", ["-q", "-e", "-c", `stty rows 24 cols 80; exec ${quote(process.execPath)} ${quote(resolve("dist/cli.mjs"))} chat`, "/dev/null"], {
    env: { PATH: "/usr/bin:/bin", HOME: home, FORGE_HOME: home, TERM: "xterm-256color",
      ...(color === "none" ? { NO_COLOR: "1" } : { COLORTERM: "truecolor", COLORFGBG: color === "light" ? "0;15" : "15;0" }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let sent = false;
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (!sent && output.includes("Ask anything")) {
      sent = true;
      child.stdin.write("/quit\r");
    }
    if (output.length > 200000) child.kill("SIGKILL");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    expect(code, output).toBe(0);
    expect(sent, output).toBe(true);
    expect(output).toContain("\x1b[?2004h");
    expect(output).toContain("\x1b[?2004l");
    expect(output).toContain("\x1b[?25h");
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("\x1b[?1049l");
    expect(output).toContain("\x1b[?1000h");
    expect(output).toContain("\x1b[?1006h");
    expect(output).toContain("\x1b[?1000l");
    expect(output).toContain("\x1b[?1006l");
    expect(output).not.toMatch(/\x1b\[\?(?:1002|1003)h/);
    expect(output).not.toContain("\x1b[3J");
    if (color === "none") expect(output).not.toMatch(/\x1b\[[\d;]*m/);
    else expect(output).toContain(color === "light" ? "\x1b[38;2;85;104;77m" : "\x1b[38;2;143;173;130m");
  } finally {
    clearTimeout(timer);
    await rm(home, { recursive: true, force: true });
  }
});
