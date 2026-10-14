import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  formatCommandUsage,
  formatHelp,
  matchSlashCommands,
} from "../../src/cli/commands";
import { SlashMenu } from "../../src/cli/slash-menu";
import { createTheme } from "../../src/cli/theme";

describe("SlashCommands metadata", () => {
  it.each(["/quit", "/exit"])("offers %s in the menu and help", (name) => {
    const menu = new SlashMenu(5);
    expect(menu.update(name.slice(0, -1))).toBe(true);
    expect(menu.getSelected()?.name).toBe(name);
    expect(formatCommandUsage()).toContain(name);
    expect(formatHelp(createTheme({ forceColor: false }))).toContain(name);
  });
  it("includes all interactive slash commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("/model");
    expect(names).toContain("/reasoning");
    expect(matchSlashCommands("/rea")).toEqual([
      expect.objectContaining({ name: "/reasoning" }),
    ]);
    expect(names).toContain("/permission");
    expect(names).toContain("/mode");
    expect(names).toContain("/plan");
    expect(names).toContain("/sessions");
    expect(names).toContain("/resume");
    expect(names).toContain("/new");
    expect(names).toContain("/fork");
    expect(names).toContain("/rename");
    expect(names).toContain("/archive");
    expect(names).toContain("/compact");
    expect(names).toContain("/diagnostics");
    expect(names).toContain("/context");
    expect(names).toContain("/skills");
    expect(names).toContain("/checkpoints");
    expect(names).toContain("/mcp");
    expect(names).toContain("/export");
    expect(names).toContain("/help");
    expect(names).toContain("/quit");
  });

  it("matches slash commands by prefix", () => {
    expect(matchSlashCommands("/mod")).toEqual([
      expect.objectContaining({ name: "/model" }),
      expect.objectContaining({ name: "/mode" }),
    ]);
    expect(matchSlashCommands("/q")).toEqual([
      expect.objectContaining({ name: "/queue" }),
      expect.objectContaining({ name: "/quit" }),
    ]);
    expect(matchSlashCommands("not-slash")).toEqual([]);
  });

  it("formats help without heavy boxes", () => {
    const theme = createTheme({ forceColor: false });
    const helpText = formatHelp(theme);
    expect(helpText).toContain("Forge 命令");
    expect(helpText).toContain("/model");
    expect(helpText).toContain("/help");
    expect(helpText).not.toContain("╭──");
    expect(helpText).not.toContain("╰──");
  });

  it("formats single-line command usage", () => {
    const usage = formatCommandUsage();
    expect(usage).toContain("/help");
    expect(usage).toContain("/model [id]");
    expect(usage).toContain("/resume [uuid]");
    expect(usage).not.toContain("/resume <uuid>");
  });

  it("describes optional model and resume pickers", () => {
    const model = SLASH_COMMANDS.find((command) => command.name === "/model");
    const resume = SLASH_COMMANDS.find((command) => command.name === "/resume");
    expect(model).toMatchObject({
      args: "[id]",
      description: "无参数选择模型，也可手动指定 ID",
    });
    expect(resume).toMatchObject({
      args: "[uuid]",
      description: "选择会话恢复，也可指定完整 ID",
    });
    expect(formatHelp(createTheme({ forceColor: false }))).toContain(
      "选择会话恢复",
    );
  });
});

describe("SlashMenu state and navigation", () => {
  it("activates on slash and filters on typing", () => {
    const menu = new SlashMenu(5);
    expect(menu.isActive).toBe(false);

    expect(menu.update("/")).toBe(true);
    expect(menu.isActive).toBe(true);
    expect(menu.state.items.length).toBeGreaterThan(5);

    expect(menu.update("/mod")).toBe(true);
    expect(menu.state.items.map((i) => i.name)).toEqual(["/model", "/mode"]);

    // Argument typed after space deactivates menu
    expect(menu.update("/model gpt-4")).toBe(false);
    expect(menu.isActive).toBe(false);
  });

  it("navigates selection with wrap-around", () => {
    const menu = new SlashMenu(5);
    menu.update("/mod");
    expect(menu.state.selectedIndex).toBe(0);
    expect(menu.getSelected()?.name).toBe("/model");

    menu.moveDown();
    expect(menu.state.selectedIndex).toBe(1);
    expect(menu.getSelected()?.name).toBe("/mode");

    menu.moveDown();
    expect(menu.state.selectedIndex).toBe(0);

    menu.moveUp();
    expect(menu.state.selectedIndex).toBe(1);
  });

  it("renders popup with marker and inverse video on selection", () => {
    const theme = createTheme({ forceColor: true });
    const menu = new SlashMenu(5);
    menu.update("/mod");
    const lines = menu.render(theme);
    expect(lines.length).toBe(2);
    // Selected item has leading marker ❯ and inverse code \u001b[7m
    expect(lines[0]).toContain("❯");
    expect(lines[0]).toContain("\u001b[7m");
    // Second item is not selected
    expect(lines[1]).not.toContain("\u001b[7m");
  });

  it("handles empty or non-matching queries gracefully", () => {
    const menu = new SlashMenu(5);
    expect(menu.update("/nonexistentcommand")).toBe(false);
    expect(menu.isActive).toBe(false);
    expect(menu.render()).toEqual([]);
  });
});
