import {
  SLASH_COMMANDS,
  type SlashCommand,
} from "@forge/core/shared/slash-commands";
import { commandGroups } from "./render/labels";
import { type Theme, defaultTheme, getTerminalWidth, truncate } from "./theme";
export {
  SLASH_COMMANDS,
  matchSlashCommands,
  type SlashCommand,
} from "@forge/core/shared/slash-commands";

const commandUsage = (command: SlashCommand): string =>
  command.args ? `${command.name} ${command.args}` : command.name;

export const formatCommandUsage = (): string =>
  `${SLASH_COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name)).join(" ")}\nEnd a line with \\ for multiline input. Ctrl+C stops a run; at the prompt the first interrupt clears the current input and returns a fresh prompt, and a second interrupt (without a new line) exits.\n`;

export const formatHelp = (theme: Theme = defaultTheme): string => {
  // The rich path renders this same grouped list; keep one structure so the two
  // terminals never disagree about order, wording or alignment.
  const lines: string[] = [theme.bold("Forge 命令"), ""];
  for (const { title, category } of commandGroups) {
    const group = SLASH_COMMANDS.filter((c) => c.category === category);
    if (group.length === 0) continue;
    lines.push(theme.dim(`  ${title}`));
    for (const cmd of group) {
      const width = getTerminalWidth();
      lines.push(`  ${theme.cyan(truncate(commandUsage(cmd), width - 2))}`);
      lines.push(`    ${theme.dim(truncate(cmd.description, width - 4))}`);
    }
    lines.push("");
  }
  lines.push(theme.dim("  行尾 \\ 换行 · Ctrl+C 取消 · /quit 退出"));
  return lines.join("\n");
};
