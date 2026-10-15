import type { ToolResult } from "../../shared/schemas";

/** Floor fractional display values to avoid showing 60s before the m boundary. */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "?";
  const units: readonly (readonly [number, string])[] = [
    [86400000, "d"], [3600000, "h"], [60000, "m"], [1000, "s"], [1, "ms"],
  ];
  const [divisor, suffix] = units.find(([size]) => milliseconds >= size) ?? [1, "ms"];
  const value = milliseconds / divisor;
  return `${divisor === 1 ? Math.floor(value) : Math.floor(value * 10) / 10}${suffix}`;
}

export function toolDuration(name: string | undefined, result: ToolResult, elapsed?: number): number | undefined {
  if (elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0) return elapsed;
  if (name !== "run_command") return undefined;
  try {
    const raw: unknown = JSON.parse(result.content);
    if (typeof raw === "object" && raw !== null && "duration_ms" in raw
      && typeof raw.duration_ms === "number" && Number.isFinite(raw.duration_ms) && raw.duration_ms >= 0) return raw.duration_ms;
  } catch { /* Legacy/non-JSON results carry no execution duration. */ }
  return undefined;
}

export function durationSuffix(name: string | undefined, result: ToolResult, elapsed?: number): string {
  const duration = toolDuration(name, result, elapsed);
  return duration === undefined ? "" : ` · ${formatDuration(duration)}`;
}
