import { projectSummary } from "../core/context";
import { mcpRegisterInputSchema } from "../mcp/types";
import type { HarnessService } from "../shared/contracts";
import { budgetUsage, measureContext, resolveContextBudget, resolveContextWindow } from "../shared/context-usage";
import { ForgeError, toErrorInfo } from "../shared/errors";
import {
  createSessionInputSchema,
  parseSessionId,
  permissionSchema,
  runInputSchema,
  settingsFields,
} from "../shared/schemas";
import type { AgentEvent, ContextUsage } from "../shared/schemas";
import { type ApprovalMode, DEFAULT_APPROVAL_MODE, approvalWarning, parseApprovalAnswer, parseApprovalMode, shouldAutoApprove } from "./approval-policy";
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
import { watchResumedSession } from "./interactive/resumed-session";
import { showTasks } from "./interactive/tasks";
import {
  isActiveSession,
  pickModel,
  pickReasoningEffort,
  pickSession,
} from "./interactive/pickers";
import { RunQueue } from "./interactive/run-queue";
import { SessionCache } from "./interactive/session-cache";
import { LiveRun } from "./live-run";
import { historyLines } from "./render/history";
import { autoApprovalLines } from "./render/auto-approval";
import { plainLines, renderRichLine } from "./render/rich";
import { ToolTranscript } from "./render/tool-transcript";
import { createTheme } from "./theme";
import type { RichLine, RunStatus } from "./ui-contract";

export { terminalText };

