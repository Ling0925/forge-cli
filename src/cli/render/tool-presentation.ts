import { toolResultSchema, type ToolResult } from "../../shared/schemas";
import { textLines } from "./envelope";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : undefined;
const decode = (text: string): unknown => {
  if (text.length > 262144) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};
const scalar = (value: unknown): string =>
  typeof value === "string" ? value.slice(0, 500) : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const first = (text: unknown): string => typeof text === "string" ? textLines(text)[0] ?? "" : "";
const paths = (items: readonly unknown[]): string => items.slice(0, 2).map(item => scalar(object(item)?.path)).filter(Boolean).join(", ");

/** Only history restoration calls this: live results must not be mistaken for
 * envelopes merely because an external tool returned content/isError fields. */
export function savedToolResult(content: string): ToolResult {
  const parsed = toolResultSchema.safeParse(decode(content));
  return parsed.success ? parsed.data : { content, isError: false };
}

const agentTools = new Set(["spawn_agent", "list_agents", "wait_agents", "get_agent_result", "send_agent_message", "resolve_agent", "cancel_agent"]);
const agentHasFailure = (record: Record<string, unknown> | undefined): boolean =>
  record?.status === "failed" || Boolean(record?.error) || array(record?.errors).length > 0;

function agentOverview(items: readonly unknown[], total?: number): string {
  const states = new Map<string, number>();
  for (const item of items) {
    const record = object(item);
    const status = scalar(record?.status) || (agentHasFailure(record) ? "failed" : "unknown");
    const state = record?.handled === true && agentHasFailure(record) ? `${status} (handled)` : status;
    states.set(state, (states.get(state) ?? 0) + 1);
  }
  return `${items.length} agents${total === undefined ? "" : ` / ${total} total`}${states.size ? ` · ${[...states].slice(0, 5).map(([s, n]) => `${n} ${s}`).join(" · ")}` : ""}`;
}

/** Explicit adapters for Forge tools. Unrecognized/external payloads are kept
 * for /tools N, not dumped into the transcript as JSON. */
function builtinDetail(name: string, r: Record<string, unknown>, value: unknown): string | undefined {
  switch (name) {
    case "read_file": {
      if (r.unchanged === true) return "Unchanged version · content omitted (omit if_version to reread)";
      if (typeof r.content !== "string" || typeof r.offset !== "number" || typeof r.total_lines !== "number") break;
      const count = r.content ? r.content.split("\n").length : 0;
      return `${count ? `lines ${r.offset + 1}–${r.offset + count}` : "0 lines read"} / ${r.total_lines} total${r.cache_hit === true ? " · cached" : ""}`;
    }
    case "list_files": return `${array(r.entries).length} entries · ${paths(array(r.entries))}`;
    case "search_files": {
      const matches = array(r.matches);
      if (r.mode === "files") return `${matches.length} matching files · ${paths(matches)}`;
      if (r.mode === "count") return `${matches.length} file counts · ${matches.reduce<number>((sum, item) => sum + (typeof object(item)?.count === "number" ? Number(object(item)?.count) : 0), 0)} matching lines on this page`;
      return `${matches.length} matches · ${matches.slice(0, 2).map(item => { const m = object(item); return `${scalar(m?.path)}:${scalar(m?.line)}`; }).join(", ")}`;
    }
    case "write_file": return r.unchanged === true ? "No changes · content already matches" : r.written === true ? "File written" : "Write result unavailable";
    case "edit_file": return r.unchanged === true ? "No changes · replacement already matches" : r.edited === true ? `File edited · ${scalar(r.replacements)} replacements` : "Edit result unavailable";
    case "make_directory": return r.created === true ? "Directory ready" : "Directory result unavailable";
    case "run_command": {
      if (r.background === true) return `Task ${scalar(r.id)} · ${scalar(r.status)} · command_task to inspect`;
      // Duration is shown once in the card header for every tool.
      return first(r.stderr) || first(r.stdout) || "No output";
    }
    case "command_task": {
      if (Array.isArray(r.tasks)) return `${r.tasks.length} tasks · ${array(r.pending_ids).length} pending`;
      return `Task ${scalar(r.id)} · ${scalar(r.status)}${r.output_available === false ? " · output available after settlement" : ` · ${scalar(r.total_chars)} captured chars`}`;
    }
    case "lsp": return `${scalar(r.operation)} · ${scalar(r.path)} · ${array(r.items).length} results`;
    case "git_status": {
      if (typeof r.output !== "string") break;
      const rows = textLines(r.output);
      return rows.length ? `${rows.length} visible status entries · ${rows.slice(0, 2).join(" · ")}` : "No visible changes";
    }
    case "git_diff": {
      if (typeof r.output !== "string") break;
      const rows = r.output.split("\n");
      const files = rows.filter(line => line.startsWith("diff --git ")).length;
      const added = rows.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = rows.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
      return `${files} files · +${added} −${removed}${r.truncated === true ? " (partial preview)" : ""}`;
    }
    case "git_log": return `${textLines(typeof r.output === "string" ? r.output : "").length} commits · ${first(r.output)}`;
    case "browser_navigate": return r.navigated === true ? "Page navigated" : "Navigation result unavailable";
    case "browser_read": return `${typeof r.text === "string" ? r.text.length : 0} text characters · ${first(r.text)}`;
    case "browser_click":
    case "browser_fill": return r.completed === true ? "Browser action completed" : "Browser result unavailable";
    case "browser_close": return r.closed === true ? "Browser closed" : "Close result unavailable";
    case "browser_screenshot": return r.artifact ? `${scalar(r.artifact)} · ${scalar(r.bytes)} bytes · ${scalar(r.width)}×${scalar(r.height)}` : scalar(r.note);
    case "mcp_list_tools": return `${array(r.tools).length} tools · ${scalar(r.server)}`;
    case "project_context": return `${array(r.sources).length} instruction sources · ${paths(array(r.sources))}`;
    case "load_skill": return `${scalar(r.name) || scalar(r.id)} · ${scalar(r.sourceDirectory)}`;
    case "list_models": return `${array(r.ids).length} models / ${scalar(r.total)} total · ${array(r.ids).slice(0, 2).map(scalar).join(", ")}`;
    case "update_plan": {
      const steps = array(r.steps);
      const active = steps.find(step => object(step)?.status === "in_progress");
      return `Plan ${steps.filter(step => object(step)?.status === "completed").length}/${steps.length}${scalar(r.title) ? ` · ${scalar(r.title)}` : ""}${active ? ` · ${scalar(object(active)?.step)}` : ""}`;
    }
    case "spawn_agent": return `Agent ${scalar(r.childSessionId)} · ${scalar(r.model)}`;
    case "list_agents": return agentOverview(Array.isArray(value) ? value : array(r.agents), typeof r.total === "number" ? r.total : undefined);
    case "wait_agents": return agentOverview(array(value));
    case "get_agent_result": {
      if (typeof r.id !== "string" || typeof r.content !== "string" || typeof r.offset !== "number" || typeof r.totalChars !== "number") break;
      const page = r.content.length ? `chars ${r.offset + 1}–${r.offset + r.content.length}` : "0 chars read";
      return `Agent ${scalar(r.id)} · ${scalar(r.status)}${r.handled === true ? " (handled)" : ""} · ${page} / ${r.totalChars} total`;
    }
    case "send_agent_message": {
      if (typeof r.id !== "string") break;
      return `Agent ${scalar(r.id)} · ${r.queued === true ? `message queued · ${scalar(r.pendingMessages)} pending` : "Message result unavailable"}`;
    }
    case "resolve_agent": {
      if (typeof r.id !== "string") break;
      return `Agent ${scalar(r.id)} · ${scalar(r.status)}${r.handled === true ? " · handled" : ""}`;
    }
    case "cancel_agent": return `Agent ${scalar(r.id)} · ${scalar(r.status)}`;
  }
  return undefined;
}

