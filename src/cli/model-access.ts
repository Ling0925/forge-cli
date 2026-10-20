import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessService } from "../shared/contracts";
import { ForgeError } from "../shared/errors";
import {
  type ModelAccessRequest,
  type ModelAccessResult,
  type RouteGroup,
  accountPlatformSchema,
  routeGroupSchema,
} from "../shared/model-access";
import type { ModelCatalog } from "../shared/model-catalog";
import {
  configureInputSchema,
  parseSessionId,
  providerSourceOperationSchema,
  publicSettingsSchema,
} from "../shared/schemas";
import type {
  ConfigureInput,
  ProviderSourceOperation,
  PublicSettings,
} from "../shared/schemas";

// Match the existing host RPC envelope rather than adding a smaller CLI cap.
const privateInputLimit = 16 * 1024 * 1024;
const keyLimit = 16_386;

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
}

function invalid(message: string): never {
  throw new ForgeError("invalid_input", message);
}

const parseArgs = (
  argv: readonly string[],
  values: readonly string[],
  flags: readonly string[],
): ParsedArgs => {
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;
    if (literal || !arg.startsWith("--")) {
      if (!literal && arg.startsWith("-"))
        invalid("Unknown option. Use --help for usage.");
      positional.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    const separator = arg.indexOf("=");
    const name = arg.slice(2, separator < 0 ? undefined : separator);
    if (Object.hasOwn(options, name))
      invalid("An option was supplied more than once.");
    if (flags.includes(name) && separator < 0) {
      options[name] = true;
    } else if (values.includes(name)) {
      const value = separator < 0 ? argv[++index] : arg.slice(separator + 1);
      if (value === undefined || value.startsWith("--"))
        invalid("An option requires a value.");
      options[name] = value;
    } else {
      invalid("Unknown option. Use --help for usage.");
    }
  }
  return { positional, options };
};

const stringOption = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.options[name];
  return typeof value === "string" ? value : undefined;
};

const flag = (args: ParsedArgs, name: string): boolean =>
  args.options[name] === true;

const noPositionals = (args: ParsedArgs): void => {
  if (args.positional.length !== 0) invalid("Unexpected positional arguments.");
};

const jsonLine = (context: ModelAccessCommandContext, value: unknown): void => {
  context.stdout(`${JSON.stringify(value)}\n`);
};

const readable = (context: ModelAccessCommandContext, value: unknown): void => {
  context.stdout(`${JSON.stringify(value, null, 2)}\n`);
};

const output = (
  context: ModelAccessCommandContext,
  args: ParsedArgs,
  value: unknown,
): void => {
  if (flag(args, "json")) jsonLine(context, value);
  else readable(context, value);
};

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    invalid(`${label} must be valid JSON.`);
  }
};

const readTextFile = async (
  path: string,
  signal: AbortSignal,
): Promise<string> => {
  const file = await open(resolve(path), "r").catch(() =>
    invalid("Input file could not be opened."),
  );
  try {
    const info = await file.stat();
    if (!info.isFile()) invalid("Input must be a regular file.");
    if (info.size > privateInputLimit)
      invalid("Input file exceeds the allowed size.");
    if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
    return await file.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    invalid("Input file could not be read.");
  } finally {
    await file.close();
  }
};

