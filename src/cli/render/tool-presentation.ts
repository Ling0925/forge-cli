import { toolResultSchema, type ToolResult } from "@forge/core/shared/schemas";
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
  return `${items.length} 个子代理${total === undefined ? "" : ` / 共 ${total} 个`}${states.size ? ` · ${[...states].slice(0, 5).map(([s, n]) => `${n} ${s}`).join(" · ")}` : ""}`;
}

/** Explicit adapters for Forge tools. Unrecognized/external payloads are kept
 * for /tools N, not dumped into the transcript as JSON. */
function builtinDetail(name: string, r: Record<string, unknown>, value: unknown): string | undefined {
  switch (name) {
    case "read_file": {
      if (r.unchanged === true) return "版本未变化 · 正文已省略（需要重读请省略 if_version）";
      if (typeof r.content !== "string" || typeof r.offset !== "number" || typeof r.total_lines !== "number") break;
      const count = r.content ? r.content.split("\n").length : 0;
      return `${count ? `第 ${r.offset + 1}–${r.offset + count} 行` : "读取 0 行"} / 共 ${r.total_lines} 行${r.cache_hit === true ? " · 缓存命中" : ""}`;
    }
    case "list_files": return `${array(r.entries).length} 项 · ${paths(array(r.entries))}`;
    case "search_files": {
      const matches = array(r.matches);
      if (r.mode === "files") return `${matches.length} 个匹配文件 · ${paths(matches)}`;
      if (r.mode === "count") return `${matches.length} 个文件有匹配 · 本页共 ${matches.reduce<number>((sum, item) => sum + (typeof object(item)?.count === "number" ? Number(object(item)?.count) : 0), 0)} 行命中`;
      return `${matches.length} 处匹配 · ${matches.slice(0, 2).map(item => { const m = object(item); return `${scalar(m?.path)}:${scalar(m?.line)}`; }).join(", ")}`;
    }
    case "append_file":
    case "write_file": return r.unchanged === true ? "无变更 · 内容已一致" : r.written === true ? "文件已写入" : "写入结果不可用";
    case "edit_file": return r.unchanged === true ? "无变更 · 替换内容已一致" : r.edited === true ? `文件已编辑 · ${scalar(r.replacements)} 处替换` : "编辑结果不可用";
    case "make_directory": return r.created === true ? "目录已就绪" : "目录结果不可用";
    case "run_command": {
      if (r.background === true) return `任务 ${scalar(r.id)} · ${scalar(r.status)} · 用 command_task 查看`;
      // Duration is shown once in the card header for every tool.
      return first(r.stderr) || first(r.stdout) || "无输出";
    }
    case "command_task": {
      if (Array.isArray(r.tasks)) return `${r.tasks.length} 个任务 · ${array(r.pending_ids).length} 个待完成`;
      return `任务 ${scalar(r.id)} · ${scalar(r.status)}${r.output_available === false ? " · 结束后才可读取输出" : ` · 已捕获 ${scalar(r.total_chars)} 字符`}`;
    }
    case "lsp": return `${scalar(r.operation)} · ${scalar(r.path)} · ${array(r.items).length} 条结果`;
    case "git_status": {
      if (typeof r.output !== "string") break;
      const rows = textLines(r.output);
      return rows.length ? `${rows.length} 条状态 · ${rows.slice(0, 2).join(" · ")}` : "没有可见变更";
    }
    case "git_diff": {
      if (typeof r.output !== "string") break;
      const rows = r.output.split("\n");
      const files = rows.filter(line => line.startsWith("diff --git ")).length;
      const added = rows.filter(line => line.startsWith("+") && !line.startsWith("+++")).length;
      const removed = rows.filter(line => line.startsWith("-") && !line.startsWith("---")).length;
      return `${files} 个文件 · +${added} −${removed}${r.truncated === true ? "（部分预览）" : ""}`;
    }
    case "git_log": return `${textLines(typeof r.output === "string" ? r.output : "").length} 个提交 · ${first(r.output)}`;
    case "browser_navigate": return r.navigated === true ? "已打开页面" : "导航结果不可用";
    case "browser_read": return `${typeof r.text === "string" ? r.text.length : 0} 个文本字符 · ${first(r.text)}`;
    case "browser_click":
    case "browser_fill": return r.completed === true ? "浏览器操作已完成" : "浏览器结果不可用";
    case "browser_close": return r.closed === true ? "浏览器已关闭" : "关闭结果不可用";
    case "browser_screenshot": return r.artifact ? `${scalar(r.artifact)} · ${scalar(r.bytes)} 字节 · ${scalar(r.width)}×${scalar(r.height)}` : scalar(r.note);
    case "mcp_list_tools": return `${array(r.tools).length} 个工具 · ${scalar(r.server)}`;
    case "project_context": return `${array(r.sources).length} 个指令来源 · ${paths(array(r.sources))}`;
    case "load_skill": return `${scalar(r.name) || scalar(r.id)} · ${scalar(r.sourceDirectory)}`;
    case "list_models": return `${array(r.ids).length} 个模型 / 共 ${scalar(r.total)} 个 · ${array(r.ids).slice(0, 2).map(scalar).join(", ")}`;
    case "create_plan":
    case "update_plan": {
      const steps = array(r.steps);
      const active = steps.find(step => object(step)?.status === "in_progress");
      return `计划 ${steps.filter(step => object(step)?.status === "completed").length}/${steps.length}${scalar(r.title) ? ` · ${scalar(r.title)}` : ""}${active ? ` · ${scalar(object(active)?.step)}` : ""}`;
    }
    case "spawn_agent": return `子代理 ${scalar(r.childSessionId)} · ${scalar(r.model)}`;
    case "list_agents": return agentOverview(Array.isArray(value) ? value : array(r.agents), typeof r.total === "number" ? r.total : undefined);
    case "wait_agents": return agentOverview(array(value));
    case "get_agent_result": {
      if (typeof r.id !== "string" || typeof r.content !== "string" || typeof r.offset !== "number" || typeof r.totalChars !== "number") break;
      const page = r.content.length ? `第 ${r.offset + 1}–${r.offset + r.content.length} 字符` : "读取 0 字符";
      return `子代理 ${scalar(r.id)} · ${scalar(r.status)}${r.handled === true ? "（已处理）" : ""} · ${page} / 共 ${r.totalChars} 字符`;
    }
    case "send_agent_message": {
      if (typeof r.id !== "string") break;
      return `子代理 ${scalar(r.id)} · ${r.queued === true ? `消息已排队 · ${scalar(r.pendingMessages)} 条待投递` : "消息结果不可用"}`;
    }
    case "resolve_agent": {
      if (typeof r.id !== "string") break;
      return `子代理 ${scalar(r.id)} · ${scalar(r.status)}${r.handled === true ? " · 已处理" : ""}`;
    }
    case "cancel_agent": return `子代理 ${scalar(r.id)} · ${scalar(r.status)}`;
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
  if (command && r.timed_out === true) notes.push("超时");
  if (command && r.spawn_failed === true) notes.push("启动失败");
  if (command && r.signal) notes.push(`信号 ${scalar(r.signal)}`);
  if (r.truncated === true || (name === "wait_agents" && agents.some(item => object(item)?.truncated === true))) notes.push("已截断");
  if (r.scan_truncated === true) notes.push("扫描不完整");
  if (r.output_truncated === true) notes.push("捕获输出不完整");
  if (r.partial_line === true) notes.push("末行不完整");
  const next = r.next_offset ?? r.nextOffset;
  if (typeof next === "number") notes.push(`下一页偏移 ${next}`);
  if (typeof r.omitted === "number" && r.omitted > 0) notes.push(`省略 ${r.omitted} 条`);
  if (command && r.stderr) notes.push("stderr");
  if (badAgent) notes.push("子代理失败 · 查看详情");
  // Agent messages/results can include task text, instructions and resolution
  // reasons. Even transport errors must not echo them into the default card.
  const error = result.isError ? agent ? "子代理工具失败 · 查看详情" : scalar(r.message) || scalar(r.error) || scalar(object(r.error)?.message)
    || (value === undefined ? first(result.content) : "") : "";
  // Host-owned publication tools: publish_file and the browser screenshot.
  const publishable = name === "publish_file" || name === "browser_screenshot";
  const attachmentDetail = publishable && !result.isError && result.files?.length
    ? result.files.map(file => `${file.name} · ${file.size} 字节 · ${file.id}`).join("; ") + " · 保存：forge files save <session-id> <file-id> --output PATH"
    : "";
  const detail = error || attachmentDetail || builtinDetail(name, r, value)
    || (agent ? "子代理结果 · 详情可用" : value !== undefined ? "结构化结果 · 详情可用" : first(result.content) || "无输出");
  return { detail, warning: notes.join(" · "), failed, exitCode };
}
