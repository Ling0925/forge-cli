# 文档状态

本目录的文档随 CLI 从原 `desktop-harness` 仓库提取，保留作 CLI 历史与行为记录，不代表当前仓库包含全部所述实现。

- 与终端命令、Ink TUI、`run`/`resume`、`attach` 客户端相关的段落仍适用于本仓库。
- 文中指向 `ARCHITECTURE.md`、`PROVIDERS.md`、`ROOT_RUN_BUDGET.md`、`INPUT_QUEUE.md` 等文件的链接，可能属于 `@forge/core` 或原桌面/Web 仓库；本仓库不保证这些文件存在。
- 当前拆分只覆盖仓库和构建依赖：共享运行时由 `@forge/core` 提供，桌面端、Web UI、发布/安装和 Rust/Tauri 工作仍在其他仓库。
- 新的开发和验证约定以仓库根目录的 [README.md](../README.md) 和 [AGENTS.md](../AGENTS.md) 为准。
- 不要根据这些历史文档认为核心、桌面或全部功能已经在本仓库内完全解耦。
