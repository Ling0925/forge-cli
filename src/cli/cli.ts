import { open, stat } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mcpRegisterInputSchema } from "../mcp/types";
import { assertNever } from "../shared/contracts";
import type { HarnessService } from "../shared/contracts";
import { ForgeError, toErrorInfo } from "../shared/errors";
import {
  configureInputSchema,
  createSessionInputSchema,
  parseSessionId,
  permissionSchema,
  publicSettingsSchema,
  runInputSchema,
  sessionSnapshotSchema,
  settingsFields,
} from "../shared/schemas";
import type { AgentEvent, SessionStatus } from "../shared/schemas";

import { DEFAULT_APPROVAL_MODE, parseApprovalAnswer, parseApprovalMode } from "./approval-policy";
import { interactive, terminalText } from "./interactive";
import { createNodeIO } from "./node-io";
export { createNodeIO, nodeIO } from "./node-io";
export type { CreateNodeIOOptions } from "./node-io";
import type { QuestionOptions } from "./terminal";
import type { TerminalUI } from "./ui-contract";

const promptLimit = 1_000_000;
const keyLimit = 16_386;
const help = `Forge — shared-core agent CLI

forge chat [--workspace PATH] [--session UUID] [--approval full-access|auto|manual] [--thinking|--expand-thinking]
forge config show
forge config set [--base-url URL] [--model MODEL] [--api-mode chat-completions|responses] [--api-key-stdin]
                 [--reasoning-effort default|none|minimal|low|medium|high|xhigh]
                 [--theme system|light|dark] [--permission readonly|workspace|unrestricted]
                 [--timeout-ms NUMBER] [--max-turns NUMBER] [--max-tools NUMBER] [--context-chars NUMBER] [--context-budget-tokens NUMBER|auto]
                  [--context-tokens NUMBER|auto] (window for --model or current model)
                 [--browser-origins ORIGIN[,ORIGIN...]] [--browser-executable PATH]
--browser-origins accepts exact canonical HTTP(S) origins only (scheme, host,
optional port; no credentials, path, query, fragment or wildcard; at most 32).
An empty value clears the list; no origins disables browser tools (default).
--browser-executable selects a local Chromium/Chrome executable; an empty value
uses the Playwright default or FORGE_BROWSER_EXECUTABLE.
forge models [--json]
forge sessions [--json]
forge show <id> [--json]
forge compact|fork|diagnostics <id> [--json]
forge context|skills <session-id> [--json]
forge checkpoints list <session-id> [--json]
forge checkpoints diff|restore <session-id> <checkpoint-uuid> [--json]
forge mcp list [--json] | register <id> <label> <command> [args...] [--disabled]
forge mcp enable|disable|remove|health <id> [--json]
forge export <session-id> --output PATH (explicit destination; no implicit path)
forge rename <id> <title> | archive <id> [--unarchive]
forge run [prompt...] --workspace PATH [--session UUID] [run options]
forge resume <id> [prompt...] [run options]

Run options: --model MODEL --mode plan|build --permission readonly|workspace|unrestricted
             --prompt-file PATH | --prompt-stdin
             --json --yes
Use exactly one prompt source. Stdin is never read implicitly.
--yes approves calls only with explicitly selected --permission unrestricted.
Chat defaults to full-access: tool approvals are automatic within existing permissions.
Commands are not sandboxed and may access external files/network. /approval manual
asks each time (fresh Enter approves); auto approves eligible root commands only.
During a run: Enter queues a follow-up; /steer <message> or Alt+Enter steers at a safe boundary.
Slash commands remain available; commands requiring idle execute after the run.
/queue lists pending input, /queue clear discards it.
JSON runs emit version 1 JSONL event envelopes followed by a result envelope.
`;

