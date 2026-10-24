/**
 * One display vocabulary for the whole CLI.
 *
 * The terminal UI stays ASCII-only English on purpose: it must stay readable on
 * terminals that lack CJK fonts. Core's shared display modules are localized for
 * the web UI, so the CLI derives its own labels here instead of reusing them.
 * Tool identifiers remain stable in the protocol, `/tools`, `/export` and JSON.
 */
const verbs: Readonly<Record<string, string>> = {
  read_file: "read",
  write_file: "write",
  append_file: "append",
  edit_file: "edit",
  list_files: "list",
  search_files: "search",
  run_command: "run",
  command_task: "task",
  make_directory: "mkdir",
  git_status: "git status",
  git_diff: "git diff",
  git_log: "git log",
  project_context: "context",
  load_skill: "skill",
  list_models: "models",
  create_plan: "plan",
  update_plan: "plan",
  spawn_agent: "agent",
  list_agents: "agents",
  wait_agents: "wait",
  get_agent_result: "agent result",
  send_agent_message: "agent message",
  resolve_agent: "agent verdict",
  cancel_agent: "cancel agent",
  mcp_list_tools: "mcp tools",
  lsp: "lsp",
  publish_file: "publish",
  web_search: "web search",
  browser_navigate: "browse",
  browser_read: "read page",
  browser_click: "click",
  browser_fill: "fill",
  browser_press: "press",
  browser_scroll: "scroll",
  browser_snapshot: "page snapshot",
  browser_screenshot: "screenshot",
  browser_close: "close browser",
};

/** Short English verb for a tool, falling back to the identifier. */
export const toolVerb = (name: string): string => verbs[name] ?? name;

/** Shared chrome words, so one screen never mixes languages for the same idea. */
export const chrome = Object.freeze({
  thinking: "thinking",
  responding: "responding",
  retrying: "retrying",
  awaitingApproval: "awaiting approval",
  running: "running",
  cancelled: "cancelled",
  interrupted: "interrupted",
  completed: "completed",
  failed: "failed",
  steps: "steps",
  toolCalls: "tool calls",
  retries: "retries",
  cancelHint: "Ctrl+C cancel",
  tokens: "tokens",
  tools: "tools",
});

/** One ordering for `/help` in both the rich and the plain path. */
export const commandGroups = Object.freeze([
  { title: "Config", category: "config" },
  { title: "Workflow & plans", category: "workflow" },
  { title: "Sessions", category: "session" },
  { title: "General", category: "general" },
] as const);
