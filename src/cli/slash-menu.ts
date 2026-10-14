import { type SlashCommand, matchSlashCommands } from "./commands";
import {
  type Theme,
  defaultTheme,
  getTerminalWidth,
  padRight,
  truncate,
} from "./theme";

export interface SlashMenuState {
  readonly query: string;
  readonly items: readonly SlashCommand[];
  readonly selectedIndex: number;
  readonly active: boolean;
}

export class SlashMenu {
  private query = "";
  private items: SlashCommand[] = [];
  private selectedIndex = 0;
  private active = false;
  private readonly maxVisible: number;

  constructor(maxVisible = 6) {
    this.maxVisible = Math.max(1, maxVisible);
  }

  get state(): SlashMenuState {
    return {
      query: this.query,
      items: this.items,
      selectedIndex: this.selectedIndex,
      active: this.active,
    };
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Update the slash menu state based on current input draft.
   * Activates when draft starts with '/' and before spaces/arguments,
   * or stays active as long as the command prefix is being typed.
   */
  update(draft: string): boolean {
    // Only a bare command at the start of a single-line draft is completable.
    // Never discard arguments, pasted lines or leading whitespace on selection.
    if (!draft.startsWith("/") || /\s/.test(draft)) {
      this.close();
      return false;
    }

    if (draft === this.query) return this.active;
    this.query = draft;
    this.items = matchSlashCommands(this.query);
    // New input starts from an exact match, otherwise the first suggestion.
    this.selectedIndex = Math.max(0, this.items.findIndex((item) => item.name === draft.toLowerCase()));
    if (this.items.length === 0) {
      this.active = false;
      this.selectedIndex = 0;
      return false;
    }

    this.active = true;
    if (this.selectedIndex >= this.items.length) {
      this.selectedIndex = 0;
    }
    return true;
  }

  moveUp(): void {
    if (!this.active || this.items.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex - 1 + this.items.length) % this.items.length;
  }

  moveDown(): void {
    if (!this.active || this.items.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
  }

  close(): void {
    this.active = false;
    this.items = [];
    this.selectedIndex = 0;
    this.query = "";
  }

  getSelected(): SlashCommand | undefined {
    if (!this.active || this.items.length === 0) return undefined;
    return this.items[this.selectedIndex];
  }

  render(theme: Theme = defaultTheme, maxDisplay = this.maxVisible): string[] {
    if (!this.active || this.items.length === 0) return [];

    const total = this.items.length;
    const windowSize = Math.min(total, maxDisplay);

    let start = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(windowSize / 2),
        total - windowSize,
      ),
    );
    if (start < 0) start = 0;
    const visibleItems = this.items.slice(start, start + windowSize);

    const termWidth = getTerminalWidth();
    const cmdColWidth = 16;
    const descColWidth = Math.max(20, termWidth - cmdColWidth - 8);

    const lines: string[] = [];
    for (let i = 0; i < visibleItems.length; i++) {
      const item = visibleItems[i];
      if (!item) continue;
      const actualIndex = start + i;
      const isSelected = actualIndex === this.selectedIndex;

      const cmdText = padRight(item.name, cmdColWidth);
      const descText = truncate(item.description, descColWidth);

      if (isSelected) {
        const row = `❯ ${cmdText} ${descText}`;
        lines.push(theme.inverse(` ${truncate(row, termWidth - 4)} `));
      } else {
        const row = `  ${theme.cyan(cmdText)} ${theme.dim(descText)}`;
        lines.push(` ${row}`);
      }
    }

    if (total > windowSize) {
      lines.push(
        theme.dim(`   (${total - windowSize} more commands, ↑/↓ to navigate)`),
      );
    }

    return lines;
  }
}
