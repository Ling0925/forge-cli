import { homedir } from "node:os";
import type { HarnessService } from "../../shared/contracts";
import { settingsFields } from "../../shared/schemas";
import { isPrimarySession } from "../../shared/sessions";
import type { CliIO } from "../cli";
import type { PickerSpec } from "../ui-contract";
import { abortable } from "./abortable";

async function choose(
  io: CliIO,
  spec: PickerSpec,
  signal: AbortSignal,
): Promise<string | null> {
  // Discovery status is only for the pending list call. Clear it before any
  // picker, empty message, or cancellation return so the composer is not idle
  // behind a stale loading line.
  io.ui?.setStatus(null);
  if (signal.aborted) return null;
  if (!spec.items.length) {
    io.stdout(`${spec.emptyLabel ?? "No entries available."}\n`);
    return null;
  }
  if (io.ui) return io.ui.choose(spec, signal);
  io.stdout(
    `${spec.title}\n${spec.items.map((item) => `${item.value}${item.detail ? ` — ${item.detail}` : ""}`).join("\n")}\n`,
  );
  // Plain adapters retain readable lists; selection is explicit, never a fallback.
  io.stdout("Use the command with an exact ID to select.\n");
  return null;
}

export async function pickModel(
  service: HarnessService,
  io: CliIO,
  selected: string,
  signal: AbortSignal,
  sourceId?: string,
): Promise<string | null> {
  const models = await abortable(sourceId === undefined ? service.listModels(signal) : service.listModels(signal, sourceId), signal);
  return choose(
    io,
    {
      title: "Available Models",
      selected,
      placeholder: "Filter models",
      emptyLabel: "No models available.",
      items: models.map((value) => ({ value, label: value })),
    },
    signal,
  );
}

export function pickReasoningEffort(
  io: CliIO,
  selected: string,
  signal: AbortSignal,
): Promise<string | null> {
  return choose(
    io,
    {
      title: "Reasoning Effort",
      selected,
      placeholder: "Filter reasoning effort",
      items: settingsFields.reasoningEffort.unwrap().options.map((value) => ({
        value,
        label: value,
        detail:
          value === "default"
            ? "Use provider default"
            : value === "none"
              ? "Disable reasoning (if supported)"
              : "Model/gateway support required",
      })),
    },
    signal,
  );
}

export const isActiveSession = (status: string): boolean =>
  status === "running" || status === "awaiting_approval";

export function sessionDetail(
  status: string,
  workspace: string,
  updatedAt: string,
): string {
  const labels: Readonly<Record<string, string>> = {
    idle: "Ready",
    running: "Running",
    awaiting_approval: "Needs approval",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    interrupted: "Interrupted",
  };
  const date = new Date(updatedAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = Number.isNaN(date.getTime())
    ? "Unknown time"
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const home = homedir();
  const path =
    workspace === home
      ? "~"
      : workspace.startsWith(`${home}/`)
        ? `~${workspace.slice(home.length)}`
        : workspace;
  return `${labels[status] ?? status} · ${time}\n${path}`;
}

export async function pickSession(
  service: HarnessService,
  io: CliIO,
  selected: string,
  signal: AbortSignal,
): Promise<string | null> {
  const sessions = await abortable(service.listSessions(), signal);
  return choose(
    io,
    {
      title: "Resume session",
      selected,
      placeholder: "Filter sessions",
      emptyLabel: "No sessions available.",
      items: sessions.filter(isPrimarySession).map((session) => ({
        value: session.id,
        label: session.title,
        ...(isActiveSession(session.status) ? { active: true } : {}),
        detail: sessionDetail(
          session.status,
          session.workspace,
          session.updatedAt,
        ),
      })),
    },
    signal,
  );
}