const readPrivateInput = async (
  args: ParsedArgs,
  context: ModelAccessCommandContext,
  label: string,
): Promise<string> => {
  const path = stringOption(args, "input");
  const stdin = flag(args, "stdin");
  if ((path !== undefined) === stdin)
    invalid(`Use exactly one of --input FILE or --stdin for ${label}.`);
  const text =
    path === undefined
      ? await context.readStdin(privateInputLimit, context.signal)
      : await readTextFile(path, context.signal);
  if (Buffer.byteLength(text) > privateInputLimit)
    invalid("Input exceeds the allowed size.");
  if (context.signal.aborted)
    throw new ForgeError("cancelled", "Input cancelled.");
  return text;
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sourceOperation = (value: unknown): ProviderSourceOperation => {
  if (!record(value)) invalid("Each provider source must be a JSON object.");
  if (
    value.type === "save" ||
    value.type === "activate" ||
    value.type === "remove"
  )
    return providerSourceOperationSchema.parse(value);
  const { expectedRevision, apiKey, credentials, connection, ...source } =
    value;
  return providerSourceOperationSchema.parse({
    type: "save",
    source,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(connection === undefined ? {} : { connection }),
  });
};

const assertSaveOperations = (input: ConfigureInput): ConfigureInput => {
  const operations = [
    ...(input.source === undefined ? [] : [input.source]),
    ...(input.sources ?? []),
  ];
  if (operations.length === 0)
    invalid("Provider save input needs a source or sources value.");
  if (operations.some((operation) => operation.type !== "save"))
    invalid("Provider save accepts only save operations.");
  return input;
};

/**
 * Accepted inputs: a ConfigureInput with source/sources, an array of save
 * operations or raw source objects, a single save operation, or one raw source
 * object. Private apiKey/credentials/connection fields stay in this payload;
 * they are never echoed by the command.
 */
const normalizeSourceSave = (raw: unknown): ConfigureInput => {
  if (Array.isArray(raw)) {
    if (raw.length === 0) invalid("Provider save input is empty.");
    return assertSaveOperations(
      configureInputSchema.parse({ sources: raw.map(sourceOperation) }),
    );
  }
  if (!record(raw))
    invalid("Provider save input must be a JSON object or array.");
  if (raw.type === "save" || raw.type === "activate" || raw.type === "remove") {
    const operation = sourceOperation(raw);
    if (operation.type !== "save")
      invalid("Provider save accepts only save operations.");
    return configureInputSchema.parse({ source: operation });
  }
  if (
    "source" in raw ||
    "sources" in raw ||
    "settings" in raw ||
    "route" in raw ||
    ("apiKey" in raw && !("id" in raw))
  ) {
    const parsed = configureInputSchema.parse(raw);
    if (
      parsed.settings !== undefined ||
      parsed.route !== undefined ||
      parsed.apiKey !== undefined
    )
      invalid("Provider save accepts only source or sources fields.");
    return assertSaveOperations({
      ...(parsed.source === undefined ? {} : { source: parsed.source }),
      ...(parsed.sources === undefined ? {} : { sources: parsed.sources }),
    });
  }
  return assertSaveOperations(
    configureInputSchema.parse({ source: sourceOperation(raw) }),
  );
};

const normalizeRouteSave = (raw: unknown): RouteGroup => {
  if (Array.isArray(raw) || !record(raw))
    invalid("Route input must be a JSON object.");
  if (
    "route" in raw ||
    "source" in raw ||
    "sources" in raw ||
    "settings" in raw ||
    "apiKey" in raw
  ) {
    const parsed = configureInputSchema.parse(raw);
    if (
      parsed.source !== undefined ||
      parsed.sources !== undefined ||
      parsed.settings !== undefined ||
      parsed.apiKey !== undefined
    )
      invalid("Route save accepts only the route field.");
    if (parsed.route?.type === "save") return parsed.route.group;
    invalid("Route save input needs a save route operation.");
  }
  if (raw.type === "save" && "group" in raw)
    return routeGroupSchema.parse(raw.group);
  if ("group" in raw) return routeGroupSchema.parse(raw.group);
  if (raw.type === "remove") invalid("Route save cannot remove a group.");
  return routeGroupSchema.parse(raw);
};

const publicSettings = (value: PublicSettings): PublicSettings =>
  publicSettingsSchema.parse(value);

const requireAccess = (
  context: ModelAccessCommandContext,
): NonNullable<HarnessService["modelAccess"]> => {
  const access = context.service.modelAccess;
  if (!access)
    invalid("The current host does not support provider management.");
  return access;
};

const accessRequest = async (
  context: ModelAccessCommandContext,
  input: ModelAccessRequest,
  signal: AbortSignal = context.signal,
): Promise<ModelAccessResult> => {
  const access = requireAccess(context);
  return access(input, signal);
};

const closeLogin = async (
  context: ModelAccessCommandContext,
  loginId: string | undefined,
): Promise<void> => {
  if (loginId !== undefined) {
    try {
      await accessRequest(
        context,
        { type: "login-cancel", loginId },
        new AbortController().signal,
      );
    } catch {
      // Best-effort cancellation; disposal below still drops the flow.
    }
  }
  try {
    await context.dispose();
  } catch {
    // Preserve the interrupted command's exit status.
  }
};

const waitFor = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolveWait) => {
    if (signal.aborted) {
      resolveWait();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveWait();
    };
    const onAbort = (): void => finish();
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const providersHelp = `Forge provider management
  forge providers list [--json]
  forge providers presets [--json]
  forge providers catalog <source-id> [--credential ID] [--refresh] [--json]
  forge providers test <source-id> [--kind catalog|inference] [--model MODEL] [--credential ID] [--json]
  forge providers save (--input FILE | --stdin) [--json]
  forge providers save --id ID --label LABEL --base-url URL [--model MODEL]
       [--api-mode chat-completions|responses|anthropic|gemini] [--preset ID]
       [--endpoints JSON] [--model-selection JSON] [--model-aliases JSON]
       [--credential-routing order|rotate|usage|smart|pace] [--sticky]
       [--active-credential ID] [--credentials-file FILE] [--connection-file FILE]
       [--api-key-stdin] [--expected-revision NUMBER] [--json]
  forge providers remove <source-id> [--forget-session UUID[,UUID...]] [--json]
  forge providers import (--input FILE | --stdin) [--apply --source ID[,ID...]] [--json]
  forge providers login <source-id> [codex|copilot] [--label LABEL] [--json]
  forge providers quota <source-id> [--credential ID] [--json]

Provider save JSON accepts {source,sources}, a save operation, or one source
object (including private credentials and connection fields). Secrets are read
only from files or stdin, never printed; expectedRevision is preserved and
source batches are committed atomically. Import previews never write until
--apply and an explicit --source selection. Login prints the URL/code and polls
until done, failure or cancellation; it never opens a browser or fetches quota
unless that command is requested.`;

const routesHelp = `Forge route-group management
  forge routes list [--json]
  forge routes save (--input FILE | --stdin) [--json]
  forge routes remove <group-id> [--json]

Route save JSON accepts {route:{type:"save",group}}, {group}, or one route group.
Only an explicit --route-group on run selects a group; a plain --model stays an
exact model binding.`;

const saveProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(
    argv,
    [
      "input",
      "id",
      "label",
      "base-url",
      "model",
      "api-mode",
      "preset",
      "endpoints",
      "model-selection",
      "model-aliases",
      "credential-routing",
      "active-credential",
      "credentials-file",
      "connection-file",
      "expected-revision",
    ],
    ["stdin", "api-key-stdin", "sticky", "json"],
  );
  noPositionals(args);
  const inputPath = stringOption(args, "input");
  const stdinJson = flag(args, "stdin");
  const apiKeyStdin = flag(args, "api-key-stdin");
  const explicitNames = [
    "id",
    "label",
    "base-url",
    "model",
    "api-mode",
    "preset",
    "endpoints",
    "model-selection",
    "model-aliases",
    "credential-routing",
    "sticky",
    "active-credential",
    "credentials-file",
    "connection-file",
    "expected-revision",
  ];
  const hasExplicit = explicitNames.some(
    (name) => args.options[name] !== undefined,
  );
  const jsonInput = inputPath !== undefined || stdinJson;
  if (inputPath !== undefined && stdinJson)
    invalid("Use exactly one of --input FILE or --stdin.");
  if (jsonInput && hasExplicit)
    invalid("Use JSON input or explicit source options, not both.");
  if (jsonInput && apiKeyStdin)
    invalid("--api-key-stdin cannot be combined with a JSON source input.");

  let payload: ConfigureInput;
  if (inputPath !== undefined || stdinJson) {
    const text = await readPrivateInput(args, context, "provider save");
    payload = normalizeSourceSave(parseJson(text, "Provider save input"));
  } else {
    const id = stringOption(args, "id") ?? invalid("--id is required.");
    const label =
      stringOption(args, "label") ?? invalid("--label is required.");
    const baseUrl =
      stringOption(args, "base-url") ?? invalid("--base-url is required.");
    const expectedRevision = stringOption(args, "expected-revision");
    if (expectedRevision !== undefined && !/^\d+$/.test(expectedRevision))
      invalid("--expected-revision expects a non-negative integer.");
    const revision =
      expectedRevision === undefined ? undefined : Number(expectedRevision);
    if (revision !== undefined && !Number.isSafeInteger(revision))
      invalid("--expected-revision is out of range.");
    const endpoints = stringOption(args, "endpoints");
    const modelSelection = stringOption(args, "model-selection");
    const modelAliases = stringOption(args, "model-aliases");
    const credentialsFile = stringOption(args, "credentials-file");
    const connectionFile = stringOption(args, "connection-file");
    const apiMode = stringOption(args, "api-mode");
    const preset = stringOption(args, "preset");
    const credentialRouting = stringOption(args, "credential-routing");
    const activeCredentialId = stringOption(args, "active-credential");
    const apiKey = apiKeyStdin
      ? (await context.readStdin(keyLimit, context.signal)).replace(
          /(?:\r\n|\n)$/,
          "",
        )
      : undefined;
    if (context.signal.aborted)
      throw new ForgeError("cancelled", "Input cancelled.");
    const source = {
      id,
      label,
      baseUrl,
      model: stringOption(args, "model") ?? "",
      ...(apiMode === undefined ? {} : { apiMode }),
      ...(preset === undefined ? {} : { preset }),
      ...(endpoints === undefined
        ? {}
        : { endpoints: parseJson(endpoints, "--endpoints") }),
      ...(modelSelection === undefined
        ? {}
        : { modelSelection: parseJson(modelSelection, "--model-selection") }),
      ...(modelAliases === undefined
        ? {}
        : { modelAliases: parseJson(modelAliases, "--model-aliases") }),
      ...(credentialRouting === undefined ? {} : { credentialRouting }),
      ...(flag(args, "sticky") ? { sticky: true } : {}),
      ...(activeCredentialId === undefined ? {} : { activeCredentialId }),
    };
    const credentials =
      credentialsFile === undefined
        ? undefined
        : parseJson(
            await readTextFile(credentialsFile, context.signal),
            "--credentials-file",
          );
    const connection =
      connectionFile === undefined
        ? undefined
        : parseJson(
            await readTextFile(connectionFile, context.signal),
            "--connection-file",
          );
    payload = configureInputSchema.parse({
      source: {
        type: "save",
        source,
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(credentials === undefined ? {} : { credentials }),
        ...(connection === undefined ? {} : { connection }),
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      },
    });
  }
  const settings = publicSettings(
    await context.service.updateSettings(payload),
  );
  output(context, args, settings);
  return context.signal.aborted ? 130 : 0;
};

