import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIO, runCliWithIO } from "../../src/cli/cli";
import {
  createEventRenderer,
  providerAttemptLine,
} from "../../src/cli/render/events";
import type { HarnessService } from "../../src/shared/contracts";
import type {
  ModelAccessRequest,
  ModelAccessResult,
  ProviderAttempt,
} from "../../src/shared/model-access";
import {
  defaultPublicSettings,
  parseSessionId,
  publicProviderSourceSchema,
  publicSettingsSchema,
  sessionSnapshotSchema,
} from "../../src/shared/schemas";
import type {
  ConfigureInput,
  CreateSessionInput,
  RunInput,
  SessionSnapshot,
} from "../../src/shared/schemas";
import { extendedService } from "./service-fixture";

const id = parseSessionId("20000000-0000-4000-8000-000000000001");
const timestamp = "2026-01-01T00:00:00.000Z";
const group = {
  id: "route-one",
  label: "Route one",
  strategy: "order" as const,
  members: [{ sourceId: "primary", model: "primary-1" }],
};
const primarySource = publicProviderSourceSchema.parse({
  id: "primary",
  label: "Primary",
  baseUrl: "https://api.example.test/v1",
  model: "primary-1",
  apiMode: "chat-completions",
  revision: 2,
  hasApiKey: true,
  credentials: [
    {
      id: "key-one",
      label: "Key one",
      enabled: true,
      type: "api-key",
      status: "ready",
    },
    {
      id: "account-one",
      label: "Account one",
      enabled: true,
      type: "account",
      status: "ready",
      platform: "codex",
    },
  ],
});
const settings = publicSettingsSchema.parse({
  ...defaultPublicSettings,
  providerSources: [primarySource],
  routeGroups: [group],
  activeSourceId: "primary",
});
const snapshot: SessionSnapshot = sessionSnapshotSchema.parse({
  version: 1,
  id,
  title: "Fixture",
  workspace: "/tmp",
  model: "primary-1",
  createdAt: timestamp,
  updatedAt: timestamp,
  status: "completed",
  messages: [],
  events: [],
  changes: [],
});
const snapshotFor = (workspace: string): SessionSnapshot =>
  sessionSnapshotSchema.parse({ ...snapshot, workspace });
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "forge-provider-cli-"));
  directories.push(path);
  return path;
};

