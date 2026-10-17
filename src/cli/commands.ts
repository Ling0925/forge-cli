import { type Theme, defaultTheme, getTerminalWidth, truncate } from "./theme";
import { SLASH_COMMANDS, type SlashCommand } from "../shared/slash-commands";
export { SLASH_COMMANDS, matchSlashCommands, type SlashCommand } from "../shared/slash-commands";

export const formatCommandUsage = (): string =>
  `${SLASH_COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name)).join(" ")}\nEnd a line with \\ for multiline input. Ctrl+C stops a run; at the prompt the first interrupt clears the current input and returns a fresh prompt, and a second interrupt (without a new line) exits.\n`;

export const formatHelp = (theme: Theme = defaultTheme): string => {
  const categories: Array<{ title: string; cat: SlashCommand["category"] }> = [
    { title: "配置", cat: "config" },
    { title: "工作流与计划", cat: "workflow" },
    { title: "会话管理", cat: "session" },
    { title: "通用", cat: "general" },
  ];
  const lines: string[] = [theme.bold("Forge 命令"), ""];
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
