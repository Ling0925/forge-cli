# Forge CLI

本仓库是 Forge 的终端客户端独立 Git 仓库，包含交互式 Ink TUI、单机 `run` / `resume`、会话与设置命令，以及连接本地 host 的 `attach` 客户端。

## 仓库边界

- 本仓库负责 `src/cli/`、`tests/cli/`、CLI 构建脚本、Ink patch 和 CLI 文档。
- 共享运行时已拆到独立包 `@forge/core`（本地仓库 `../forge-core`），包括 harness、schemas、host、provider、store、tools 等实现。本仓库只通过包子路径导入，例如 `@forge/core/core/harness`、`@forge/core/shared/schemas`。
- 本仓库不复制 `@forge/core` 源码，也不使用 tsconfig paths 或构建 alias 伪装独立；这些模块必须由真实包依赖提供。
- Electron 桌面端、Web UI、发布/安装流程和 Rust/Tauri 工作不属于本仓库。
- 本轮只拆分仓库与构建依赖，不改变单机和 `attach` 的运行行为；这不代表原库的桌面/Web 功能已经全部解耦。

## 安装

必须先构建同级的 `@forge/core`，再安装本仓库依赖：

```sh
# 1. 构建共享核心（具体命令以其 README 为准）
cd ../forge-core
pnpm install
pnpm build

# 2. 安装 CLI 依赖
cd ../forge-cli
pnpm install
```

`package.json` 中的 `"@forge/core": "file:../forge-core"` 是本地协同开发用的文件依赖，不依赖原 `desktop-harness` 源码布局。以后发布 CLI 时，应把它替换为 `@forge/core` 的发布版本或 tarball。`@forge/core` 重新构建后，重新执行 `pnpm install` 以刷新 pnpm 对文件依赖的快照。

## 构建与运行

```sh
pnpm build                 # node scripts/build-core.mjs
node dist/cli.mjs --help
node dist/cli.mjs chat     # 在当前目录打开交互会话
```

`dist/cli.mjs` 是独立的 production bootstrap，复制自 `src/cli/bootstrap.mjs`，会在加载 React/Ink 前设置 `NODE_ENV=production`，不要把它打进主 bundle。主 bundle 是 `dist/cli-main.mjs`，`@forge/core` 子路径在构建产物中保持为包导入。

常用检查：

```sh
pnpm typecheck
pnpm test
pnpm verify:boundaries     # 检查没有跨仓库相对 src 引用或 tsconfig alias
pnpm check                 # boundary + typecheck + test
```

测试使用临时 `FORGE_HOME`，不需要真实配置或密钥。终端模拟器 QA 测试还需要外部提供的 `@xterm/addon-unicode11`（默认查找 `.build/qa-deps/` 或 `XTERM_ROOT`）；仓库不会自动安装它，缺少时这些测试会明确失败。

## 本机启动器

原库的本机启动器 `~/.local/bin/forge` 仍然指向原 `desktop-harness/dist/cli.mjs`，本轮没有迁移或改写它。运行本仓库构建出的 CLI 不会自动更新该启动器；如将来要切换，需单独确认并修改启动入口。

## Git

本仓库是从原库历史中提取的独立仓库，保留相关路径历史，`origin` 已移除。提交应留在本仓库，不修改父库或其他仓库；本轮为本地提交，不推送。

## 文档状态

`docs/` 保留了原库的 CLI 历史文档。部分链接（如 `ARCHITECTURE.md`、`PROVIDERS.md`）指向仍留在核心/桌面仓库的内容，本仓库并不包含全部实现；参见 [docs/README.md](docs/README.md)。