const listProviders = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  noPositionals(args);
  const settings = publicSettings(await context.service.getSettings());
  output(context, args, {
    ...(settings.activeSourceId === undefined
      ? {}
      : { activeSourceId: settings.activeSourceId }),
    sources: settings.providerSources ?? [],
  });
  return 0;
};

const listPresets = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  noPositionals(args);
  const result = await accessRequest(context, { type: "presets" });
  if (result.type !== "presets")
    invalid("Unexpected provider preset response.");
  output(context, args, result.presets);
  return 0;
};

const catalogProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["credential"], ["json", "refresh"]);
  if (args.positional.length !== 1)
    invalid("Provider catalog requires one source ID.");
  const sourceId = args.positional[0] ?? invalid("A source ID is required.");
  const models = await loadModelCatalog(context.service, context.signal, {
    sourceId,
    credentialId: stringOption(args, "credential"),
    refresh: flag(args, "refresh"),
  });
  output(context, args, models);
  return context.signal.aborted ? 130 : 0;
};

const testProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["kind", "model", "credential"], ["json"]);
  if (args.positional.length !== 1)
    invalid("Provider test requires one source ID.");
  const sourceId = args.positional[0] ?? invalid("A source ID is required.");
  const kindText = stringOption(args, "kind") ?? "catalog";
  if (kindText !== "catalog" && kindText !== "inference")
    invalid("--kind expects catalog or inference.");
  const result = await accessRequest(context, {
    type: "test",
    sourceId,
    kind: kindText,
    ...(stringOption(args, "model") === undefined
      ? {}
      : { model: stringOption(args, "model") }),
    ...(stringOption(args, "credential") === undefined
      ? {}
      : { credentialId: stringOption(args, "credential") }),
  });
  if (result.type !== "test") invalid("Unexpected provider test response.");
  if (flag(args, "json")) jsonLine(context, result);
  else {
    readable(context, result);
    if (!result.ok)
      context.stderr(
        `provider test failed: ${result.error ?? "unknown error"}\n`,
      );
  }
  return result.ok ? 0 : 1;
};

const removeProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["forget-session"], ["json"]);
  if (args.positional.length !== 1)
    invalid("Provider remove requires one source ID.");
  const id = args.positional[0] ?? invalid("A source ID is required.");
  const forgotten = stringOption(args, "forget-session");
  let forgottenSessionIds: string[] | undefined;
  if (forgotten !== undefined) {
    forgottenSessionIds = forgotten
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    if (forgottenSessionIds.length === 0)
      invalid("--forget-session expects at least one session UUID.");
    for (const sessionId of forgottenSessionIds) {
      try {
        parseSessionId(sessionId);
      } catch {
        invalid("--forget-session expects session UUIDs.");
      }
    }
  }
  const settings = publicSettings(
    await context.service.updateSettings({
      source: {
        type: "remove",
        id,
        ...(forgottenSessionIds === undefined ? {} : { forgottenSessionIds }),
      },
    }),
  );
  output(context, args, {
    removed: id,
    sources: settings.providerSources ?? [],
  });
  return 0;
};

const importProviders = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["input", "source"], ["stdin", "apply", "json"]);
  noPositionals(args);
  const text = await readPrivateInput(args, context, "provider import");
  const preview = await accessRequest(context, {
    type: "import-preview",
    text,
  });
  if (preview.type !== "import-preview")
    invalid("Unexpected provider import preview response.");
  const apply = flag(args, "apply");
  if (!apply) {
    if (stringOption(args, "source") !== undefined)
      invalid("--source is only valid with --apply.");
    output(context, args, preview);
    return context.signal.aborted ? 130 : 0;
  }
  const selected = (stringOption(args, "source") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (selected.length === 0)
    invalid("Provider import --apply requires --source ID[,ID...].");
  const applied = await accessRequest(context, {
    type: "import-apply",
    previewId: preview.previewId,
    sourceIds: [...new Set(selected)],
  });
  if (applied.type !== "import-apply")
    invalid("Unexpected provider import response.");
  output(context, args, applied);
  return context.signal.aborted ? 130 : 0;
};

