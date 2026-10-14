import { mcpRegisterInputSchema } from "../mcp/types";
import type { HarnessService } from "../shared/contracts";
import { ForgeError, toErrorInfo } from "../shared/errors";
import {
  createSessionInputSchema,
  parseSessionId,
  permissionSchema,
  runInputSchema,
  settingsFields,
} from "../shared/schemas";
import type { AgentEvent } from "../shared/schemas";
import type { CliIO } from "./cli";
import { formatHelp } from "./commands";
import {
  bannerLines,
  formatBanner,
  formatPlan,
  formatSessions,
  helpLines,
  planLines,
  terminalText,
} from "./format";
import { abortable } from "./interactive/abortable";
import {
  pickModel,
  pickReasoningEffort,
  pickSession,
} from "./interactive/pickers";
import { LiveRun } from "./live-run";
import { plainLines } from "./render/rich";
import { createTheme } from "./theme";
import type { RunStatus } from "./ui-contract";

export { terminalText };

export async function interactive(
  service: HarnessService,
  io: CliIO,
  workspace: string,
  sessionId: string | undefined,
  _render: (io: CliIO, event: AgentEvent) => void,
): Promise<number> {
  const settings = await service.getSettings();
  const ui = io.ui;
  const theme = createTheme({ isTTY: false });
  const styled = (text: string) =>
    ui ? ui.append(plainLines(text)) : io.stdout(text);
  const safe: CliIO = {
    ...io,
    stdout: (text) => styled(terminalText(text)),
    stderr: (text) =>
      ui
        ? ui.append(plainLines(terminalText(text)))
        : io.stderr(terminalText(text)),
  };
  let session = sessionId
    ? await service.getSession(parseSessionId(sessionId))
    : await service.createSession(
        createSessionInputSchema.parse({ workspace }),
      );
  let model = session.model;
  let mode: "build" | "plan" = "build";
  let permission = settings.defaultPermission;
  try {
    await ui?.configure({ theme: settings.theme });
  } catch (error) {
    ui?.dispose();
    throw error;
  }
  const lifetime = new AbortController();
  let active: AbortController | undefined;
  let awaitingInput: AbortController | undefined;
  let interruptedOnce = false;
  let live: LiveRun | undefined;
  let statusGeneration = 0;
  let activeStatus: number | undefined;

  /**
   * Shows a real operation on the existing status line. The controller timer
   * refreshes elapsed time from startedAt; this does not poll or animate.
   * Cleanup clears only the generation it started, so an unrelated run status
   * installed afterward stays visible.
   */
  const showOperation = (label: string): (() => void) => {
    if (!ui) return () => {};
    const generation = ++statusGeneration;
    activeStatus = generation;
    const status: RunStatus = {
      label,
      startedAt: Date.now(),
      toolCount: 0,
      cancellable: true,
    };
    ui.setStatus(status);
    return () => {
      if (activeStatus !== generation) return;
      activeStatus = undefined;
      ui.setStatus(null);
    };
  };

  const changeReasoning = async (value?: string): Promise<void> => {
    active ??= new AbortController();
    ui?.setBusy(true);
    const signal = active.signal;
    let chosen = value;
    if (!chosen) {
      const current = await abortable(service.getSettings(), signal);
      safe.stdout(
        `Reasoning effort: ${current.reasoningEffort ?? "default"}\n`,
      );
      const selection = await pickReasoningEffort(
        safe,
        current.reasoningEffort ?? "default",
        signal,
      );
      if (selection === null || signal.aborted) return;
      chosen = selection;
    }
    const reasoningEffort = settingsFields.reasoningEffort
      .unwrap()
      .parse(chosen);
    if (signal.aborted) return;
    await service.updateSettings({ settings: { reasoningEffort } });
    safe.stdout(`Reasoning effort: ${reasoningEffort} (saved)\n`);
  };

  const offClose = io.onClose?.(() => {
    lifetime.abort();
    active?.abort();
    awaitingInput?.abort();
  });

  const off = io.onInterrupt(() => {
    if (active && !active.signal.aborted) {
      active.abort();
      interruptedOnce = true;
    } else if (ui) {
      lifetime.abort();
      awaitingInput?.abort();
    } else if (
      awaitingInput &&
      !awaitingInput.signal.aborted &&
      !interruptedOnce
    ) {
      interruptedOnce = true;
      awaitingInput.abort();
    } else {
      lifetime.abort();
      active?.abort();
      awaitingInput?.abort();
    }
  });

  const banner = formatBanner(
    {
      id: session.id,
      workspace: session.workspace,
      model,
      permission,
      mode,
      version: "0.1.0",
    },
    theme,
  );
  if (ui)
    ui.append(
      bannerLines(
        {
          id: session.id,
          workspace: session.workspace,
          model,
          permission,
          mode,
          version: "0.1.0",
        },
        ui.columns,
      ),
    );
  else styled(`\n${banner}\n`);

  try {
    while (!lifetime.signal.aborted) {
      let line: string;
      const inputCtrl = new AbortController();
      awaitingInput = inputCtrl;
      const inputSignal = AbortSignal.any([lifetime.signal, inputCtrl.signal]);
      const prompt = io.isTTY ? "❯ " : "forge> ";

      try {
        line = await io.question(prompt, inputSignal);
        while (line.endsWith("\\"))
          line = `${line.slice(0, -1)}\n${await io.question("... ", inputSignal)}`;
      } catch {
        if (inputCtrl.signal.aborted && !lifetime.signal.aborted) {
          safe.stdout("\n");
          continue;
        }
        break;
      } finally {
        awaitingInput = undefined;
      }

      interruptedOnce = false;
      if (!line.trim()) continue;

      try {
        if (line.startsWith("/")) {
          const [command, ...words] = line.trim().split(/\s+/);
          const value = words.join(" ");
          switch (command) {
            case "/quit":
              return 0;
            case "/help":
              if (ui) ui.append(helpLines(ui.columns));
              else styled(`${formatHelp(theme)}\n`);
              break;
            case "/model":
              if (value) {
                model = settingsFields.model.parse(value);
                safe.stdout(`Model: ${model}\n`);
                if (ui) await changeReasoning();
              } else {
                active = new AbortController();
                ui?.setBusy(true);
                const clearStatus = showOperation("Loading models");
                try {
                  const chosen = await pickModel(
                    service,
                    safe,
                    model,
                    active.signal,
                  );
                  if (chosen !== null && !active.signal.aborted) {
                    model = chosen;
                    safe.stdout(`Model: ${model}\n`);
                    if (ui) await changeReasoning();
                  }
                } finally {
                  clearStatus();
                }
              }
              break;
            case "/reasoning":
              await changeReasoning(value);
              break;
            case "/permission":
              if (value) permission = permissionSchema.parse(value);
              safe.stdout(`Permission: ${permission}\n`);
              break;
            case "/mode":
              if (value) {
                if (value !== "plan" && value !== "build")
                  throw Error("Expected plan or build.");
                mode = value;
              }
              safe.stdout(`Mode: ${mode}\n`);
              break;
            case "/plan": {
              const currentPlan =
                (await service.getSession(session.id)).plan ?? null;
              if (ui) ui.append(planLines(currentPlan, ui.columns));
              else styled(`${formatPlan(currentPlan, theme)}\n`);
              break;
            }
            case "/sessions": {
              const sessions = await service.listSessions();
              styled(`${formatSessions(sessions, session.id, theme)}\n`);
              break;
            }
            case "/resume": {
              active = new AbortController();
              ui?.setBusy(true);
              let clearStatus = showOperation(
                value ? "Loading session" : "Loading sessions",
              );
              try {
                const chosen =
                  value ||
                  (await pickSession(service, safe, session.id, active.signal));
                if (chosen === null || active.signal.aborted) break;
                if (!value) {
                  clearStatus();
                  clearStatus = showOperation("Loading session");
                }
                const resumed = await abortable(
                  service.getSession(parseSessionId(chosen)),
                  active.signal,
                );
                if (active.signal.aborted) break;
                session = resumed;
                model = session.model;
                safe.stdout("已恢复会话。\n");
              } finally {
                clearStatus();
              }
              break;
            }
            case "/new":
              session = await service.createSession(
                createSessionInputSchema.parse({
                  workspace: session.workspace,
                  model,
                }),
              );
              safe.stdout("已创建新会话。\n");
              break;
            case "/fork":
              session = await service.forkSession(
                session.id,
                value ? Number(value) : undefined,
              );
              model = session.model;
              safe.stdout("已分支会话。\n");
              break;
            case "/rename":
              session = await service.renameSession(session.id, value);
              safe.stdout("已重命名会话。\n");
              break;
            case "/archive":
              session = await service.archiveSession(session.id, true);
              safe.stdout("已归档会话。\n");
              break;
            case "/compact": {
              ui?.setBusy(true);
              active = new AbortController();
              const signal = active.signal;
              const clearStatus = showOperation("Compacting session");
              let cancel = (): void => {};
              const aborted = new Promise<never>((_resolve, reject) => {
                cancel = () =>
                  reject(new ForgeError("cancelled", "Compaction cancelled."));
                if (signal.aborted) cancel();
                else signal.addEventListener("abort", cancel, { once: true });
              });
              try {
                session = await Promise.race([
                  service.compactSession(session.id, signal),
                  aborted,
                ]);
              } finally {
                signal.removeEventListener("abort", cancel);
                clearStatus();
              }
              if (!signal.aborted) safe.stdout(`Compacted ${session.id}\n`);
              break;
            }
            case "/diagnostics":
              safe.stdout(
                `${JSON.stringify(await service.getDiagnostics(session.id), null, 2)}\n`,
              );
              break;
            case "/context":
              safe.stdout(
                `${JSON.stringify(await service.getProjectContext(session.id), null, 2)}\n`,
              );
              break;
            case "/skills":
              safe.stdout(
                `${JSON.stringify((await service.getProjectContext(session.id)).skills, null, 2)}\n`,
              );
              break;
            case "/checkpoints": {
              const action = words[0] ?? "list";
              if (action === "list")
                safe.stdout(
                  `${JSON.stringify(await service.listCheckpoints(session.id), null, 2)}\n`,
                );
              else if (action === "diff" && words[1] && words.length === 2)
                safe.stdout(
                  `${await service.getCheckpointDiff(session.id, words[1])}\n`,
                );
              else if (action === "restore" && words[1] && words.length === 2) {
                session = await service.restoreCheckpoint(session.id, words[1]);
                safe.stdout(`Restored ${session.id}\n`);
              } else
                throw Error("Expected /checkpoints [list|diff ID|restore ID].");
              break;
            }
            case "/mcp": {
              const [action, id, ...extra] = words;
              let result: unknown;
              if (action === "list") result = await service.listMcpServers();
              else if (action === "register" && id && extra.length >= 2)
                result = await service.registerMcpServer(
                  mcpRegisterInputSchema.parse({
                    id,
                    label: extra[0],
                    command: extra[1],
                    args: extra.slice(2),
                  }),
                );
              else if (id && (action === "enable" || action === "disable"))
                result = await service.setMcpEnabled(id, action === "enable");
              else if (id && action === "remove")
                result = await service.removeMcpServer(id);
              else if (id && action === "health")
                result = await service.getMcpHealth(id);
              else
                throw Error(
                  "Expected /mcp list|register|enable|disable|remove|health.",
                );
              safe.stdout(`${JSON.stringify(result ?? null, null, 2)}\n`);
              break;
            }
            case "/export":
              safe.stdout(
                `${JSON.stringify(await service.getSession(session.id), null, 2)}\n`,
              );
              break;
            default:
              safe.stderr(
                "Unknown or unavailable command. /help lists supported actions.\n",
              );
          }
          continue;
        }

        ui?.setBusy(true);
        active = new AbortController();
        live = new LiveRun(safe, theme);
        session = await service.run(
          runInputSchema.parse({
            sessionId: session.id,
            prompt: line,
            model,
            permission,
            mode,
          }),
          (event) => live?.event(event),
          async (request, signal) => {
            try {
              live?.pause();
              if (ui) return await ui.approve(request, signal);
              const prompt = terminalText(
                `Approval ${request.childSessionId ? `child ${request.childSessionId} ` : ""}${request.toolName}: ${JSON.stringify(request.description)}\nargv: ${JSON.stringify(request.command ?? [])}\nApprove? [y/N] `,
              );
              if (io.readApproval) {
                return await io.readApproval(prompt, signal);
              }
              const answer = await io.question(prompt, signal, {
                fresh: true,
              });
              return !signal.aborted && /^(y|yes)$/i.test(answer.trim());
            } catch {
              return false;
            } finally {
              live?.resume();
            }
          },
          active.signal,
        );
      } catch (error) {
        const info = toErrorInfo(error);
        safe.stderr(`${info.code}: ${info.message}\n`);
      } finally {
        live?.dispose();
        live = undefined;
        active = undefined;
        ui?.setBusy(false);
      }
    }
    return 0;
  } finally {
    offClose?.();
    off();
    active?.abort();
    ui?.dispose();
  }
}
