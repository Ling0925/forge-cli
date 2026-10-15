import type { SessionId } from "../../shared/schemas";
import type { TaskService, TaskView, TaskPage, TaskDetail } from "../../shared/task-view";
import type { CliIO } from "../cli";
import { terminalText } from "../format";
import type { PickerSpec } from "../ui-contract";

const PAGE_SIZE = 20;
const RESULT_SIZE = 6000;
const hint = "Use /tasks agent|command ID or /tasks stop agent|command ID (full ID).\n";
const bounded = (text: string, limit = 500): string => terminalText(text).slice(0, limit);
const identity = (task: TaskView): string => `${task.kind} ${task.id}`;
const summary = (task: TaskView): string => [
  bounded(task.status, 80),
  task.model && `model: ${bounded(task.model, 160)}`,
  task.activity && `current tool: ${bounded(task.activity, 160)}`,
  task.usage && `usage: ${task.usage.promptTokens} in / ${task.usage.completionTokens} out`,
  task.exitCode !== undefined && task.exitCode !== null && `exit: ${task.exitCode}`,
  task.historical && "historical (read-only)",
].filter(Boolean).join(" · ");

/** Cancel observation, not the underlying task; always remove our listener. */
function observe<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error("Task panel closed.")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function listSpec(page: TaskPage): PickerSpec {
  const tasks = [...page.tasks].slice(0, PAGE_SIZE).sort((a, b) => Number(b.active) - Number(a.active));
  return {
    title: "Tasks",
    placeholder: "Filter tasks by title, status, model or full ID",
    emptyLabel: "No tasks on this page.",
    items: [
      ...tasks.map(task => ({
        value: identity(task),
        label: `${task.kind} · ${bounded(task.title, 180)}`,
        detail: `${task.id}\n${summary(task)}`,
        active: task.active,
      })),
      ...(page.offset > 0 ? [{ value: ":previous", label: "Previous page" }] : []),
      ...(page.nextOffset !== null ? [{ value: ":next", label: "Next page" }] : []),
      { value: ":refresh", label: "Refresh tasks", detail: `Page offset ${page.offset}${page.truncated ? " · more available" : ""}` },
      { value: ":close", label: "Close" },
    ],
  };
}

async function listChoice(
  service: TaskService, io: CliIO, parentId: SessionId, signal: AbortSignal, initial: TaskPage,
): Promise<{ choice: string | null; page: TaskPage }> {
  if (!io.ui) return { choice: null, page: initial };
  const ui = io.ui;
  const local = new AbortController();
  const abort = () => local.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) local.abort();
  let page = initial;
  let open = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshError: unknown;
  const refresh = async (): Promise<void> => {
    try {
      const next = await observe(service.listTasks(parentId, initial.offset, PAGE_SIZE), local.signal);
      if (!open || local.signal.aborted) return;
      page = next;
      ui.updatePicker?.(listSpec(page));
      timer = setTimeout(() => { void refresh(); }, 1000);
    } catch (error) {
      if (open && !local.signal.aborted) { refreshError = error; local.abort(); }
    }
  };
  try {
    if (ui.updatePicker && !local.signal.aborted) timer = setTimeout(() => { void refresh(); }, 1000);
    const choice = await ui.choose(listSpec(page), local.signal);
    if (refreshError) throw refreshError;
    return { choice, page };
  } finally {
    open = false;
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    local.abort();
  }
}

function printDetail(io: CliIO, detail: TaskDetail): void {
  io.stdout(`${identity(detail.task)} · ${bounded(detail.task.title)}\n${summary(detail.task)}\n`);
  if (detail.note) io.stdout(`${bounded(detail.note)}\n`);
  io.stdout(`${bounded(detail.content, RESULT_SIZE)}\n`);
  if (detail.nextOffset !== null || detail.truncated) io.stdout(`Result is paginated (offset ${detail.offset}).\n`);
}

async function getExact(
  service: TaskService, parentId: SessionId, kind: TaskView["kind"], id: string,
  signal: AbortSignal, offset = 0,
): Promise<TaskDetail> {
  const detail = await observe(service.getTask(parentId, kind, id, offset, RESULT_SIZE), signal);
  if (detail.task.id !== id || detail.task.kind !== kind) throw new Error("Unknown task: use its exact full ID.");
  return detail;
}