const printLogin = (
  context: ModelAccessCommandContext,
  login: Extract<ModelAccessResult, { type: "login-start" }>["login"],
  prefix: string,
): void => {
  if (login.verificationUrl !== undefined)
    context.stdout(`Open this URL in your browser: ${login.verificationUrl}\n`);
  if (login.userCode !== undefined)
    context.stderr(`Login code: ${login.userCode}\n`);
  context.stdout(
    `${prefix}: ${login.status} · ${login.platform}${login.account?.user ? ` · ${login.account.user}` : ""}${login.account?.plan ? ` · ${login.account.plan}` : ""}\n`,
  );
  if (login.credentialId !== undefined)
    context.stdout(`credential=${login.credentialId}\n`);
  if (login.error !== undefined)
    context.stderr(`${login.errorCode ?? "login"}: ${login.error}\n`);
};

const loginProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["label"], ["json"]);
  if (args.positional.length < 1 || args.positional.length > 2)
    invalid(
      "Provider login requires a source ID and optional codex or copilot platform.",
    );
  const sourceId = args.positional[0] ?? invalid("A source ID is required.");
  const platform =
    args.positional[1] === undefined
      ? "codex"
      : accountPlatformSchema.parse(args.positional[1]);
  let start: ModelAccessResult;
  try {
    start = await accessRequest(context, {
      type: "login-start",
      platform,
      sourceId,
      ...(stringOption(args, "label") === undefined
        ? {}
        : { label: stringOption(args, "label") }),
    });
  } catch (error) {
    if (!context.signal.aborted) throw error;
    await closeLogin(context, undefined);
    context.stderr("login cancelled.\n");
    return 130;
  }
  if (start.type !== "login-start")
    invalid("Unexpected provider login response.");
  let current = start.login;
  if (flag(args, "json")) jsonLine(context, start);
  else printLogin(context, current, "login");
  try {
    while (current.status === "waiting" && !context.signal.aborted) {
      const remaining = current.expiresAt - Date.now();
      await waitFor(Math.max(50, Math.min(1_000, remaining)), context.signal);
      if (context.signal.aborted) break;
      if (Date.now() >= current.expiresAt) {
        // Give the service one chance to settle an expired flow.
        const expired = await accessRequest(context, {
          type: "login-poll",
          loginId: current.loginId,
        });
        if (expired.type !== "login-poll")
          invalid("Unexpected provider login response.");
        current = expired.login;
        break;
      }
      const polled = await accessRequest(context, {
        type: "login-poll",
        loginId: current.loginId,
      });
      if (polled.type !== "login-poll")
        invalid("Unexpected provider login response.");
      current = polled.login;
    }
  } catch (error) {
    if (!context.signal.aborted) throw error;
  } finally {
    if (context.signal.aborted) await closeLogin(context, current.loginId);
  }
  if (context.signal.aborted) {
    context.stderr("login cancelled.\n");
    return 130;
  }
  if (flag(args, "json"))
    jsonLine(context, { type: "login-poll", login: current });
  else printLogin(context, current, "login");
  return current.status === "done" ? 0 : 1;
};

