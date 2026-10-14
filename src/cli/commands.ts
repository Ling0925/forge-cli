import { type Theme, defaultTheme, getTerminalWidth, truncate } from "./theme";

export interface SlashCommand {
  readonly name: string;
  readonly args?: string;
  readonly description: string;
  readonly category: "workflow" | "session" | "config" | "general";
  readonly onboarding?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/steer", args: "<message>", description: "向当前运行插话，在模型/工具交换结束后生效", category: "workflow" },
  { name: "/approval", args: "[full-access|auto|manual]", description: "本 CLI 会话审批：默认全放行 / 命令自动 / 逐次确认（非沙箱）", category: "config" },
  { name: "/queue", args: "[clear|run]", description: "查看/清空待发消息，失败后显式继续", category: "workflow" },
  { name: "/tools", args: "[N]", description: "查看工具摘要或第 N 次调用的参数与结果", category: "workflow" },
  {
    name: "/model",
    args: "[id]",
    description: "无参数选择模型，也可手动指定 ID",
    category: "config",
    onboarding: true,
  },
  {
    name: "/reasoning",
    args: "[default|none|minimal|low|medium|high|xhigh]",
    description: "选择或设置思考强度（保存为全局配置）",
    category: "config",
    onboarding: true,
  },
  {
    name: "/permission",
    args: "[readonly|workspace|unrestricted]",
    description: "查看或更改权限",
    category: "config",
    onboarding: true,
  },
  {
    name: "/mode",
    args: "[plan|build]",
    description: "切换计划或执行模式",
    category: "workflow",
    onboarding: true,
  },
  {
    name: "/plan",
    description: "查看执行计划",
    category: "workflow",
  },
  {
    name: "/sessions",
    description: "历史会话",
    category: "session",
    onboarding: true,
  },
  {
    name: "/resume",
    args: "[uuid]",
    description: "选择会话恢复，也可指定完整 ID",
    category: "session",
  },
  {
    name: "/new",
    description: "创建新会话",
    category: "session",
  },
  {
    name: "/fork",
    args: "[boundary]",
    description: "分支会话",
    category: "session",
  },
  {
    name: "/rename",
    args: "<title>",
    description: "重命名会话",
    category: "session",
  },
  {
    name: "/archive",
    description: "归档会话",
    category: "session",
  },
  {
    name: "/compact",
    description: "压缩会话上下文",
    category: "session",
  },
  {
    name: "/diagnostics",
    description: "查看会话统计",
    category: "session",
  },
  {
    name: "/context",
    description: "查看项目上下文",
    category: "workflow",
  },
  {
    name: "/skills",
    description: "列出技能",
    category: "workflow",
  },
  {
    name: "/checkpoints",
    args: "[list|diff ID|restore ID]",
    description: "查看或恢复检查点",
    category: "workflow",
  },
  {
    name: "/mcp",
    args: "[list|register|enable|disable|remove|health]",
    description: "管理 MCP 服务",
    category: "config",
  },
  {
    name: "/export",
    description: "导出会话 JSON",
    category: "session",
  },
  {
    name: "/help",
    description: "完整命令帮助",
    category: "general",
    onboarding: true,
  },
  {
    name: "/quit",
    description: "退出 Forge（同 /exit）",
    category: "general",
    onboarding: true,
  },
  {
    name: "/exit",
    description: "退出 Forge（/quit 的别名）",
    category: "general",
  },
];

export const matchSlashCommands = (query: string): SlashCommand[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }
  const cmdPrefix = normalized.split(/\s+/)[0] ?? "/";
  return SLASH_COMMANDS.filter((cmd) =>
    cmd.name.toLowerCase().startsWith(cmdPrefix),
  );
};

export const formatCommandUsage = (): string =>
  `${SLASH_COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name)).join(" ")}\nEnd a line with \\ for multiline input. Ctrl+C stops a run; at the prompt the first interrupt clears the current input and returns a fresh prompt, and a second interrupt (without a new line) exits.\n`;

export const formatHelp = (theme: Theme = defaultTheme): string => {
  const categories: Array<{
    title: string;
    cat: SlashCommand["category"];
  }> = [
    { title: "配置", cat: "config" },
    { title: "工作流与计划", cat: "workflow" },
    { title: "会话管理", cat: "session" },
    { title: "通用", cat: "general" },
  ];

  const lines: string[] = [];
  lines.push(theme.bold("Forge 命令"));
  lines.push("");

  for (const { title, cat } of categories) {
    const group = SLASH_COMMANDS.filter((c) => c.category === cat);
    if (group.length === 0) continue;
    lines.push(theme.dim(`  ${title}:`));
    for (const cmd of group) {
      const fullCmd = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name;
      const width = getTerminalWidth();
      lines.push(`  ${theme.cyan(truncate(fullCmd, width - 2))}`);
      lines.push(`    ${theme.dim(truncate(cmd.description, width - 4))}`);
    }
    lines.push("");
  }

  lines.push(theme.dim("  行尾 \\ 换行 · Ctrl+C 取消 · /quit 退出"));
  return lines.join("\n");
};