export function toolPresentation(name: string, result: ToolResult): { detail: string; warning: string; failed: boolean; exitCode: number | null } {
  const value = decode(result.content);
  const r = object(value) ?? {};
  const command = name === "run_command" || name === "command_task";
  const exitCode = command && typeof r.exit_code === "number" && Number.isFinite(r.exit_code) ? r.exit_code : null;
  const agent = agentTools.has(name);
  const agents = name === "list_agents" && Array.isArray(r.agents) ? r.agents : Array.isArray(value) ? value : [value];
  const badAgent = agent && agents.some(item => {
    const record = object(item);
    return record?.handled !== true && agentHasFailure(record);
  });
  const failed = result.isError || (exitCode !== null && exitCode !== 0) || badAgent
    || (command && (r.status === "failed" || r.result_is_error === true || r.timed_out === true || r.spawn_failed === true || Boolean(r.signal)));
  const notes: string[] = [];
  if (command && r.timed_out === true) notes.push("timed out");
  if (command && r.spawn_failed === true) notes.push("failed to start");
  if (command && r.signal) notes.push(`signal ${scalar(r.signal)}`);
  if (r.truncated === true || (name === "wait_agents" && agents.some(item => object(item)?.truncated === true))) notes.push("truncated");
  if (r.scan_truncated === true) notes.push("scan incomplete");
  if (r.output_truncated === true) notes.push("captured output incomplete");
  if (r.partial_line === true) notes.push("partial line");
  const next = r.next_offset ?? r.nextOffset;
  if (typeof next === "number") notes.push(`next offset ${next}`);
  if (typeof r.omitted === "number" && r.omitted > 0) notes.push(`${r.omitted} omitted`);
  if (command && r.stderr) notes.push("stderr");
  if (badAgent) notes.push("agent failure · inspect details");
  // Agent messages/results can include task text, instructions and resolution
  // reasons. Even transport errors must not echo them into the default card.
  const error = result.isError ? agent ? "Agent tool failed · inspect details" : scalar(r.message) || scalar(r.error) || scalar(object(r.error)?.message)
    || (value === undefined ? first(result.content) : "") : "";
  const attachmentDetail = name === "publish_file" && !result.isError && result.files?.length
    ? result.files.map(file => `${file.name} · ${file.size} bytes · ${file.id}`).join("; ") + " · forge files save <session-id> <file-id> --output PATH"
    : "";
  const detail = error || attachmentDetail || builtinDetail(name, r, value)
    || (agent ? "Agent result · details available" : value !== undefined ? "Structured result · details available" : first(result.content) || "No output");
  return { detail, warning: notes.join(" · "), failed, exitCode };
}