async function stop(
  service: TaskService, io: CliIO, parentId: SessionId, detail: TaskDetail, signal: AbortSignal,
): Promise<void> {
  if (!detail.task.active || !detail.task.controllable || detail.task.historical) {
    io.stdout("This task cannot be stopped from this panel.\n");
    return;
  }
  if (!io.ui) {
    io.stdout("Stopping requires an interactive confirmation; no task was stopped.\n");
    return;
  }
  const choice = await io.ui.choose({
    title: `Stop ${identity(detail.task)}?`,
    confirmation: true,
    selected: ":cancel",
    items: [
      { value: ":cancel", label: "Cancel (default)" },
      { value: ":stop", label: "Stop task", detail: `${bounded(detail.task.title)}\nThis cannot be undone.` },
    ],
  }, signal);
  if (choice !== ":stop" || signal.aborted) return;
  // Revalidate ownership/state after confirmation. Never infer stop permission from stale rows.
  const latest = await getExact(service, parentId, detail.task.kind, detail.task.id, signal);
  if (signal.aborted || !latest.task.active || !latest.task.controllable || latest.task.historical) {
    io.stdout("This task is no longer stoppable.\n");
    return;
  }
  // The host owns stop/join. Closing this panel must not block a pending approval;
  // observe still attaches a rejection handler to the stop operation after abort.
  const stopped = await observe(service.stopTask(parentId, latest.task.kind, latest.task.id), signal);
  if (!signal.aborted) io.stdout(stopped ? "Task stopped.\n" : "Task was not stopped.\n");
}

async function showDetail(
  service: TaskService, io: CliIO, parentId: SessionId, signal: AbortSignal,
  kind: TaskView["kind"], id: string,
): Promise<void> {
  let offset = 0;
  const previous: number[] = [];
  while (!signal.aborted) {
    const detail = await getExact(service, parentId, kind, id, signal, offset);
    if (!io.ui) { printDetail(io, detail); io.stdout(hint); return; }
    const action = await io.ui.choose({
      title: `Task ${kind} ${id}`,
      selected: ":back",
      items: [
        { value: ":result", label: "View result in history", detail: `${bounded(detail.task.title)}\n${summary(detail.task)}${detail.note ? `\n${bounded(detail.note)}` : ""}` },
        ...(detail.nextOffset !== null ? [{ value: ":next", label: "Next result page" }] : []),
        ...(previous.length ? [{ value: ":previous", label: "Previous result page" }] : []),
        ...(detail.task.active && detail.task.controllable && !detail.task.historical
          ? [{ value: ":stop", label: "Stop task…", detail: "Requires a separate confirmation" }] : []),
        { value: ":back", label: "Back" },
      ],
    }, signal);
    if (signal.aborted || action === null || action === ":back") return;
    if (action === ":result") printDetail(io, detail);
    else if (action === ":next" && detail.nextOffset !== null) {
      previous.push(offset); offset = detail.nextOffset;
    } else if (action === ":previous") offset = previous.pop() ?? 0;
    else if (action === ":stop") await stop(service, io, parentId, detail, signal);
  }
}

/** Local host panel only: no tool calls, session switching, resolution or reruns. */
export async function showTasks(
  service: TaskService, io: CliIO, parentId: SessionId, signal: AbortSignal, value?: string,
): Promise<void> {
  if (signal.aborted) return;
  try {
    const args = value?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (args.length) {
      const stopping = args[0] === "stop";
      const [kind, id] = stopping ? args.slice(1) : args;
      if (args.length !== (stopping ? 3 : 2) || (kind !== "agent" && kind !== "command") || !id) {
        io.stderr(`Invalid /tasks arguments. ${hint}`); return;
      }
      if (stopping) await stop(service, io, parentId, await getExact(service, parentId, kind, id, signal), signal);
      else await showDetail(service, io, parentId, signal, kind, id);
      return;
    }
    let offset = 0;
    const previous: number[] = [];
    while (!signal.aborted) {
      const initial = await observe(service.listTasks(parentId, offset, PAGE_SIZE), signal);
      if (!io.ui) {
        const spec = listSpec(initial);
        io.stdout(`Tasks\n${spec.items.filter(item => !item.value.startsWith(":"))
          .map(item => `${item.value} · ${item.label}\n${item.detail ?? ""}`).join("\n")}\n`);
        if (!initial.tasks.length) io.stdout("No tasks.\n");
        if (initial.nextOffset !== null || initial.truncated) io.stdout("More tasks available in the interactive panel.\n");
        io.stdout(hint); return;
      }
      const { choice, page } = await listChoice(service, io, parentId, signal, initial);
      if (signal.aborted || choice === null || choice === ":close") return;
      if (choice === ":next" && page.nextOffset !== null) { previous.push(offset); offset = page.nextOffset; }
      else if (choice === ":previous") offset = previous.pop() ?? Math.max(0, offset - PAGE_SIZE);
      else if (choice !== ":refresh") {
        const task = page.tasks.find(task => identity(task) === choice);
        if (task) await showDetail(service, io, parentId, signal, task.kind, task.id);
      }
    }
  } catch (error) {
    if (!signal.aborted) io.stderr(`Tasks: ${bounded(error instanceof Error ? error.message : String(error))}\n`);
  }
}
