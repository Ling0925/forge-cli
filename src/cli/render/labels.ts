/**
 * One display vocabulary for the whole CLI.
 *
 * Tool identifiers stay stable in the protocol, `/tools`, `/export` and JSON
 * output. The terminal transcript is Chinese prose, so the card header uses a
 * short Chinese verb and keeps the exact tool name available on demand.
 */
const verbs: Readonly<Record<string, string>> = {
  read_file: "读取",
  write_file: "写入",
  append_file: "追加",
  edit_file: "编辑",
  list_files: "列出",
  search_files: "搜索",
  run_command: "运行",
  command_task: "命令任务",
  make_directory: "建目录",
  git_status: "git 状态",
  git_diff: "git 差异",
  git_log: "git 日志",
  project_context: "项目上下文",
  load_skill: "加载技能",
  list_models: "模型列表",
  create_plan: "制定计划",
  update_plan: "更新计划",
  spawn_agent: "派出子代理",
  list_agents: "子代理列表",
  wait_agents: "等待子代理",
  get_agent_result: "代理结果",
  send_agent_message: "代理消息",
  resolve_agent: "代理结论",
  cancel_agent: "取消代理",
  mcp_list_tools: "MCP 工具",
  lsp: "语言服务",
  publish_file: "发布文件",
  web_search: "网页搜索",
  browser_navigate: "打开网页",
  browser_read: "读取网页",
  browser_click: "点击网页",
  browser_fill: "填写网页",
  browser_press: "按键",
  browser_scroll: "滚动网页",
  browser_snapshot: "网页快照",
  browser_screenshot: "网页截图",
  browser_close: "关闭浏览器",
};

/** Chinese verb for a tool, falling back to the identifier for unknown tools. */
export const toolVerb = (name: string): string => verbs[name] ?? name;

/** Shared chrome words, so one screen never mixes languages for the same idea. */
export const chrome = Object.freeze({
  thinking: "思考中",
  responding: "回复中",
  retrying: "重试中",
  awaitingApproval: "等待审批",
  running: "运行中",
  cancelled: "已取消",
  interrupted: "已中断",
  completed: "完成",
  failed: "失败",
  steps: "步",
  toolCalls: "次工具调用",
  retries: "次请求重试",
  cancelHint: "Ctrl+C 取消",
  tokens: "tokens",
  tools: "工具",
});

/** One ordering for `/help` in both the rich and the plain path. */
export const commandGroups = Object.freeze([
  { title: "配置", category: "config" },
  { title: "工作流与计划", category: "workflow" },
  { title: "会话管理", category: "session" },
  { title: "通用", category: "general" },
] as const);
