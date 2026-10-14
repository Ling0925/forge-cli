import { constants, accessSync, existsSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

/** External QA prerequisites only: never installs, downloads, or skips tests. */
export function terminalQAResources(): {
  chrome: string;
  xterm: string;
  unicode11: string;
} {
  const chrome = process.env.QA_CHROME
    ? resolve(process.env.QA_CHROME)
    : chromium.executablePath();
  try {
    accessSync(chrome, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(
      `Terminal emulator QA needs an executable Chromium at ${chrome}. Set QA_CHROME to an existing Chromium binary, or provision the browser expected by Playwright externally. This test does not download browsers.`,
    );
  }

  const addonCandidates = [
    ...(process.env.XTERM_ROOT
      ? [
          join(
            resolve(process.env.XTERM_ROOT),
            "addon-unicode11/lib/addon-unicode11.js",
          ),
        ]
      : []),
    resolve(".build/qa-deps/@xterm/addon-unicode11/lib/addon-unicode11.js"),
  ];
  const unicode11 = addonCandidates.find((candidate) => existsSync(candidate));
  if (!unicode11) {
    throw new Error(
      `Terminal emulator QA requires the official Unicode11 browser addon. Provision @xterm/addon-unicode11 externally at .build/qa-deps/@xterm/addon-unicode11/lib/addon-unicode11.js, or set XTERM_ROOT to an @xterm directory containing addon-unicode11/lib/addon-unicode11.js. Searched: ${addonCandidates.join(", ")}. This test does not install dependencies.`,
    );
  }
  const asset = (root: string) => join(root, "xterm", "lib", "xterm.js");
  if (process.env.XTERM_ROOT) {
    const xterm = asset(resolve(process.env.XTERM_ROOT));
    if (!existsSync(xterm)) {
      throw new Error(
        `XTERM_ROOT must contain xterm/lib/xterm.js; missing ${xterm}. Point XTERM_ROOT at an existing @xterm directory.`,
      );
    }
    return { chrome, xterm, unicode11 };
  }

  const candidates = [asset(resolve(".build/qa-deps/@xterm"))];
  // Legacy host QA installation: discover Node versions rather than pinning one.
  // userInfo also handles harnesses that override HOME with the workspace.
  for (const home of new Set([homedir(), userInfo().homedir])) {
    const nodes = join(home, ".local/share/pi-node");
    if (!existsSync(nodes)) continue;
    for (const entry of readdirSync(nodes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name))) {
      candidates.push(
        asset(
          join(
            nodes,
            entry.name,
            "lib/node_modules/@jmfederico/pi-web/node_modules/@xterm",
          ),
        ),
      );
    }
  }
  const xterm = candidates.find((candidate) => existsSync(candidate));
  if (!xterm) {
    throw new Error(
      `Terminal emulator QA needs existing xterm browser assets. Set XTERM_ROOT to an @xterm directory containing xterm/lib/xterm.js, or provision .build/qa-deps/@xterm. Searched: ${candidates.join(", ")}. This test does not install dependencies.`,
    );
  }
  return { chrome, xterm, unicode11 };
}