const quotaProvider = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["credential"], ["json"]);
  if (args.positional.length !== 1)
    invalid("Provider quota requires one source ID.");
  const sourceId = args.positional[0] ?? invalid("A source ID is required.");
  const settings = publicSettings(await context.service.getSettings());
  const source = settings.providerSources?.find((item) => item.id === sourceId);
  if (!source) invalid("The selected source does not exist.");
  const explicit = stringOption(args, "credential");
  const accountCredentials =
    source.credentials?.filter(
      (credential) => credential.type === "account" && credential.enabled,
    ) ?? [];
  const credentialId =
    explicit ??
    source.activeCredentialId ??
    (accountCredentials.length === 1 ? accountCredentials[0]?.id : undefined);
  if (credentialId === undefined)
    invalid("Provider quota requires --credential ID.");
  const result = await accessRequest(context, {
    type: "quota",
    sourceId,
    credentialId,
  });
  if (result.type !== "quota") invalid("Unexpected provider quota response.");
  output(context, args, result.quota);
  return context.signal.aborted ? 130 : 0;
};

export interface ModelAccessCommandContext {
  readonly service: HarnessService;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readStdin: (limit: number, signal: AbortSignal) => Promise<string>;
  readonly dispose: () => Promise<void>;
}

/** Rich catalog shared by `models --details` and `providers catalog`. */
export const loadModelCatalog = async (
  service: HarnessService,
  signal: AbortSignal,
  options: Readonly<{
    sourceId?: string | undefined;
    credentialId?: string | undefined;
    refresh?: boolean | undefined;
  }>,
): Promise<ModelCatalog> => {
  const access = service.modelAccess;
  if (options.credentialId !== undefined && access === undefined)
    invalid("Credential selection is unavailable on this host.");
  if (access !== undefined) {
    let sourceId = options.sourceId;
    if (sourceId === undefined) {
      const settings = await service.getSettings();
      sourceId =
        settings.activeSourceId ??
        (settings.providerSources?.length === 1
          ? settings.providerSources[0]?.id
          : undefined);
    }
    if (sourceId !== undefined) {
      const result = await access(
        {
          type: "catalog",
          sourceId,
          ...(options.credentialId === undefined
            ? {}
            : { credentialId: options.credentialId }),
          ...(options.refresh === undefined
            ? {}
            : { refresh: options.refresh }),
        },
        signal,
      );
      if (result.type !== "catalog")
        invalid("Unexpected model catalog response.");
      if (result.stale) throw new ForgeError("provider", "Catalog refresh failed; the last successful catalog is retained. Retry without --refresh to read it.");
      return result.models;
    }
    if (options.credentialId !== undefined)
      invalid("A source is required when selecting a credential.");
  }
  if (
    options.credentialId === undefined &&
    service.listModelCatalog !== undefined
  )
    return service.listModelCatalog(signal, options.sourceId, options.refresh);
  const models = await service.listModels(
    signal,
    options.sourceId,
    options.refresh,
  );
  return models.map((id) => ({ id, contextWindowTokens: null }));
};

