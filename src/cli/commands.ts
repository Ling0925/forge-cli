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

/**
 * Core's slash descriptions are the wording shared with the web UI, which is
 * localized. The terminal stays English so it reads on terminals without CJK
 * fonts, so the CLI supplies its own descriptions keyed by command name.
 * Unknown commands fall back to Core's text rather than losing a description.
 */
const commandDescriptions: Readonly<Record<string, string>> = {
  "/history": "Turn prompt history on, off, clear it, or show status",
  "/steer": "Steer the active run at the next safe boundary",
  "/approval": "This CLI session's approval policy (not a sandbox)",
  "/queue": "Inspect or clear pending input; resume after a failure",
  "/tools": "Show tool summaries, or one call's arguments and result",
  "/tasks": "Subagent and background-command panel for this session",
  "/model": "Choose a model, or pass an exact ID",
  "/reasoning": "Choose the reasoning effort (saved globally)",
  "/thinking": "Toggle streaming the full reasoning text",
  "/permission": "Show or change the tool permission level",
  "/mode": "Switch between plan and build",
  "/plan": "Show this session's plans and their progress",
  "/review": "Read-only review of this session's changes",
  "/sessions": "Saved sessions",
  "/resume": "Resume a session, by picker or exact ID",
  "/new": "Create a new session",
  "/fork": "Fork this session",
  "/rename": "Rename this session",
  "/archive": "Archive this session",
  "/compact": "Compact the session context",
  "/diagnostics": "Session statistics",
  "/context": "Show the project context",
  "/skills": "List available skills",
  "/checkpoints": "List or restore checkpoints",
  "/mcp": "Manage MCP servers",
  "/export": "Export the session as JSON",
  "/help": "Full command help",
  "/quit": "Exit Forge",
  "/exit": "Exit Forge (alias of /quit)",
};

/** Display copy for one command, kept in one place for both help paths. */
export const commandDescription = (command: SlashCommand): string =>
  commandDescriptions[command.name] ?? command.description;

export const formatCommandUsage = (): string =>
  `${SLASH_COMMANDS.map((c) => (c.args ? `${c.name} ${c.args}` : c.name)).join(" ")}\nEnd a line with \\ for multiline input. Ctrl+C stops a run; at the prompt the first interrupt clears the current input and returns a fresh prompt, and a second interrupt (without a new line) exits.\n`;

export const formatHelp = (theme: Theme = defaultTheme): string => {
  // The rich path renders this same grouped list; keep one structure so the two
  // terminals never disagree about order, wording or alignment.
  const lines: string[] = [theme.bold("Forge commands"), ""];
  for (const { title, category } of commandGroups) {
    const group = SLASH_COMMANDS.filter((c) => c.category === category);
    if (group.length === 0) continue;
    lines.push(theme.dim(`  ${title}`));
    for (const cmd of group) {
      const width = getTerminalWidth();
      lines.push(`  ${theme.cyan(truncate(commandUsage(cmd), width - 2))}`);
      lines.push(
        `    ${theme.dim(truncate(commandDescription(cmd), width - 4))}`,
      );
    }
    lines.push("");
  }
  lines.push(
    theme.dim(
      "  End a line with \\ for multiline · Ctrl+C cancels · /quit exits",
    ),
  );
  return lines.join("\n");
};