export interface CliIO {
  readonly ui?: TerminalUI | undefined;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly isTTY: boolean;
  readonly readStdin: (limit: number, signal: AbortSignal) => Promise<string>;
  readonly question: (
    text: string,
    signal: AbortSignal,
    options?: QuestionOptions,
  ) => Promise<string>;
  readonly readApproval?: (
    text: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /** Receives ordinary submitted lines during a run; approval input is isolated. */
  readonly onRunInput?: (callback: (line: string, steer?: boolean) => void) => () => void;
  /** Interactive input lifetime only; machine stdin EOF is not cancellation. */
  readonly onClose?: (callback: () => void) => () => void;
  readonly onInterrupt: (callback: () => void) => () => void;
  readonly promptHistory?: (action: "on" | "off" | "clear" | "status" | "scope", workspace: string) => Promise<string>;
  readonly dispose?: () => Promise<void> | void;
}

const invalid = (message: string): never => {
  throw new ForgeError("invalid_input", message);
};

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly options: Readonly<Record<string, string | boolean>>;
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
        return invalid("An option requires a value.");
      options[name] = value;
    } else {
      invalid(
        "Unknown option. Use --help for usage. Credentials are accepted only through --api-key-stdin.",
      );
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
const jsonLine = (io: CliIO, value: unknown): void =>
  io.stdout(`${JSON.stringify(value)}\n`);
const readable = (io: CliIO, value: unknown): void =>
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);

const readPromptFile = async (
  path: string,
  signal: AbortSignal,
): Promise<string> => {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      invalid("Prompt file must be a regular file.");
    const buffer = Buffer.alloc(promptLimit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      if (signal.aborted) throw new ForgeError("cancelled", "Input cancelled.");
      const result = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > promptLimit) invalid("Prompt file exceeds the allowed size.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      );
    } catch {
      return invalid("Prompt file must be valid UTF-8.");
    }
  } finally {
    await file.close();
  }
};

const renderEvent = (output: CliIO, event: AgentEvent): void => {
  const io = {
    ...output,
    stdout: (text: string) => output.stdout(terminalText(text)),
    stderr: (text: string) => output.stderr(terminalText(text)),
  };
  switch (event.type) {
    case "text_delta":
      io.stdout(event.text);
      return;
    case "tool_started":
      io.stdout(`\nTool: ${event.call.function.name}\n`);
      return;
    case "tool_finished":
      io.stdout(
        `\nTool ${event.toolCallId}: ${event.result.isError ? "failed" : "finished"}\n${event.result.content}\n`,
      );
      return;
    case "error":
      io.stderr(`${event.error.code}: ${event.error.message}\n`);
      return;
    case "run_finished":
      io.stdout(
        `\nRun ${event.status}; turns=${event.turns}, tools=${event.toolCalls}\n`,
      );
      return;
    case "run_started":
      io.stdout(
        `Session ${event.sessionId}; model=${event.model}; permission=${event.permission}\n`,
      );
      return;
    case "plan_updated":
      io.stdout(`Plan: ${JSON.stringify(event.plan)}\n`);
      break;
    case "agent_update":
      io.stdout(
        `\nChild ${event.childSessionId}: ${event.status}; model=${event.model}\n${event.summary}\n`,
      );
      return;
    case "state_changed":
    case "approval_requested":
    case "context_usage":
    case "context_compacted":
    // Live reasoning preview is a rich-terminal affordance; plain output stays quiet.
    case "reasoning_delta":
      return;
    default:
      assertNever(event);
  }
};

const statusCode = (status: SessionStatus): number => {
  switch (status) {
    case "completed":
      return 0;
    case "cancelled":
      return 130;
    case "idle":
    case "running":
    case "awaiting_approval":
    case "failed":
    case "interrupted":
      return 1;
    default:
      return assertNever(status);
  }
};