const ioFixture = (stdin = "") => {
  const output: string[] = [];
  const diagnostics: string[] = [];
  let interrupt: () => void = () => {};
  const reads: number[] = [];
  const io: CliIO = {
    stdout: (text) => {
      output.push(text);
    },
    stderr: (text) => {
      diagnostics.push(text);
    },
    isTTY: false,
    readStdin: async (limit) => {
      reads.push(limit);
      return stdin;
    },
    question: async () => {
      throw new Error("Unexpected approval prompt");
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
    output,
    diagnostics,
    reads,
    interrupt: () => interrupt(),
  };
};

interface ServiceState {
  settings: ReturnType<typeof publicSettingsSchema.parse>;
  updates: ConfigureInput[];
  accessCalls: ModelAccessRequest[];
  catalogCalls: Array<{
    sourceId?: string | undefined;
    refresh?: boolean | undefined;
  }>;
  creates: CreateSessionInput[];
  runs: RunInput[];
  disposals: number;
}

const serviceFixture = (
  options: Readonly<{
    access?: (
      input: ModelAccessRequest,
      signal?: AbortSignal,
    ) => Promise<ModelAccessResult>;
    overrides?: Partial<HarnessService>;
    onUpdate?: (
      input: ConfigureInput,
    ) => ReturnType<typeof publicSettingsSchema.parse>;
  }> = {},
) => {
  const state: ServiceState = {
    settings,
    updates: [],
    accessCalls: [],
    catalogCalls: [],
    creates: [],
    runs: [],
    disposals: 0,
  };
  let access =
    options.access ??
    (async () => {
      throw new Error("Unexpected model access request");
    });
  const service: HarnessService = {
    ...extendedService(),
    cancelSession: async () => false,
    getSettings: async () => state.settings,
    updateSettings: async (input) => {
      state.updates.push(input);
      if (options.onUpdate) state.settings = options.onUpdate(input);
      return state.settings;
    },
    modelAccess: async (input, signal) => {
      state.accessCalls.push(input);
      return access(input, signal);
    },
    listModels: async () => ["primary-1"],
    listModelCatalog: async (_signal, sourceId, refresh) => {
      state.catalogCalls.push({ sourceId, refresh });
      return [
        {
          id: "primary-1",
          contextWindowTokens: 128000,
          displayName: "Primary One",
          tools: true,
        },
      ];
    },
    createSession: async (input) => {
      state.creates.push(input);
      return snapshotFor(input.workspace);
    },
    getSession: async () => snapshot,
    listSessions: async () => [],
    run: async (input, sink) => {
      state.runs.push(input);
      sink({
        type: "run_finished",
        sessionId: id,
        timestamp,
        status: "completed",
        turns: 1,
        toolCalls: 0,
      });
      return snapshot;
    },
    compactSession: async () => snapshot,
    forkSession: async () => snapshot,
    renameSession: async () => snapshot,
    archiveSession: async () => snapshot,
    getDiagnostics: async () => ({
      transcriptChars: 0,
      projectedChars: 0,
      messageCount: 0,
      summaryFallback: false,
    }),
    dispose: async () => {
      state.disposals += 1;
    },
    ...options.overrides,
  };
  return {
    service,
    state,
    setAccess: (
      next: (
        input: ModelAccessRequest,
        signal?: AbortSignal,
      ) => Promise<ModelAccessResult>,
    ) => {
      access = next;
    },
  };
};

describe("provider and route management CLI", () => {
  it("shows scoped help without reading or printing input bodies", async () => {
    const f = ioFixture('{"apiKey":"must-not-print"}');
    const fixture = serviceFixture();
    expect(
      await runCliWithIO(
        ["providers", "save", "--help"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(f.output.join("")).toContain("forge providers save");
    expect(f.diagnostics.join("")).toBe("");
    expect(f.reads).toHaveLength(0);
    expect(f.output.join("")).not.toContain("must-not-print");
    const routes = ioFixture();
    expect(
      await runCliWithIO(["routes", "--help"], fixture.service, routes.io),
    ).toBe(0);
    expect(routes.output.join("")).toContain("forge routes save");
  });

  it("saves a source JSON payload with private fields without echoing them", async () => {
    const root = await directory();
    const secret = "fixture-secret-api-key";
    const accountToken = "fixture-account-token";
    const header = "Bearer fixture-private-header";
    const input = {
      sources: [
        {
          type: "save",
          source: {
            id: "alpha",
            label: "Alpha",
            baseUrl: "https://alpha.example.test/v1",
            model: "alpha-1",
            apiMode: "chat-completions",
            preset: "vendor",
            activeCredentialId: "account-one",
            credentialRouting: "rotate",
            sticky: true,
          },
          expectedRevision: 7,
          apiKey: secret,
          credentials: [
            {
              id: "key-one",
              label: "Key one",
              enabled: true,
              type: "api-key",
              apiKey: secret,
            },
            {
              id: "account-one",
              label: "Account one",
              enabled: true,
              type: "account",
              account: {
                platform: "codex",
                accessToken: accountToken,
              },
            },
          ],
          connection: {
            headers: { Authorization: header },
            proxyUrl: "socks5://127.0.0.1:1080",
          },
        },
      ],
    };
    const path = join(root, "sources.json");
    await writeFile(path, JSON.stringify(input));
    const f = ioFixture();
    const fixture = serviceFixture();
    expect(
      await runCliWithIO(
        ["providers", "save", "--input", path, "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    const operation = fixture.state.updates[0]?.sources?.[0];
    if (operation?.type !== "save") throw new Error("expected a source save");
    expect(operation.expectedRevision).toBe(7);
    expect(operation.apiKey).toBe(secret);
    expect(operation.source).toMatchObject({
      id: "alpha",
      preset: "vendor",
      credentialRouting: "rotate",
      sticky: true,
    });
    expect(operation.credentials).toHaveLength(2);
    expect(operation.connection?.headers?.Authorization).toBe(header);
    expect(f.reads).toHaveLength(0);
    const printed = [...f.output, ...f.diagnostics].join("");
    expect(printed).not.toContain(secret);
    expect(printed).not.toContain(accountToken);
    expect(printed).not.toContain(header);
    expect(printed).not.toContain("apiKey");

    const operationPath = join(root, "operation.json");
    await writeFile(
      operationPath,
      JSON.stringify({
        type: "save",
        expectedRevision: 8,
        source: {
          id: "gamma",
          label: "Gamma",
          baseUrl: "https://gamma.example.test/v1",
          model: "gamma-1",
        },
        apiKey: secret,
      }),
    );
    const single = ioFixture();
    expect(
      await runCliWithIO(
        ["providers", "save", "--input", operationPath, "--json"],
        fixture.service,
        single.io,
      ),
    ).toBe(0);
    const singleOperation = fixture.state.updates.at(-1)?.source;
    if (singleOperation?.type !== "save")
      throw new Error("expected a single source save");
    expect(singleOperation.expectedRevision).toBe(8);
    expect(singleOperation.apiKey).toBe(secret);
    expect(single.output.join("")).not.toContain(secret);
  });

  it("accepts explicit source options and a key from stdin with expectedRevision", async () => {
    const f = ioFixture("fixture-explicit-key\n");
    const fixture = serviceFixture();
    expect(
      await runCliWithIO(
        [
          "providers",
          "save",
          "--id",
          "beta",
          "--label",
          "Beta",
          "--base-url",
          "https://beta.example.test/v1",
          "--model",
          "beta-1",
          "--api-mode",
          "responses",
          "--preset",
          "custom",
          "--expected-revision",
          "0",
          "--api-key-stdin",
          "--json",
        ],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    const operation = fixture.state.updates[0]?.source;
    if (operation?.type !== "save") throw new Error("expected a source save");
    expect(operation.expectedRevision).toBe(0);
    expect(operation.apiKey).toBe("fixture-explicit-key");
    expect(operation.source).toMatchObject({
      id: "beta",
      model: "beta-1",
      apiMode: "responses",
      preset: "custom",
    });
    expect(f.reads).toEqual([16_386]);
    expect(f.output.join("")).not.toContain("fixture-explicit-key");
    expect(f.diagnostics.join("")).not.toContain("fixture-explicit-key");
  });

  it("keeps the legacy models contract and exposes rich details on request", async () => {
    const legacy = ioFixture();
    const legacyFixture = serviceFixture();
    expect(
      await runCliWithIO(
        ["models", "--json"],
        legacyFixture.service,
        legacy.io,
      ),
    ).toBe(0);
    expect(legacy.output.join("")).toBe('["primary-1"]\n');

    const details = ioFixture();
    const detailsFixture = serviceFixture({
      access: async (request) => {
        if (request.type !== "catalog") throw new Error("unexpected request");
        return {
          type: "catalog",
          sourceId: request.sourceId,
          models: [
            {
              id: "primary-1",
              contextWindowTokens: 128000,
              displayName: "Primary One",
              tools: true,
            },
          ],
        };
      },
    });
    expect(
      await runCliWithIO(
        ["models", "--details", "--source", "primary", "--refresh", "--json"],
        detailsFixture.service,
        details.io,
      ),
    ).toBe(0);
    expect(detailsFixture.state.accessCalls).toEqual([
      { type: "catalog", sourceId: "primary", refresh: true },
    ]);
    expect(JSON.parse(details.output.join(""))).toEqual([
      {
        id: "primary-1",
        contextWindowTokens: 128000,
        displayName: "Primary One",
        tools: true,
      },
    ]);
  });

  it("does not present a failed refresh as successful or echo upstream errors", async () => {
    const fixture = serviceFixture({ access: async request => {
      if (request.type !== "catalog") throw new Error("unexpected request");
      return { type: "catalog", sourceId: request.sourceId, models: [], stale: true, error: "fixture-private-upstream-error" };
    } });
    for (const args of [["providers", "catalog", "primary", "--refresh"], ["models", "--details", "--source", "primary", "--refresh"]]) {
      const f = ioFixture();
      expect(await runCliWithIO(args, fixture.service, f.io)).toBe(1);
      expect(f.diagnostics.join("")).toContain("last successful catalog is retained");
      expect([...f.output, ...f.diagnostics].join("")).not.toContain("fixture-private");
    }
  });

  it("routes preset, catalog and test requests through modelAccess", async () => {
    const f = ioFixture();
    const fixture = serviceFixture({
      access: async (request) => {
        if (request.type === "presets")
          return {
            type: "presets",
            presets: [
              {
                id: "local",
                name: "Local",
                kind: "local",
                endpoints: { "chat-completions": "http://127.0.0.1:8080/v1" },
                noKey: true,
              },
            ],
          };
        if (request.type === "catalog")
          return {
            type: "catalog",
            sourceId: request.sourceId,
            models: [{ id: "primary-1", contextWindowTokens: null }],
          };
        if (request.type === "test")
          return {
            type: "test",
            sourceId: request.sourceId,
            kind: request.kind,
            ok: true,
            latencyMs: 4,
            model: request.model,
          };
        throw new Error("unexpected request");
      },
    });
    expect(
      await runCliWithIO(
        ["providers", "presets", "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(
      await runCliWithIO(
        [
          "providers",
          "catalog",
          "primary",
          "--credential",
          "key-one",
          "--json",
        ],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(
      await runCliWithIO(
        [
          "providers",
          "test",
          "primary",
          "--kind",
          "inference",
          "--model",
          "primary-1",
          "--json",
        ],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(fixture.state.accessCalls).toEqual([
      { type: "presets" },
      {
        type: "catalog",
        sourceId: "primary",
        credentialId: "key-one",
        refresh: false,
      },
      {
        type: "test",
        sourceId: "primary",
        kind: "inference",
        model: "primary-1",
      },
    ]);
  });

  it("previews an explicit import and only applies selected source ids", async () => {
    const f = ioFixture('{"apiKey":"fixture-import-secret"}');
    const fixture = serviceFixture({
      access: async (request) => {
        if (request.type === "import-preview") {
          expect(request.text).toContain("fixture-import-secret");
          return {
            type: "import-preview",
            previewId: "preview-one",
            warnings: ["one warning"],
            sources: [
              {
                id: "imported",
                label: "Imported",
                baseUrl: "https://imported.example.test/v1",
                model: "imported-1",
                credentialCount: 1,
                warnings: [],
              },
            ],
          };
        }
        if (request.type === "import-apply")
          return { type: "import-apply", applied: request.sourceIds };
        throw new Error("unexpected request");
      },
    });
    expect(
      await runCliWithIO(
        ["providers", "import", "--stdin", "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(fixture.state.accessCalls).toEqual([
      {
        type: "import-preview",
        text: '{"apiKey":"fixture-import-secret"}',
      },
    ]);
    const previewOutput = f.output.join("");
    expect(previewOutput).not.toContain("fixture-import-secret");
    expect(JSON.parse(previewOutput).previewId).toBe("preview-one");
    expect(fixture.state.updates).toHaveLength(0);

    const apply = ioFixture('{"apiKey":"fixture-import-secret"}');
    expect(
      await runCliWithIO(
        [
          "providers",
          "import",
          "--stdin",
          "--apply",
          "--source",
          "imported",
          "--json",
        ],
        fixture.service,
        apply.io,
      ),
    ).toBe(0);
    expect(fixture.state.accessCalls.at(-1)).toEqual({
      type: "import-apply",
      previewId: "preview-one",
      sourceIds: ["imported"],
    });
    expect(apply.output.join("")).not.toContain("fixture-import-secret");
  });

  it("lists, saves and removes route groups through updateSettings", async () => {
    const f = ioFixture();
    const fixture = serviceFixture();
    expect(
      await runCliWithIO(["routes", "list", "--json"], fixture.service, f.io),
    ).toBe(0);
    expect(JSON.parse(f.output.join(""))).toEqual([group]);

    const routeInput = {
      id: "route-two",
      label: "Route two",
      strategy: "rotate",
      members: [{ sourceId: "primary", model: "primary-1" }],
    };
    const save = ioFixture(JSON.stringify({ group: routeInput }));
    expect(
      await runCliWithIO(
        ["routes", "save", "--stdin", "--json"],
        fixture.service,
        save.io,
      ),
    ).toBe(0);
    expect(fixture.state.updates.at(-1)).toEqual({
      route: { type: "save", group: routeInput },
    });
    expect(JSON.parse(save.output.join(""))).toMatchObject({ id: "route-two" });

    expect(
      await runCliWithIO(
        ["routes", "remove", "route-two", "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(fixture.state.updates.at(-1)).toEqual({
      route: { type: "remove", id: "route-two" },
    });
  });

  it("starts login, prints the URL/code and polls until done", async () => {
    const f = ioFixture();
    const login = {
      loginId: "login-one",
      platform: "codex" as const,
      mode: "device" as const,
      status: "waiting" as const,
      expiresAt: Date.now() + 10,
      verificationUrl: "https://login.example.test/device",
      userCode: "ABCD-EFGH",
    };
    const fixture = serviceFixture({
      access: async (request) => {
        if (request.type === "login-start")
          return { type: "login-start", login };
        if (request.type === "login-poll")
          return {
            type: "login-poll",
            login: {
              ...login,
              status: "done",
              credentialId: "account-one",
              account: { platform: "codex", user: "fixture" },
            },
          };
        throw new Error("unexpected request");
      },
    });
    expect(
      await runCliWithIO(
        ["providers", "login", "primary", "codex", "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    const lines = f.output
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ type: "login-start", login });
    expect(lines[1]).toMatchObject({
      type: "login-poll",
      login: { status: "done", credentialId: "account-one" },
    });
    expect(fixture.state.accessCalls.map((request) => request.type)).toEqual([
      "login-start",
      "login-poll",
    ]);
    expect(f.diagnostics.join("")).not.toContain("ABCD-EFGH");
  });

  it("removes a source and requests quota only for an explicit quota command", async () => {
    const f = ioFixture();
    const fixture = serviceFixture({
      access: async (request) => {
        if (request.type !== "quota") throw new Error("unexpected request");
        return {
          type: "quota",
          quota: {
            platform: "codex",
            updatedAt: 1,
            windows: [],
          },
        };
      },
    });
    expect(
      await runCliWithIO(
        ["providers", "remove", "primary", "--json"],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(fixture.state.updates.at(-1)).toEqual({
      source: { type: "remove", id: "primary" },
    });
    expect(fixture.state.accessCalls).toHaveLength(0);

    const quota = ioFixture();
    expect(
      await runCliWithIO(
        [
          "providers",
          "quota",
          "primary",
          "--credential",
          "account-one",
          "--json",
        ],
        fixture.service,
        quota.io,
      ),
    ).toBe(0);
    expect(fixture.state.accessCalls).toEqual([
      { type: "quota", sourceId: "primary", credentialId: "account-one" },
    ]);
    expect(JSON.parse(quota.output.join(""))).toMatchObject({
      platform: "codex",
      windows: [],
    });
  });

  it("cancels an interrupted login, disposes the service and exits 130", async () => {
    const f = ioFixture();
    let started: () => void = () => {};
    const startSeen = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fixture = serviceFixture({
      access: async (request) => {
        if (request.type === "login-start") {
          started();
          return {
            type: "login-start",
            login: {
              loginId: "login-two",
              platform: "copilot",
              mode: "device",
              status: "waiting",
              expiresAt: Date.now() + 60_000,
              verificationUrl: "https://login.example.test/two",
              userCode: "CODE-TWO",
            },
          };
        }
        if (request.type === "login-cancel")
          return {
            type: "login-cancel",
            login: {
              loginId: "login-two",
              platform: "copilot",
              mode: "device",
              status: "canceled",
              expiresAt: Date.now() + 60_000,
            },
          };
        throw new Error("unexpected request");
      },
    });
    const pending = runCliWithIO(
      ["providers", "login", "primary", "copilot"],
      fixture.service,
      f.io,
    );
    await startSeen;
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.interrupt();
    expect(await pending).toBe(130);
    expect(fixture.state.accessCalls.map((request) => request.type)).toEqual([
      "login-start",
      "login-cancel",
    ]);
    expect(fixture.state.disposals).toBe(1);
    expect(f.diagnostics.join("")).toContain("login cancelled");
  });

  it("passes an explicit route group while keeping the ordinary model exact", async () => {
    const root = await directory();
    const f = ioFixture();
    const fixture = serviceFixture();
    expect(
      await runCliWithIO(
        [
          "run",
          "hello",
          "--workspace",
          root,
          "--model",
          "exact-model",
          "--route-group",
          "route-one",
        ],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    expect(fixture.state.creates[0]).toMatchObject({
      model: "exact-model",
      routeGroupId: "route-one",
    });
    expect(fixture.state.runs[0]).toMatchObject({
      model: "exact-model",
      routeGroupId: "route-one",
    });
  });

  it("renders a provider attempt with identity and outcome in plain and rich modes", async () => {
    const selection: ProviderAttempt = {
      sourceId: "primary",
      model: "primary-1",
      credentialId: "key-one",
      apiMode: "chat-completions",
      groupId: "route-one",
      attempt: 2,
      reason: "group",
      outcome: "failed",
      timestamp,
      errorCode: "provider_error",
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    };
    const rich = providerAttemptLine(selection, 200)
      .map((span) => span.text)
      .join("");
    expect(rich).toContain("primary");
    expect(rich).toContain("primary-1");
    expect(rich).toContain("key-one");
    expect(rich).toContain("route-one");
    expect(rich).toContain("failed");
    expect(rich).not.toContain("apiKey");

    const renderer = createEventRenderer();
    const update = renderer.push({
      type: "provider_attempt",
      sessionId: id,
      timestamp,
      selection,
    });
    expect(
      update.append
        .map((line) => line.map((span) => span.text).join(""))
        .join("\n"),
    ).toContain("credential key-one");

    const root = await directory();
    const f = ioFixture();
    const fixture = serviceFixture();
    fixture.service.run = async (input, sink) => {
      fixture.state.runs.push(input);
      sink({ type: "provider_attempt", sessionId: id, timestamp, selection });
      sink({
        type: "run_finished",
        sessionId: id,
        timestamp,
        status: "completed",
        turns: 1,
        toolCalls: 0,
      });
      return snapshot;
    };
    expect(
      await runCliWithIO(
        ["run", "hello", "--workspace", root],
        fixture.service,
        f.io,
      ),
    ).toBe(0);
    const plain = f.output.join("");
    expect(plain).toContain("Provider failed source=primary model=primary-1");
    expect(plain).toContain("credential=key-one");
    expect(plain).toContain("group=route-one");
    expect(plain).not.toContain("apiKey");
  });
});
