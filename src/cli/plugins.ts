import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessService } from "@forge/core/shared/contracts";
import { ForgeError } from "@forge/core/shared/errors";
import type { PluginConfigureInput } from "@forge/core/shared/plugins";
import { jsonObjectSchema } from "@forge/core/shared/schemas";

const configLimit = 1024 * 1024;

export const pluginsHelp = `forge plugins list [--json]
forge plugins show <id> [--json]
forge plugins configure <id> --config <JSON_FILE> [--json]
forge plugins enable|disable <id> [--json]
forge plugins check <id> [--json]

Plugins are installed and versioned by Forge. This command never installs,
upgrades or changes Forge's execution permissions. The official agent-browser plugin has
id "browser" and is disabled by default; enabling it requires a non-empty allowedDomains grant.
allowedDomains are hostnames such as example.com or *.example.com, not exact
HTTP(S) origins: no scheme, credentials, port, path, query, fragment or
wildcard in the middle. Set allowedDomains to ["*"] to explicitly allow all
HTTP(S) hosts, including localhost and LAN hosts; an empty list grants no access.
At most 64 entries. --config accepts only the plugin's config object and no
file is read unless --config is supplied; there is no
default config path. Core validates the object against the plugin manifest.

For agent-browser, an explicit configuration looks like:
  {"executablePath":"agent-browser","browserExecutablePath":"","allowedDomains":["example.com"]}

Changing configuration or disabling a plugin closes browser sessions owned by
this Core. check starts the plugin's MCP diagnostic only; it never opens or visits pages.
list and show never start a plugin. check exits non-zero when the diagnostic
reports the plugin unavailable.
`;

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
        invalid("Unknown option. Use forge plugins --help.");
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
      invalid("Unknown option. Use forge plugins --help.");
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

const onePluginId = (args: ParsedArgs): string => {
  if (args.positional.length !== 1)
    invalid("Exactly one plugin id is required.");
  const id = args.positional[0] ?? invalid("Plugin id is required.");
  if (id.trim() === "") invalid("Plugin id is required.");
  return id;
};

const readable = (context: PluginCommandContext, value: unknown): void => {
  context.stdout(`${JSON.stringify(value, null, 2)}\n`);
};

const output = (
  context: PluginCommandContext,
  args: ParsedArgs,
  value: unknown,
): void => {
  if (flag(args, "json")) context.stdout(`${JSON.stringify(value)}\n`);
  else readable(context, value);
};

type PluginConfig = NonNullable<PluginConfigureInput["config"]>;

const readPluginConfig = async (
  path: string,
  signal: AbortSignal,
): Promise<PluginConfig> => {
  if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK).catch(() =>
    invalid("Plugin config file could not be opened."),
  );
  try {
    const info = await file
      .stat()
      .catch(() => invalid("Plugin config file could not be read."));
    if (!info.isFile()) invalid("Plugin config must be a regular file.");
    if (info.size > configLimit) invalid("Plugin config file exceeds 1 MiB.");
    if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
    // A size check alone is insufficient when the file grows during reading.
    const bytes = Buffer.alloc(configLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
        .catch(() => invalid("Plugin config file could not be read."));
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > configLimit) invalid("Plugin config file exceeds 1 MiB.");
    const text = bytes.subarray(0, length).toString("utf8");
    if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      invalid("Plugin config must be valid JSON.");
    }
    const parsed = jsonObjectSchema.safeParse(raw);
    if (!parsed.success) invalid("Plugin config must be a JSON object.");
    return parsed.data as PluginConfig;
  } finally {
    await file.close();
  }
};

const requireList = (service: HarnessService) => {
  const method = service.listPlugins?.bind(service);
  if (!method) invalid("Plugins are unavailable on this host.");
  return method;
};

const requireConfigure = (service: HarnessService) => {
  const method = service.configurePlugin?.bind(service);
  if (!method) invalid("Plugins are unavailable on this host.");
  return method;
};

const requireCheck = (service: HarnessService) => {
  const method = service.checkPlugin?.bind(service);
  if (!method) invalid("Plugins are unavailable on this host.");
  return method;
};

const listPlugins = async (
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  noPositionals(args);
  output(context, args, await requireList(context.service)());
  return 0;
};

const showPlugin = async (
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  const pluginId = onePluginId(args);
  const records = await requireList(context.service)();
  const record = records.find((entry) => entry.manifest.id === pluginId);
  if (!record) throw new ForgeError("not_found", "Plugin not found.");
  output(context, args, record);
  return 0;
};

const configurePlugin = async (
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, ["config"], ["json"]);
  const pluginId = onePluginId(args);
  const path = stringOption(args, "config");
  if (path === undefined || path === "")
    invalid("configure requires --config JSON_FILE.");
  const config = await readPluginConfig(path, context.signal);
  const record = await requireConfigure(context.service)({
    pluginId,
    config,
  });
  output(context, args, record);
  return 0;
};

const setPluginEnabled = async (
  enabled: boolean,
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  const pluginId = onePluginId(args);
  const record = await requireConfigure(context.service)({
    pluginId,
    enabled,
  });
  output(context, args, record);
  return 0;
};

const checkPlugin = async (
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const args = parseArgs(argv, [], ["json"]);
  const pluginId = onePluginId(args);
  const health = await requireCheck(context.service)(pluginId);
  output(context, args, health);
  return health.status === "ready" ? 0 : 1;
};

export interface PluginCommandContext {
  readonly service: HarnessService;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
}

export const runPluginsCommand = async (
  argv: readonly string[],
  context: PluginCommandContext,
): Promise<number> => {
  const action = argv[0];
  if (action === undefined || action === "help" || argv.includes("--help")) {
    context.stdout(pluginsHelp);
    return 0;
  }
  switch (action) {
    case "list":
      return listPlugins(argv.slice(1), context);
    case "show":
      return showPlugin(argv.slice(1), context);
    case "configure":
      return configurePlugin(argv.slice(1), context);
    case "enable":
      return setPluginEnabled(true, argv.slice(1), context);
    case "disable":
      return setPluginEnabled(false, argv.slice(1), context);
    case "check":
      return checkPlugin(argv.slice(1), context);
    default:
      return invalid("Unknown plugins command. Use forge plugins --help.");
  }
};