/** IO injection is for host tests; this function delegates all agent work to the shared service. */
export const runCliWithIO = async (
  argv: readonly string[],
  service: HarnessService,
  io: CliIO,
): Promise<number> => {
  const controller = new AbortController();
  const unsubscribe = io.onInterrupt(() => controller.abort());
  try {
    const command = argv[0];
    if (
      !argv.includes("--help") &&
      (command === "chat" || (command === undefined && io.isTTY))
    ) {
      if (!io.isTTY)
        invalid(
          "chat requires an interactive terminal; use run with an explicit prompt source.",
        );
      if (argv.includes("--json"))
        invalid("Interactive chat does not support --json.");
      const argOffset = command === "chat" ? 1 : 0;
      const args = parseArgs(argv.slice(argOffset), ["workspace", "session", "approval"], ["thinking", "expand-thinking"]);
      noPositionals(args);
      const chatWorkspace = stringOption(args, "workspace");
      const chatSession = stringOption(args, "session");
      const approval = parseApprovalMode(stringOption(args, "approval") ?? DEFAULT_APPROVAL_MODE);
      const expandReasoning = flag(args, "thinking") || flag(args, "expand-thinking");
      if (chatWorkspace && !(await stat(resolve(chatWorkspace))).isDirectory())
        invalid("Workspace must be an existing directory.");
      if (
        chatWorkspace &&
        chatSession &&
        resolve(
          (await service.getSession(parseSessionId(chatSession))).workspace,
        ) !== resolve(chatWorkspace)
      )
        invalid("Workspace does not match the resumed session.");
      unsubscribe();
      return await interactive(
        service,
        io,
        resolve(stringOption(args, "workspace") ?? "."),
        stringOption(args, "session"),
        renderEvent,
        approval,
        expandReasoning,
      );
    }
    if (
      command === undefined ||
      command === "--help" ||
      command === "-h" ||
      argv.includes("--help")
    ) {
      io.stdout(help);
      return 0;
    }
    if (command === "config") {
      const subcommand = argv[1];
      if (subcommand === "show") {
        noPositionals(parseArgs(argv.slice(2), [], []));
        readable(io, publicSettingsSchema.parse(await service.getSettings()));
        return 0;
      }
      if (subcommand !== "set") invalid("Expected config show or config set.");
      const args = parseArgs(
        argv.slice(2),
        [
          "base-url",
          "model",
          "api-mode",
          "reasoning-effort",
          "theme",
          "permission",
          "timeout-ms",
          "max-turns",
          "max-tools",
          "context-chars",
          "context-tokens",
          "context-budget-tokens",
          "browser-origins",
          "browser-executable",
        ],
        ["api-key-stdin"],
      );
      noPositionals(args);
      const timeout = stringOption(args, "timeout-ms");
      const numeric = (name: string): number | undefined => {
        const value = stringOption(args, name);
        return value === undefined
          ? undefined
          : /^\d+$/.test(value)
            ? Number(value)
            : Number.NaN;
      };
      const origins = stringOption(args, "browser-origins");
      if (origins !== undefined && origins !== "") {
        // Clear CLI-side diagnostics before schema validation; never echo input values.
        const list = origins.split(",").map((value) => value.trim());
        if (list.some((value) => value === "") || list.length > 32)
          invalid("--browser-origins expects up to 32 exact HTTP(S) origins.");
      }
      const tokenBudget = stringOption(args, "context-budget-tokens");
      if (tokenBudget !== undefined && tokenBudget !== "auto" && !/^[1-9]\d*$/.test(tokenBudget)) invalid("--context-budget-tokens expects a positive integer or auto.");
      const tokenWindow = stringOption(args, "context-tokens");
      const current = tokenWindow === undefined ? undefined : await service.getSettings();
      const targetModel = stringOption(args, "model") ?? current?.model;
      if (tokenWindow !== undefined && !targetModel) invalid("--context-tokens requires a configured model or --model.");
      if (tokenWindow !== undefined && tokenWindow !== "auto" && !/^[1-9]\d*$/.test(tokenWindow)) invalid("--context-tokens expects a positive integer or auto.");
      const settings = configureInputSchema.parse({
        settings: {
          ...(stringOption(args, "base-url") !== undefined
            ? { baseUrl: stringOption(args, "base-url") }
            : {}),
          ...(stringOption(args, "model") !== undefined
            ? { model: stringOption(args, "model") }
            : {}),
          ...(stringOption(args, "api-mode") !== undefined
            ? { apiMode: stringOption(args, "api-mode") }
            : {}),
          ...(stringOption(args, "reasoning-effort") !== undefined
            ? { reasoningEffort: stringOption(args, "reasoning-effort") }
            : {}),
          ...(stringOption(args, "theme") !== undefined
            ? { theme: stringOption(args, "theme") }
            : {}),
          ...(stringOption(args, "permission") !== undefined
            ? { defaultPermission: stringOption(args, "permission") }
            : {}),
          ...(timeout !== undefined
            ? {
                requestTimeoutMs: /^\d+$/.test(timeout)
                  ? Number(timeout)
                  : Number.NaN,
              }
            : {}),
          ...(numeric("max-turns") !== undefined
            ? { maxTurns: numeric("max-turns") }
            : {}),
          ...(numeric("max-tools") !== undefined
            ? { maxToolCalls: numeric("max-tools") }
            : {}),
          ...(tokenWindow !== undefined ? { modelContextWindows: { ...current?.modelContextWindows, [targetModel!]: tokenWindow === "auto" ? null : Number(tokenWindow) } } : {}),
          ...(tokenBudget !== undefined ? { contextBudgetTokens: tokenBudget === "auto" ? null : Number(tokenBudget) } : {}),
          ...(numeric("context-chars") !== undefined
            ? { contextBudgetChars: numeric("context-chars") }
            : {}),
          ...(origins !== undefined
            ? {
                browserAllowedOrigins:
                  origins === ""
                    ? []
                    : origins.split(",").map((value) => value.trim()),
              }
            : {}),
          ...(stringOption(args, "browser-executable") !== undefined
            ? {
                browserExecutablePath: stringOption(args, "browser-executable"),
              }
            : {}),
        },
      });
      const apiKey = flag(args, "api-key-stdin")
        ? (await io.readStdin(keyLimit, controller.signal)).replace(
            /(?:\r\n|\n)$/,
            "",
          )
        : undefined;
      const input = configureInputSchema.parse({
        ...settings,
        ...(apiKey !== undefined ? { apiKey } : {}),
      });
      if (controller.signal.aborted) return 130;
      readable(
        io,
        publicSettingsSchema.parse(await service.updateSettings(input)),
      );
      return 0;
    }
    if (command === "mcp") {
      const action = argv[1];
      const args = parseArgs(argv.slice(2), [], ["json", "disabled"]);
      const parts = args.positional;
      let value: unknown;
      if (action === "list") {
        if (parts.length) invalid("Unexpected arguments.");
        value = await service.listMcpServers();
      } else if (action === "register") {
        if (parts.length < 3)
          invalid("register needs id, label, command and optional arguments.");
        value = await service.registerMcpServer(
          mcpRegisterInputSchema.parse({
            id: parts[0],
            label: parts[1],
            command: parts[2],
            args: parts.slice(3),
            enabled: !flag(args, "disabled"),
          }),
        );
      } else {
        if (parts.length !== 1) invalid("MCP operation needs a server id.");
        const id = parts[0] ?? invalid("MCP server id is required.");
        if (action === "enable" || action === "disable")
          value = await service.setMcpEnabled(id, action === "enable");
        else if (action === "remove") value = await service.removeMcpServer(id);
        else if (action === "health") value = await service.getMcpHealth(id);
        else invalid("Unknown MCP operation.");
      }
      if (flag(args, "json")) jsonLine(io, value ?? null);
      else readable(io, value ?? null);
      return 0;
    }
    if (
      command === "context" ||
      command === "skills" ||
      command === "checkpoints" ||
      command === "export"
    ) {
      const args = parseArgs(argv.slice(1), ["output"], ["json"]);
      const parts = args.positional;
      let value: unknown;
      if (command === "checkpoints") {
        const action = parts[0];
        if (
          (action === "list" && parts.length !== 2) ||
          (action !== "list" && parts.length !== 3)
        )
          invalid(
            "Expected checkpoints list <session> or diff|restore <session> <checkpoint>.",
          );
        const id = parseSessionId(parts[1]);
        if (action === "list") value = await service.listCheckpoints(id);
        else if (action === "diff")
          value = await service.getCheckpointDiff(
            id,
            parts[2] ?? invalid("Checkpoint UUID is required."),
          );
        else if (action === "restore")
          value = await service.restoreCheckpoint(
            id,
            parts[2] ?? invalid("Checkpoint UUID is required."),
          );
        else invalid("Unknown checkpoint operation.");
      } else {
        if (parts.length !== 1) invalid("A session UUID is required.");
        const id = parseSessionId(parts[0]);
        if (command === "export") {
          const destination = stringOption(args, "output");
          if (!destination) invalid("export requires --output PATH.");
          const snapshot = sessionSnapshotSchema.parse(
            await service.getSession(id),
          );
          await writeFile(
            resolve(destination ?? invalid("export requires --output PATH.")),
            `${JSON.stringify(snapshot, null, 2)}\n`,
            { flag: "wx", mode: 0o600 },
          );
          value = {
            output: resolve(
              destination ?? invalid("export requires --output PATH."),
            ),
          };
        } else {
          const catalog = await service.getProjectContext(id);
          value = command === "skills" ? catalog.skills : catalog;
        }
      }
      if (flag(args, "json")) jsonLine(io, value);
      else readable(io, value);
      return 0;
    }
    if (
      ["compact", "fork", "rename", "archive", "diagnostics"].includes(command)
    ) {
      const args = parseArgs(argv.slice(1), [], ["json", "unarchive"]);
      if (!args.positional[0]) invalid("A session UUID is required.");
      const id = parseSessionId(args.positional[0]);
      let result: unknown;
      switch (command) {
        case "compact":
          if (args.positional.length !== 1) invalid("Unexpected arguments.");
          result = await service.compactSession(id, controller.signal);
          break;
        case "fork":
          if (args.positional.length !== 1) invalid("Unexpected arguments.");
          result = await service.forkSession(id);
          break;
        case "rename":
          if (args.positional.length < 2) invalid("A title is required.");
          result = await service.renameSession(
            id,
            args.positional.slice(1).join(" "),
          );
          break;
        case "archive":
          if (args.positional.length !== 1) invalid("Unexpected arguments.");
          result = await service.archiveSession(id, !flag(args, "unarchive"));
          break;
        default:
          if (args.positional.length !== 1) invalid("Unexpected arguments.");
          result = await service.getDiagnostics(id);
      }
      if (flag(args, "json")) jsonLine(io, result);
      else readable(io, result);
      return 0;
    }
    if (command === "models" || command === "sessions" || command === "show") {
      const args = parseArgs(argv.slice(1), [], ["json"]);
      if (command === "show") {
        if (args.positional.length !== 1)
          invalid("show requires one session UUID.");
        const snapshot = sessionSnapshotSchema.parse(
          await service.getSession(parseSessionId(args.positional[0])),
        );
        if (flag(args, "json")) jsonLine(io, snapshot);
        else readable(io, snapshot);
      } else {
        noPositionals(args);
        const value =
          command === "models"
            ? await service.listModels(controller.signal)
            : await service.listSessions();
        if (flag(args, "json")) jsonLine(io, value);
        else readable(io, value);
      }
      return controller.signal.aborted ? 130 : 0;
    }
    if (command !== "run" && command !== "resume")
      invalid("Unknown command. Use --help for usage.");
    const args = parseArgs(
      argv.slice(1),
      ["workspace", "session", "model", "mode", "permission", "prompt-file"],
      ["json", "yes", "prompt-stdin"],
    );
    if (
      command === "resume" &&
      (stringOption(args, "workspace") !== undefined ||
        stringOption(args, "session") !== undefined)
    ) {
      invalid(
        "resume uses its session workspace and does not accept --session.",
      );
    }
    const idText =
      command === "resume" ? args.positional[0] : stringOption(args, "session");
    if (command === "resume" && idText === undefined)
      invalid("resume requires a session UUID.");
    const id = idText === undefined ? undefined : parseSessionId(idText);
    const words =
      command === "resume" ? args.positional.slice(1) : args.positional;
    const file = stringOption(args, "prompt-file");
    const stdinPrompt = flag(args, "prompt-stdin");
    const sources =
      Number(words.length > 0) +
      Number(file !== undefined) +
      Number(stdinPrompt);
    if (sources !== 1)
      invalid(
        "Supply exactly one prompt source: words, --prompt-file, or --prompt-stdin.",
      );
    const permissionText = stringOption(args, "permission");
    const permission =
      permissionText === undefined
        ? undefined
        : permissionSchema.parse(permissionText);
    const modelText = stringOption(args, "model");
    const model =
      modelText === undefined
        ? undefined
        : settingsFields.model.parse(modelText);
    const prompt = runInputSchema
      .unwrap()
      .shape.prompt.parse(
        file !== undefined
          ? await readPromptFile(file, controller.signal)
          : stdinPrompt
            ? await io.readStdin(promptLimit, controller.signal)
            : words.join(" "),
      );
    const workspaceText = stringOption(args, "workspace");
    if (id === undefined && workspaceText === undefined)
      invalid("A new run requires --workspace PATH.");
    const workspace =
      workspaceText === undefined ? undefined : resolve(workspaceText);
    if (workspace !== undefined && !(await stat(workspace)).isDirectory())
      invalid("Workspace must be an existing directory.");
    if (controller.signal.aborted) return 130;
    const session =
      id === undefined
        ? await service.createSession(
            createSessionInputSchema.parse({
              workspace,
              ...(model !== undefined ? { model } : {}),
            }),
          )
        : await service.getSession(id);
    if (workspace !== undefined && workspace !== resolve(session.workspace))
      invalid("Workspace does not match the resumed session.");
    const input = runInputSchema.parse({
      sessionId: session.id,
      prompt,
      ...(permission !== undefined ? { permission } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(stringOption(args, "mode") !== undefined
        ? { mode: stringOption(args, "mode") }
        : {}),
    });
    const json = flag(args, "json");
    const result = await service.run(
      input,
      (event) => {
        if (json) jsonLine(io, { version: 1, kind: "event", event });
        else renderEvent(io, event);
      },
      async (request, signal) => {
        if (signal.aborted) return false;
        if (flag(args, "yes") && permission === "unrestricted") return true;
        if (!io.isTTY) {
          io.stderr(
            "Approval denied: interactive terminal required. To deliberately auto-approve, select --permission unrestricted --yes. Workspace mode never auto-approves.\n",
          );
          return false;
        }
        try {
          const prompt = `\nApproval: ${request.childSessionId ? `child ${request.childSessionId} ` : ""}${request.toolName}\nWorkspace/cwd context: ${JSON.stringify(session.workspace)}\nDescription: ${JSON.stringify(request.description)}\nFull argv: ${JSON.stringify(request.command ?? [])}\nEnter approves; commands are not sandboxed.\nApprove? [Y/n] `;
          if (io.readApproval) {
            const approved = await io.readApproval(prompt, signal);
                return !signal.aborted && approved;
          }
          const answer = await io.question(prompt, signal, { fresh: true });
          return !signal.aborted && parseApprovalAnswer(answer);
        } catch {
          return false;
        }
      },
      controller.signal,
    );
    if (json) jsonLine(io, { version: 1, kind: "result", session: result });
    else io.stdout(`Session ${result.id}: ${result.status}\n`);
    return controller.signal.aborted ? 130 : statusCode(result.status);
  } catch (error: unknown) {
    const info = toErrorInfo(error);
    io.stderr(`${info.code}: ${info.message}\n`);
    return controller.signal.aborted || info.code === "cancelled" ? 130 : 1;
  } finally {
    unsubscribe();
    await io.dispose?.();
  }
};

export const runCli = (
  argv: readonly string[],
  service: HarnessService,
  io: CliIO = createNodeIO(),
): Promise<number> => runCliWithIO(argv, service, io);