export const runProvidersCommand = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const action = argv[0];
  if (action === undefined || action === "help" || argv.includes("--help")) {
    context.stdout(providersHelp);
    return 0;
  }
  switch (action) {
    case "list":
      return listProviders(argv.slice(1), context);
    case "presets":
      return listPresets(argv.slice(1), context);
    case "catalog":
      return catalogProvider(argv.slice(1), context);
    case "test":
      return testProvider(argv.slice(1), context);
    case "save":
      return saveProvider(argv.slice(1), context);
    case "remove":
      return removeProvider(argv.slice(1), context);
    case "import":
      return importProviders(argv.slice(1), context);
    case "login":
      return loginProvider(argv.slice(1), context);
    case "quota":
      return quotaProvider(argv.slice(1), context);
    default:
      invalid("Unknown providers command. Use forge providers --help.");
  }
};

const listRoutes = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  noPositionals(args);
  const settings = publicSettings(await context.service.getSettings());
  output(context, args, settings.routeGroups ?? []);
  return 0;
};

const saveRoute = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["input"], ["stdin", "json"]);
  noPositionals(args);
  const text = await readPrivateInput(args, context, "route save");
  const group = normalizeRouteSave(parseJson(text, "Route save input"));
  const settings = publicSettings(
    await context.service.updateSettings({
      route: { type: "save", group },
    }),
  );
  output(
    context,
    args,
    settings.routeGroups?.find((item) => item.id === group.id) ?? group,
  );
  return context.signal.aborted ? 130 : 0;
};

const removeRoute = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  if (args.positional.length !== 1)
    invalid("Route remove requires one group ID.");
  const id = args.positional[0] ?? invalid("A group ID is required.");
  const settings = publicSettings(
    await context.service.updateSettings({ route: { type: "remove", id } }),
  );
  output(context, args, {
    removed: id,
    routeGroups: settings.routeGroups ?? [],
  });
  return 0;
};

export const runRoutesCommand = async (
  argv: readonly string[],
  context: ModelAccessCommandContext,
): Promise<number> => {
  const action = argv[0];
  if (action === undefined || action === "help" || argv.includes("--help")) {
    context.stdout(routesHelp);
    return 0;
  }
  switch (action) {
    case "list":
      return listRoutes(argv.slice(1), context);
    case "save":
      return saveRoute(argv.slice(1), context);
    case "remove":
      return removeRoute(argv.slice(1), context);
    default:
      invalid("Unknown routes command. Use forge routes --help.");
  }
};
