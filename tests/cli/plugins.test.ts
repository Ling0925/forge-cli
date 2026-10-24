import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessService } from "@forge/core/shared/contracts";
import { ForgeError } from "@forge/core/shared/errors";
import type {
  PluginConfigureInput,
  PluginRecord,
} from "@forge/core/shared/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIO, runCliWithIO } from "../../src/cli/cli";
import { extendedService } from "./service-fixture";

const browserManifest: PluginRecord["manifest"] = {
  id: "browser",
  name: "Agent Browser",
  version: "1.0.0",
  apiVersion: 1,
  description: "Official browser automation plugin.",
  builtin: true,
  capabilities: ["browser", "tools"],
  configSchema: {},
};
const browserRecord: PluginRecord = {
  manifest: browserManifest,
  enabled: false,
  config: {
    executablePath: "agent-browser",
    browserExecutablePath: "",
    allowedDomains: [],
  },
  status: "disabled",
  activeSessions: 0,
};
const enabledRecord: PluginRecord = {
  ...browserRecord,
  enabled: true,
  config: { ...browserRecord.config, allowedDomains: ["example.com"] },
  status: "configured",
};
const dangerousCache: readonly PluginRecord[] = [
  browserRecord,
  {
    manifest: {
      id: "other-plugin",
      name: "Other",
      version: "0.1.0",
      apiVersion: 1,
      description: "Second plugin.",
      builtin: false,
      capabilities: ["tools"],
      configSchema: {},
    },
    enabled: false,
    config: {},
    status: "disabled",
    activeSessions: 0,
  },
];

const temporary: string[] = [];
const originalHome = process.env.FORGE_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalHome;
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const directory = async (label: string): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), `forge-${label}-`));
  temporary.push(path);
  return path;
};

const ioFixture = () => {
  const output: string[] = [];
  const diagnostics: string[] = [];
  let interrupt: () => void = () => {};
  const io: CliIO = {
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      diagnostics.push(text);
    },
    isTTY: false,
    readStdin: async () => {
      throw new Error("plugins must never read stdin");
    },
    question: async () => {
      throw new Error("plugins must never prompt");
    },
    onInterrupt: (callback) => {
      interrupt = callback;
      return () => {
        interrupt = () => {};
      };
    },
  };
  return {
    io,
    output: () => output.join(""),
    diagnostics: () => diagnostics.join(""),
    reset: () => {
      output.length = 0;
      diagnostics.length = 0;
    },
    interrupt: () => interrupt(),
  };
};

interface PluginState {
  readonly records: PluginRecord[];
  readonly configured: PluginConfigureInput[];
  readonly checked: string[];
  starts: number;
}

const serviceFixture = (records: readonly PluginRecord[] = [browserRecord]) => {
  const state: PluginState = {
    records: [...records],
    configured: [],
    checked: [],
    starts: 0,
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("Plugin commands must not start a run or session.");
  };
  const snapshot: HarnessService["getDiagnostics"] = async () => ({
    transcriptChars: 0,
    projectedChars: 0,
    messageCount: 0,
    summaryFallback: false,
  });
  const service: HarnessService = {
    ...extendedService(),
    cancelSession: async () => false,
    getSettings: unexpected,
    updateSettings: unexpected,
    listModels: async () => [],
    listSessions: async () => [],
    createSession: unexpected,
    getSession: unexpected,
    run: unexpected,
    compactSession: unexpected,
    forkSession: unexpected,
    renameSession: unexpected,
    archiveSession: unexpected,
    getDiagnostics: snapshot,
    dispose: async () => {},
    listPlugins: async () => {
      state.starts += 1;
      return state.records;
    },
    configurePlugin: async (input) => {
      state.configured.push(input);
      const current =
        state.records.find((record) => record.manifest.id === input.pluginId) ??
        browserRecord;
      return {
        ...current,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.config === undefined ? {} : { config: input.config }),
        status: input.enabled === false ? "disabled" : "configured",
      };
    },
    checkPlugin: async (pluginId) => {
      state.checked.push(pluginId);
      return { pluginId, status: "ready", message: "agent-browser 1.0.0" };
    },
    browser: async () => {
      throw new Error("Plugin health checks must not open a browser.");
    },
  };
  return { service, state };
};