export async function interactive(
  service: HarnessService,
  io: CliIO,
  workspace: string,
  sessionId: string | undefined,
  _render: (io: CliIO, event: AgentEvent) => void,
  initialApproval: ApprovalMode = DEFAULT_APPROVAL_MODE,
  initialExpandReasoning = false,
): Promise<number> {
  let settings = await service.getSettings();
  const ui = io.ui;
  let expandReasoning = initialExpandReasoning;
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
    : undefined;
  const sessionCache = new SessionCache(session);
  const requireSession = () => {
    if (!session) throw new ForgeError("invalid_input", "No active session. Send a message, use /new, or /resume first.");
    return session;
  };
  let tools = new ToolTranscript();
  const appendLines = (lines: readonly RichLine[]): void => {
    if (!lines.length) return;
    if (ui) ui.append(lines);
    else io.stdout(`${lines.map((line) => renderRichLine(line, theme)).join("\n")}\n`);
  };
  const showHistory = (): void => {
    ui?.setPlan?.(session?.plan ?? null);
    appendLines(historyLines(requireSession(), ui?.columns ?? 80, tools));
  };
  const toolCommand = (value: string): void => {
    if (value && !/^[1-9]\d*$/.test(value)) {
      safe.stderr("Expected /tools [N] (positive tool number).\n");
      return;
    }
    appendLines(value ? tools.detail(Number(value), ui?.columns ?? 80) : tools.list(ui?.columns ?? 80));
  };
  let model = session?.model ?? settings.model;
  let contextUsage: ContextUsage | null = null;
  let usageModel = model;
  let titleRefresh: ReturnType<typeof setTimeout> | undefined;
  let titleRefreshClosed = false;
  const windows = new Map<string, number | null>();
  const loadingWindows = new Set<string>();
  const refreshContext = (): void => {
    sessionCache.ensureSession(session);
    if (usageModel !== model) { contextUsage = null; usageModel = model; }
    const windowTokens = resolveContextWindow(model, settings, windows.get(model));
    const resolvedWindow = settings.modelContextWindows?.[model] ?? windows.get(model) ?? contextUsage?.windowTokens ?? windowTokens;
    const measured = contextUsage ? { ...contextUsage, windowTokens: resolvedWindow } : measureContext(session ? projectSummary(session) : [], resolvedWindow);
    const { budgetTokens: _oldTokens, budgetChars: _oldChars, ...currentUsage } = measured;
    ui?.setContext?.({
      model,
      reasoningEffort: settings.reasoningEffort ?? "default",
      sessionTitle: session?.title ?? "新会话",
      sessionCache: sessionCache.snapshot(),
      usage: { ...currentUsage, ...budgetUsage(resolveContextBudget(resolvedWindow, settings)) },
      estimated: true,
    });
    if (ui && !settings.modelContextWindows?.[model] && !windows.has(model) && !loadingWindows.has(model) && service.getModelContextWindow) {
      const requestedModel = model;
      loadingWindows.add(requestedModel);
      void service.getModelContextWindow(requestedModel, lifetime.signal).then(value => {
        windows.set(requestedModel, value);
        if (!lifetime.signal.aborted && model === requestedModel) refreshContext();
      }).catch(() => windows.set(requestedModel, null)).finally(() => loadingWindows.delete(requestedModel));
    }
  };
  const refreshAutoTitle = (): void => {
    if (titleRefresh) clearTimeout(titleRefresh);
    const completed = session;
    if (!ui || completed?.status !== "completed" || completed.titleSource !== "default") return;
    // Automatic naming is persisted asynchronously after run() returns (2s deadline).
    // Refresh metadata once without delaying input or replacing a newer snapshot.
    titleRefresh = setTimeout(() => {
      if (titleRefreshClosed || lifetime.signal.aborted || session !== completed || runInProgress) return;
      void service.getSession(completed.id).then(latest => {
        if (titleRefreshClosed || lifetime.signal.aborted || session !== completed || runInProgress) return;
        session = { ...completed, title: latest.title, titleSource: latest.titleSource,
          autoTitleAttempted: latest.autoTitleAttempted };
        refreshContext();
      }).catch(() => { /* Optional title metadata must not interrupt input. */ });
    }, 2200);
    titleRefresh.unref();
  };
  let mode: "build" | "plan" = "build";
  const currentMode = (): "build" | "plan" => mode;
  let permission = settings.defaultPermission;
  let approvalMode = parseApprovalMode(initialApproval);
  let autoApprovedCount = 0;
  const queue = new RunQueue();
  let runInProgress = false;
  const changeMode = (value: "build" | "plan") => {
    mode = value;
    ui?.setMode?.(mode);
    safe.stdout(`Mode: ${mode}${runInProgress ? " (next run only; current run unchanged)" : ""}\n`);
  };
  ui?.setMode?.(mode);
  const offMode = ui?.onModeToggle?.(() => changeMode(mode === "build" ? "plan" : "build"));
  let offRunInput: (() => void) | undefined;
  const pendingCommands: string[] = [];
  let commandBytes = 0;
  try {
    await ui?.configure({ theme: settings.theme });
  } catch (error) {
    ui?.dispose();
    throw error;
  }
  const lifetime = new AbortController();
  refreshContext();
  let active: AbortController | undefined;
  let awaitingInput: AbortController | undefined;
  let interruptedOnce = false;
  let taskPanel: AbortController | undefined;
  let taskPanelWork: Promise<void> | undefined;
  let taskApproval = false;
  const closeTasks = async (): Promise<void> => {
    taskPanel?.abort();
    await taskPanelWork;
  };
  const openTasks = (value = ""): Promise<void> => {
    if (taskPanelWork) return taskPanelWork;
    if (taskApproval || lifetime.signal.aborted) return Promise.resolve();
    if (!service.tasks || !session) {
      safe.stdout(!session ? "No active session. Start or resume a session before /tasks.\n" : "Task panel is unavailable in this host.\n");
      return Promise.resolve();
    }
    const controller = new AbortController();
    taskPanel = controller;
    const parentId = session.id;
    const work = showTasks(service.tasks, safe, parentId, AbortSignal.any([lifetime.signal, controller.signal]), value)
      .catch(error => { if (!controller.signal.aborted && !lifetime.signal.aborted) safe.stderr(`${toErrorInfo(error).message}\n`); })
      .finally(() => { if (taskPanel === controller) { taskPanel = undefined; taskPanelWork = undefined; } });
    taskPanelWork = work;
    return work;
  };
  let live: LiveRun | undefined;
  let statusGeneration = 0;
  let activeStatus: number | undefined;
  let stopResumedWatch: (() => void) | undefined;
  let resumedStartedAt = 0;
  const resumedStatus = (): RunStatus => ({
    label: session?.status === "awaiting_approval" ? "会话等待审批" : "会话仍在运行",
    startedAt: resumedStartedAt, toolCount: 0, cancellable: false, observing: true,
  });
  const clearResumedWatch = (): void => {
    if (!stopResumedWatch) return;
    stopResumedWatch();
    stopResumedWatch = undefined;
    if (activeStatus === undefined && !runInProgress) ui?.setStatus(null);
  };
  const observeResumed = (): void => {
    clearResumedWatch();
    if (!session || !isActiveSession(session.status)) return;
    resumedStartedAt = Date.now();
    if (activeStatus === undefined) ui?.setStatus(resumedStatus());
    stopResumedWatch = watchResumedSession(session, service, lifetime.signal, latest => {
      session = latest;
      sessionCache.restore(latest);
      refreshContext();
      ui?.setPlan?.(latest.plan ?? null);
      if (!isActiveSession(latest.status)) {
        clearResumedWatch();
        safe.stdout(`会话运行已结束（${latest.status}）。\n`);
      } else if (activeStatus === undefined && !runInProgress) ui?.setStatus(resumedStatus());
    }, () => {
      clearResumedWatch();
      safe.stderr("会话状态刷新失败，已停止动画；可用 /resume 重新检查。\n");
    });
  };

  const inputHint = (): void => {
    ui?.setInputHint?.(runInProgress
      ? "Enter queues · /steer <message> or Alt+Enter steers"
      : queue.length ? `${queue.length} pending${queue.paused ? " · paused · /queue run" : ""} · /queue` : null);
    ui?.setPendingInput?.(queue.preview());
  };
  const addSteering = (text: string): void => {
    if (!text.trim()) throw new ForgeError("invalid_input", "Expected /steer <message>.");
    queue.add("steer", text);
    safe.stdout("Steer accepted for this run; waiting for the current model/tool exchange to finish.\n");
  };
  const resetSessionControls = (): void => {
    clearResumedWatch();
    sessionCache.restore(session);
    contextUsage = null;
    ui?.setPlan?.(session?.plan ?? null);
    if (queue.length) safe.stdout("Pending input cleared on session change.\n");
    queue.clear();
    // Preserve an explicit manual choice across /new and /resume in this CLI session.
    safe.stdout(`Command approval: ${approvalMode} (unchanged; CLI session only).\n`);
    inputHint();
  };
  const queueCommand = (value: string): void => {
    if (!value) safe.stdout(queue.describe());
    else if (value === "clear") { queue.clear(); safe.stdout("Queue cleared.\n"); }
    else if (value === "run" && !runInProgress) { queue.paused = false; safe.stdout("Queue resumed.\n"); }
    else throw new ForgeError("invalid_input", "Expected /queue [clear|run]; run is available only at the prompt.");
    inputHint();
  };
  const receiveInput = (raw: string, steer = false): void => {
    if (lifetime.signal.aborted) return;
    const text = terminalText(raw).trim();
    if (!text) return;
    try {
      if (text.startsWith("/")) {
        if (/^\/steer(?:\s|$)/.test(text)) addSteering(text.slice(6).trim());
        else if (text === "/queue" || text.startsWith("/queue ")) queueCommand(text.slice(6).trim());
        else if (text === "/tools" || text.startsWith("/tools ")) toolCommand(text.slice(6).trim());
        else if (text === "/tasks" || text.startsWith("/tasks ")) void openTasks(text.slice(6).trim());
        else if (text === "/help") {
          if (ui) ui.append(helpLines(ui.columns));
          else styled(`${formatHelp(theme)}\n`);
        } else if (text === "/quit" || text === "/exit") {
          lifetime.abort();
          active?.abort();
        } else if (text === "/mode" || text.startsWith("/mode ")) {
          const value = text.slice(5).trim();
          if (value) {
            if (value !== "plan" && value !== "build") throw Error("Expected plan or build.");
            changeMode(value);
          } else safe.stdout(`Mode: ${mode}\n`);
        } else if (text === "/permission" || text.startsWith("/permission ")) {
          const value = text.slice(11).trim();
          if (value) permission = permissionSchema.parse(value);
          safe.stdout(`Permission: ${permission}\n`);
        } else if (text === "/approval" || text.startsWith("/approval ")) {
          const value = text.slice(9).trim();
          if (value) {
            approvalMode = parseApprovalMode(value);
            safe.stdout(`${approvalWarning(approvalMode)}\n`);
          }
          safe.stdout(`Command approval: ${approvalMode} (session only).\n`);
        } else {
          const size = Buffer.byteLength(text);
          if (pendingCommands.length >= 1_000 || commandBytes + size > 1_000_000)
            throw new ForgeError("invalid_input", "Pending command limit exceeded.");
          pendingCommands.push(text);
          commandBytes += size;
          safe.stdout("Command accepted; will execute after the current run.\n");
        }
      } else if (steer) {
        addSteering(text);
      } else {
        queue.add("follow-up", text);
        safe.stdout(`Follow-up queued (${queue.length} pending).\n`);
      }
      inputHint();
    } catch (error) {
      const info = toErrorInfo(error);
      safe.stderr(`${info.code}: ${info.message}\n`);
    }
  };

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
      ui.setStatus(stopResumedWatch ? resumedStatus() : null);
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
    // Settings are readonly; replace the local copy so the footer reflects the save.
    settings = { ...settings, reasoningEffort };
    refreshContext();
    safe.stdout(`Reasoning effort: ${reasoningEffort} (saved)\n`);
  };

  const offClose = io.onClose?.(() => {
    lifetime.abort();
    active?.abort();
    awaitingInput?.abort();
  });

  const off = io.onInterrupt(() => {
    if (taskPanel) { taskPanel.abort(); return; }
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
      id: session?.id ?? "not created",
      workspace: session?.workspace ?? workspace,
      model,
      reasoningEffort: settings.reasoningEffort ?? "default",
      sessionTitle: session?.title ?? "新会话",
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
          id: session?.id ?? "not created",
          workspace: session?.workspace ?? workspace,
          model,
          reasoningEffort: settings.reasoningEffort ?? "default",
          sessionTitle: session?.title ?? "新会话",
          permission,
          mode,
          version: "0.1.0",
        },
        ui.columns,
      ),
    );
  else styled(`\n${banner}\n`);
  safe.stdout(`${approvalWarning(approvalMode)}\n`);
  if (sessionId) { showHistory(); observeResumed(); }

  try {
    while (!lifetime.signal.aborted) {
      let line: string;
      let fromQueue = false;
      const inputCtrl = new AbortController();
      awaitingInput = inputCtrl;
      const inputSignal = AbortSignal.any([lifetime.signal, inputCtrl.signal]);
      const prompt = io.isTTY ? "❯ " : "forge> ";

      try {
        const command = pendingCommands.shift();
        if (command !== undefined) commandBytes -= Buffer.byteLength(command);
        const queued = command === undefined ? queue.take() : undefined;
        fromQueue = queued !== undefined;
        inputHint();
        line = command ?? queued ?? await io.question(prompt, inputSignal);
        while (command === undefined && queued === undefined && line.endsWith("\\"))
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
        if (!fromQueue && line.startsWith("/")) {
          const [command, ...words] = line.trim().split(/\s+/);
          const value = words.join(" ");
          switch (command) {
            case "/quit":
            case "/exit":
              return 0;
            case "/tasks":
              await openTasks(value);
              break;
            case "/steer":
              throw new ForgeError("invalid_input", "/steer requires an active run; send a normal prompt when idle.");
            case "/help":
              if (ui) ui.append(helpLines(ui.columns));
              else styled(`${formatHelp(theme)}\n`);
              break;
            case "/model":
              if (value) {
                model = settingsFields.model.parse(value);
                safe.stdout(`Model: ${model}\n`);
                refreshContext();
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
                    refreshContext();
                    if (ui) await changeReasoning();
                  }
                } finally {
                  clearStatus();
                }
              }
              break;
            case "/history": {
              const action = value || "status";
              if (action !== "on" && action !== "off" && action !== "clear" && action !== "status") throw new ForgeError("invalid_input", "Expected /history [on|off|clear|status].");
              safe.stdout(`${await io.promptHistory?.(action, session?.workspace ?? workspace) ?? "Prompt history is unavailable in this adapter."}\n`);
              break;
            }
            case "/reasoning":
              await changeReasoning(value);
              break;
            case "/thinking": {
              const arg = value.toLowerCase().trim();
              if (arg === "on" || arg === "expand" || arg === "expanded" || arg === "true") {
                expandReasoning = true;
              } else if (arg === "off" || arg === "compact" || arg === "false") {
                expandReasoning = false;
              } else if (!arg) {
                expandReasoning = !expandReasoning;
              } else {
                throw new ForgeError("invalid_input", "Expected /thinking [on|off].");
              }
              safe.stdout(`Thinking display: ${expandReasoning ? "expanded (stream full thoughts)" : "compact (single-line preview)"} (session only).\n`);
              break;
            }
            case "/approval":
              if (value) {
                approvalMode = parseApprovalMode(value);
                safe.stdout(`${approvalWarning(approvalMode)}\n`);
              }
              safe.stdout(`Command approval: ${approvalMode} (session only).\n`);
              break;
            case "/queue":
              queueCommand(value);
              break;
            case "/tools":
              toolCommand(value);
              break;
            case "/permission":
              if (value) permission = permissionSchema.parse(value);
              safe.stdout(`Permission: ${permission}\n`);
              break;
            case "/mode":
              if (value) {
                if (value !== "plan" && value !== "build")
                  throw Error("Expected plan or build.");
                changeMode(value);
              } else safe.stdout(`Mode: ${mode}\n`);
              break;
            case "/plan": {
              const currentPlan =
                (await service.getSession(requireSession().id)).plan ?? null;
              ui?.setPlan?.(currentPlan);
              if (ui) ui.append(planLines(currentPlan, ui.columns));
              else styled(`${formatPlan(currentPlan, theme)}\n`);
              break;
            }
            case "/sessions": {
              const sessions = await service.listSessions();
              styled(`${formatSessions(sessions, session?.id, theme)}\n`);
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
                  (await pickSession(service, safe, session?.id ?? "", active.signal));
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
                try { await io.promptHistory?.("scope", session.workspace); }
                catch { safe.stderr("Prompt history unavailable for this workspace; recording off.\n"); }
                tools = new ToolTranscript();
                resetSessionControls();
                model = session.model;
                safe.stdout("已恢复会话。\n");
                showHistory();
                observeResumed();
              } finally {
                clearStatus();
              }
              break;
            }
            case "/new":
              session = await service.createSession(
                createSessionInputSchema.parse({
                  workspace: session?.workspace ?? workspace,
                  model,
                }),
              );
              tools = new ToolTranscript();
              resetSessionControls();
              safe.stdout("已创建新会话。\n");
              break;
            case "/fork":
              session = await service.forkSession(
                requireSession().id,
                value ? Number(value) : undefined,
              );
              tools = new ToolTranscript();
              resetSessionControls();
              showHistory();
              model = session.model;
              safe.stdout("已分支会话。\n");
              break;
            case "/rename":
              session = await service.renameSession(requireSession().id, value);
              safe.stdout("已重命名会话。\n");
              break;
            case "/archive":
              session = await service.archiveSession(requireSession().id, true);
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
                  service.compactSession(requireSession().id, signal),
                  aborted,
                ]);
              } finally {
                signal.removeEventListener("abort", cancel);
                clearStatus();
              }
              if (!signal.aborted) contextUsage = null;
              if (!signal.aborted) safe.stdout(`Compacted ${requireSession().id}\n`);
              break;
            }
            case "/diagnostics":
              safe.stdout(
                `${JSON.stringify(await service.getDiagnostics(requireSession().id), null, 2)}\n`,
              );
              break;
            case "/context":
              safe.stdout(
                `${JSON.stringify(await service.getProjectContext(requireSession().id), null, 2)}\n`,
              );
              break;
            case "/skills":
              safe.stdout(
                `${JSON.stringify((await service.getProjectContext(requireSession().id)).skills, null, 2)}\n`,
              );
              break;
            case "/checkpoints": {
              const action = words[0] ?? "list";
              if (action === "list")
                safe.stdout(
                  `${JSON.stringify(await service.listCheckpoints(requireSession().id), null, 2)}\n`,
                );
              else if (action === "diff" && words[1] && words.length === 2)
                safe.stdout(
                  `${await service.getCheckpointDiff(requireSession().id, words[1])}\n`,
                );
              else if (action === "restore" && words[1] && words.length === 2) {
                session = await service.restoreCheckpoint(requireSession().id, words[1]);
                safe.stdout(`Restored ${requireSession().id}\n`);
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
                `${JSON.stringify(await service.getSession(requireSession().id), null, 2)}\n`,
              );
              break;
            default:
              safe.stderr(
                "Unknown or unavailable command. /help lists supported actions.\n",
              );
          }
          continue;
        }

        if (lifetime.signal.aborted) break;
        session ??= await service.createSession(createSessionInputSchema.parse({ workspace, model }));
        if (lifetime.signal.aborted) break;
        clearResumedWatch();
        refreshContext();
        ui?.setBusy(true);
        active = new AbortController();
        live = new LiveRun(safe, theme, tools, () => expandReasoning);
        runInProgress = true;
        inputHint();
        offRunInput = io.onRunInput?.(receiveInput);
        const runMode = currentMode();
        const runPermission = permission;
        session = await service.run(
          runInputSchema.parse({
            sessionId: requireSession().id,
            prompt: line,
            model,
            permission,
            mode,
          }),
          (event) => {
            sessionCache.push(event);
            if (event.sessionId === requireSession().id) {
              if (event.type === "context_usage") contextUsage = event.usage;
              if (event.type === "context_usage" || event.type === "run_finished") refreshContext();
            }
            if (event.type === "plan_updated" && event.sessionId === requireSession().id) ui?.setPlan?.(event.plan);
            live?.event(event);
          },
          async (request, signal) => {
            const ceiling = requireSession().permissionCeiling ?? runPermission;
            const eligiblePermission = runMode === "plan" || ceiling === "readonly" ? "readonly" : runPermission;
            if (signal.aborted || eligiblePermission === "readonly") return false;
            if (shouldAutoApprove(approvalMode, eligiblePermission, request, signal)) {
              autoApprovedCount++;
              if (request.childSessionId) live?.childApproval(request);
              else appendLines(autoApprovalLines(request, ui?.columns ?? 80));
              return true;
            }
            taskApproval = true;
            try {
              await closeTasks();
              live?.pause();
              if (ui) {
                const approved = await ui.approve(request, signal);
                return !signal.aborted && approved;
              }
              const prompt = terminalText(
                `Approval ${request.childSessionId ? `child ${request.childSessionId} ` : ""}${request.toolName}: ${JSON.stringify(request.description)}\nargv: ${JSON.stringify(request.command ?? [])}\nEnter approves; commands are not sandboxed.\nApprove? [Y/n] `,
              );
              if (io.readApproval) {
                const approved = await io.readApproval(prompt, signal);
                return !signal.aborted && approved;
              }
              const answer = await io.question(prompt, signal, {
                fresh: true,
              });
              return !signal.aborted && parseApprovalAnswer(answer);
            } catch {
              return false;
            } finally {
              taskApproval = false;
              live?.resume();
            }
          },
          active.signal,
          { drainSteering: () => {
            const messages = queue.drainSteering();
            if (messages.length) safe.stdout(`Steer handed to the active run (${messages.length}); preparing the next model request.\n`);
            inputHint();
            return messages;
          } },
        );
        refreshAutoTitle();
        queue.finish(session.status === "completed" && !active.signal.aborted);
        if (queue.length && queue.paused) safe.stdout("Pending input paused; /queue to inspect, /queue run to continue, /queue clear to discard.\n");
      } catch (error) {
        if (runInProgress) {
          queue.finish(false);
          if (queue.length) safe.stdout("Pending input paused; /queue run to continue.\n");
        }
        const info = toErrorInfo(error);
        safe.stderr(`${info.code}: ${info.message}\n`);
      } finally {
        await closeTasks();
        if (runInProgress) safe.stdout(`Approval summary: ${autoApprovedCount} tool request(s) auto-approved this run.\n`);
        autoApprovedCount = 0;
        offRunInput?.();
        offRunInput = undefined;
        runInProgress = false;
        inputHint();
        live?.dispose();
        live = undefined;
        active = undefined;
        refreshContext();
        ui?.setBusy(false);
      }
    }
    return 0;
  } finally {
    await closeTasks();
    clearResumedWatch();
    titleRefreshClosed = true;
    if (titleRefresh) clearTimeout(titleRefresh);
    offRunInput?.();
    offMode?.();
    offClose?.();
    off();
    active?.abort();
    ui?.dispose();
  }
}