const writeConfig = async (root: string, value: unknown): Promise<string> => {
  const path = join(root, "plugin-config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
};

describe("forge plugins", () => {
  it("lists and shows records without starting plugins or touching FORGE_HOME", async () => {
    const home = await directory("plugins-home");
    process.env.FORGE_HOME = home;
    const list = ioFixture();
    const { service, state } = serviceFixture();
    expect(
      await runCliWithIO(["plugins", "list", "--json"], service, list.io),
    ).toBe(0);
    expect(JSON.parse(list.output())).toEqual([browserRecord]);
    expect(state.checked).toEqual([]);
    expect(state.configured).toEqual([]);
    expect(await readdir(home)).toEqual([]);

    const show = ioFixture();
    expect(
      await runCliWithIO(
        ["plugins", "show", "browser"],
        service,
        show.io,
      ),
    ).toBe(0);
    expect(JSON.parse(show.output())).toMatchObject({
      manifest: { id: "browser", builtin: true },
      status: "disabled",
      activeSessions: 0,
    });
    expect(state.checked).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it("reports unknown plugin ids and unexpected arguments without side effects", async () => {
    const f = ioFixture();
    const { service, state } = serviceFixture();
    expect(
      await runCliWithIO(["plugins", "show", "missing"], service, f.io),
    ).toBe(1);
    expect(f.diagnostics()).toBe("not_found: Plugin not found.\n");
    expect(
      await runCliWithIO(["plugins", "list", "extra"], service, f.io),
    ).toBe(1);
    expect(
      await runCliWithIO(["plugins", "enable", "one", "two"], service, f.io),
    ).toBe(1);
    expect(f.diagnostics()).toContain("Exactly one plugin id is required");
    expect(state.configured).toEqual([]);
    expect(state.checked).toEqual([]);
  });

  it("configures only from the explicit --config file and leaves FORGE_HOME alone", async () => {
    const home = await directory("plugins-home");
    process.env.FORGE_HOME = home;
    const f = ioFixture();
    const { service, state } = serviceFixture();
    const config = {
      executablePath: "agent-browser",
      browserExecutablePath: "/opt/chromium",
      allowedDomains: ["example.com", "*.example.org"],
    };
    const path = await writeConfig(home, config);
    expect(
      await runCliWithIO(
        ["plugins", "configure", "browser", "--config", path, "--json"],
        service,
        f.io,
      ),
    ).toBe(0);
    expect(state.configured).toEqual([{ pluginId: "browser", config }]);
    expect(JSON.parse(f.output())).toMatchObject({ enabled: false, config });
    expect((await readdir(home)).sort()).toEqual(["plugin-config.json"]);
    expect(f.diagnostics()).toBe("");

    // The plugin path keeps browserExecutablePath and the explicit "*" grant.
    const allHosts = {
      executablePath: "agent-browser",
      browserExecutablePath: "/usr/bin/chromium",
      allowedDomains: ["*"],
    };
    const allHostsPath = await writeConfig(home, allHosts);
    f.reset();
    expect(
      await runCliWithIO(
        ["plugins", "configure", "browser", "--config", allHostsPath, "--json"],
        service,
        f.io,
      ),
    ).toBe(0);
    expect(state.configured[1]).toEqual({
      pluginId: "browser",
      config: allHosts,
    });
    expect(JSON.parse(f.output())).toMatchObject({ config: allHosts });
  });

  it("rejects missing, non-regular and non-object configuration before calling Core", async () => {
    const home = await directory("plugins-home");
    const f = ioFixture();
    const { service, state } = serviceFixture();
    const run = (argv: readonly string[]) => runCliWithIO(argv, service, f.io);
    expect(await run(["plugins", "configure", "browser"])).toBe(1);
    expect(f.diagnostics()).toContain("--config JSON_FILE");
    expect(
      await run([
        "plugins",
        "configure",
        "browser",
        "--config",
        join(home, "absent.json"),
      ]),
    ).toBe(1);
    expect(f.diagnostics()).toContain("could not be opened");
    expect(f.diagnostics()).not.toContain(home);
    expect(
      await run(["plugins", "configure", "browser", "--config", home]),
    ).toBe(1);
    expect(f.diagnostics()).toContain("regular file");
    for (const value of ["not-json", "[]", '"text"', "null"]) {
      const path = join(home, "invalid.json");
      await writeFile(path, value);
      expect(
        await run(["plugins", "configure", "browser", "--config", path]),
      ).toBe(1);
    }
    expect(state.configured).toEqual([]);
    expect(state.starts).toBe(0);
    expect(f.output()).toBe("");
    const invalid = ioFixture();
    expect(
      await runCliWithIO(
        [
          "plugins",
          "configure",
          "browser",
          "--config",
          "x",
          "--config",
          "y",
        ],
        service,
        invalid.io,
      ),
    ).toBe(1);
    expect(invalid.diagnostics()).toContain("more than once");
  });

  it("rejects over-limit configuration files without forwarding them to Core", async () => {
    const home = await directory("plugins-large-config");
    const path = join(home, "large.json");
    await writeFile(path, `{"value":"${"x".repeat(1024 * 1024)}"}`);
    const f = ioFixture();
    const { service, state } = serviceFixture();
    expect(await runCliWithIO(["plugins", "configure", "browser", "--config", path], service, f.io)).toBe(1);
    expect(f.diagnostics()).toContain("exceeds 1 MiB");
    expect(state.configured).toEqual([]);
  });

  it("forwards enable and disable as enabled-only updates so Core validates the domains", async () => {
    const f = ioFixture();
    const { service, state } = serviceFixture([enabledRecord]);
    expect(
      await runCliWithIO(
        ["plugins", "disable", "browser", "--json"],
        service,
        f.io,
      ),
    ).toBe(0);
    expect(JSON.parse(f.output())).toMatchObject({
      enabled: false,
      status: "disabled",
    });
    f.reset();
    expect(
      await runCliWithIO(
        ["plugins", "enable", "browser", "--json"],
        service,
        f.io,
      ),
    ).toBe(0);
    expect(JSON.parse(f.output())).toMatchObject({ enabled: true });
    expect(state.configured).toEqual([
      { pluginId: "browser", enabled: false },
      { pluginId: "browser", enabled: true },
    ]);
    expect(state.checked).toEqual([]);
  });

  it("surfaces the Core rejection when enabling without allowed domains", async () => {
    const f = ioFixture();
    const { service } = serviceFixture([dangerousCache[0] as PluginRecord]);
    service.configurePlugin = async () => {
      throw new ForgeError(
        "invalid_input",
        "agent-browser requires non-empty allowedDomains.",
      );
    };
    expect(
      await runCliWithIO(["plugins", "enable", "browser"], service, f.io),
    ).toBe(1);
    expect(f.diagnostics()).toBe(
      "invalid_input: agent-browser requires non-empty allowedDomains.\n",
    );
  });

  it("checks plugin health explicitly without visiting pages", async () => {
    const f = ioFixture();
    const { service, state } = serviceFixture(dangerousCache);
    expect(
      await runCliWithIO(
        ["plugins", "check", "browser", "--json"],
        service,
        f.io,
      ),
    ).toBe(0);
    expect(JSON.parse(f.output())).toEqual({
      pluginId: "browser",
      status: "ready",
      message: "agent-browser 1.0.0",
    });
    expect(state.checked).toEqual(["browser"]);
    expect(state.configured).toEqual([]);
  });

  it("exits non-zero when the diagnostic reports the plugin unavailable", async () => {
    const f = ioFixture();
    const { service } = serviceFixture();
    service.checkPlugin = async (pluginId) => ({
      pluginId,
      status: "unavailable",
      message: "agent-browser executable missing",
    });
    expect(
      await runCliWithIO(
        ["plugins", "check", "browser", "--json"],
        service,
        f.io,
      ),
    ).toBe(1);
    expect(JSON.parse(f.output())).toMatchObject({ status: "unavailable" });
  });

  it("reports hosts without plugin administration", async () => {
    const f = ioFixture();
    const { service } = serviceFixture();
    // Older hosts simply omit the optional methods.
    const unavailable = Object.fromEntries(
      Object.entries(service).filter(
        ([name]) =>
          !["listPlugins", "configurePlugin", "checkPlugin"].includes(name),
      ),
    ) as unknown as HarnessService;
    expect(await runCliWithIO(["plugins", "list"], unavailable, f.io)).toBe(1);
    expect(f.diagnostics()).toContain("Plugins are unavailable on this host.");
    expect(
      await runCliWithIO(
        ["plugins", "check", "browser"],
        unavailable,
        f.io,
      ),
    ).toBe(1);
    expect(f.diagnostics()).toContain("Plugins are unavailable on this host.");
  });

  it("rejects unknown commands and options", async () => {
    const f = ioFixture();
    const { service } = serviceFixture();
    expect(
      await runCliWithIO(["plugins", "remove", "browser"], service, f.io),
    ).toBe(1);
    expect(f.diagnostics()).toContain("Unknown plugins command");
    expect(
      await runCliWithIO(["plugins", "list", "--verbose"], service, f.io),
    ).toBe(1);
    expect(f.diagnostics()).toContain("Unknown option");
    expect(await runCliWithIO(["plugins", "list", "-j"], service, f.io)).toBe(
      1,
    );
    expect(f.diagnostics()).toContain("Unknown option");
  });

  it("documents the domain, lifecycle and installation boundaries without starting Core", async () => {
    const f = ioFixture();
    const { service, state } = serviceFixture();
    expect(await runCliWithIO(["plugins", "--help"], service, f.io)).toBe(0);
    const text = f.output();
    expect(text).toContain("forge plugins configure <id> --config <JSON_FILE>");
    expect(text).toContain("not exact");
    expect(text).toContain("HTTP(S) origins");
    expect(text).toContain("never installs");
    expect(text).toContain("closes browser sessions");
    expect(text).toContain("never opens or visits pages");
    expect(text).toContain('allowedDomains to ["*"]');
    expect(text).toContain("an empty list grants no access");
    expect(text).toContain('"allowedDomains":["example.com"]');
    expect(state.starts).toBe(0);

    const top = ioFixture();
    expect(await runCliWithIO(["--help"], service, top.io)).toBe(0);
    expect(top.output()).toContain("forge plugins list|show <id>");
    expect(top.output()).toContain(
      "forge plugins configure <id> --config JSON_FILE",
    );
    expect(top.output()).toContain("not exact origins");
    expect(top.output()).toContain('allowedDomains to ["*"]');
    expect(state.starts).toBe(0);
  });
});
