# Forge CLI

在终端里使用 Forge：与模型交互、执行工作区任务、恢复会话，或把结果作为 JSONL 交给脚本处理。

CLI 使用 Ink 构建终端界面，任务执行、模型接入和存储来自 `@forge/core`。交互式会话与单次命令可独立运行；需要观察或控制已有 Core 任务时，使用显式的 `attach` 入口。

[Forge 主仓](https://github.com/Ling0925/forge) · [Core](https://github.com/Ling0925/forge-core) · [Web](https://github.com/Ling0925/forge-web-ui) · [Android](https://github.com/Ling0925/forge-android)

## 从源码开始

需要 **Node.js `>=22.23.1 <23`** 和 **pnpm `11.18.0`**。Core 与 CLI 必须放在同一级，因为本仓使用 `file:../forge-core` 依赖。

```sh
git clone https://github.com/Ling0925/forge-core.git
git clone https://github.com/Ling0925/forge-cli.git

cd forge-core
pnpm install --frozen-lockfile
pnpm build

cd ../forge-cli
pnpm install
pnpm build
node dist/cli.mjs --help
```

下面的命令均在 `forge-cli` 根目录执行。`node dist/cli.mjs` 是可直接使用的入口；如果已配置 `forge` 启动器，可用 `forge` 替代，不必安装或发布 npm 包。

### 配置第一个模型

将示例地址、模型 ID 和私密文件路径替换成自己的值：

```sh
node dist/cli.mjs config set \
  --base-url https://your-provider.example/v1 \
  --api-mode chat-completions \
  --model YOUR_MODEL_ID

node dist/cli.mjs config set --api-key-stdin < /path/to/private/api-key.txt
node dist/cli.mjs models --refresh
```

凭据通过标准输入传入，不放进命令参数或 shell 历史。密钥文件应在仓库之外并限制读取权限；多来源、OAuth 与路由管理见 `node dist/cli.mjs --help` 中的 `providers`、`routes` 命令。

`models --refresh` 会访问来源并更新模型目录；实际对话会调用所选模型，可能产生费用。

## 日常使用

### 打开或恢复交互会话

```sh
# 在指定项目中开始，逐次确认工具请求
node dist/cli.mjs chat --workspace /absolute/path/to/project --approval manual

# 列出持久化会话，再用真实 ID 恢复
node dist/cli.mjs sessions
node dist/cli.mjs resume SESSION_UUID
```

交互终端中不带参数启动，会在当前目录打开会话。`resume` 显示已有历史并等待输入，不自动重做上一次任务，也不接受额外提示词；脚本续跑使用 `run --session`。

常用交互操作：

- `/` 打开命令菜单；`/model`、`/reasoning` 选择模型与思考强度，`/resume` 切换会话。
- 运行中按 Enter 将后续要求排队；`/steer 内容` 或 Alt+Enter 在安全边界向当前运行插话。
- `/queue` 查看队列，`/queue run` 恢复暂停队列，`/queue clear` 清空。
- Ctrl+C 取消当前运行；空闲时先清除草稿，空草稿时退出。
- PgUp 或滚轮向上进入历史阅读，End / Esc 回到实时界面。

### 执行一次任务

```sh
node dist/cli.mjs run --workspace /absolute/path/to/project \
  --mode plan --permission readonly '分析项目结构并提出修改建议'

node dist/cli.mjs run --session SESSION_UUID '继续分析刚才的问题'
```

### 接入脚本

```sh
printf '%s\n' '概括项目的主要模块' | node dist/cli.mjs run \
  --workspace /absolute/path/to/project \
  --permission readonly --prompt-stdin --json
```

提示词只能选择一种来源：命令行文本、`--prompt-file PATH` 或 `--prompt-stdin`。不会隐式读取 stdin。`--json` 输出 version 1 的 **JSONL 事件及最终结果 envelope**，不是一个完整 JSON 对象；`chat` / `resume` 不支持该模式。

## 权限与状态

默认工具权限为 `workspace`。交互默认审批策略是 `full-access`，会自动批准现有权限允许的请求；首次使用或需要逐次确认时，像上面的示例一样传入 `--approval manual`，会话内也可使用 `/approval manual`。

审批策略不会提升 `readonly` / `workspace` / `unrestricted` 权限，也不会解除 plan 模式限制。工具命令不是操作系统沙箱，可能访问外部文件或网络。`run --yes` 只在显式选择 `--permission unrestricted` 时自动批准。

配置与会话默认存放在 `~/.local/share/forge`；`FORGE_HOME` 可选择另一份独立状态。不要把真实模型密钥或会话用于测试。模型目录缓存与聊天历史不同：需要联网刷新时明确使用 `models --refresh`。

## 连接已有 Core：attach

`chat`、`run` 和 `resume` 创建进程内运行时，不会自动连接正在运行的 Web/Core。要共享活动任务，需要 Linux 本地 Unix socket：

```sh
# 终端 A：启动无界面的 host，目录须由当前用户拥有且仅本人可访问
node dist/cli.mjs host --socket /private/directory/core.sock
```

```sh
# 终端 B：连接已有 host
node dist/cli.mjs attach --socket /private/directory/core.sock status
node dist/cli.mjs attach --socket /private/directory/core.sock sessions
node dist/cli.mjs attach --socket /private/directory/core.sock watch
```

已有 HTTP Core 也可在启动时增加 `--socket`，让 Web 与 attach 连接同一个运行时，而不是再开一个 host。socket 路径需为绝对路径且短于 101 个 UTF-8 字节；客户端不会自动删除占用路径或创建替代运行时。

attach 输出 JSON/JSONL，不是交互 TUI。`watch` 断开或 Ctrl+C 只停止观察；`cancel RUN_ID` 才取消任务。超时与断连不自动重放请求，先查询 host / 会话状态。更多命令见 `node dist/cli.mjs attach --help` 和 [本地连接协议](docs/CLI_ATTACH.md)。

## 开发与检查

```sh
pnpm build
pnpm verify:boundaries
pnpm test:package
pnpm exec vitest run tests/cli/cli.test.ts \
  tests/cli/provider-management.test.ts tests/cli/session-cache-integration.test.ts
```

- `pnpm build` 生成 `dist/cli-main.mjs`，并复制独立的 `dist/cli.mjs` bootstrap。bootstrap 必须先设置 production 环境再加载 React/Ink，不要直接用主 bundle 作为入口。
- Core 更新后先在 Core 仓构建，再在本仓执行 `pnpm install --no-frozen-lockfile` 刷新文件包，最后构建 CLI。
- 包烟测使用临时 `HOME` / `FORGE_HOME`，检查实际 CLI/Core 包加载，不调用真实模型。
- `pnpm check` 执行边界检查、typecheck 和全量测试。部分终端 QA 需要外部 `@xterm/addon-unicode11`，默认从 `.build/qa-deps` 或 `XTERM_ROOT` 查找。
- 仅改文档无需构建。使用 Forge 主仓开发时，按主仓说明执行 `node scripts/build-core.mjs`；已有进程不会热更新，重新启动 CLI 才会加载新产物。

```text
src/cli/        命令、交互状态与终端界面
tests/cli/      命令和终端回归测试
scripts/        构建与跨仓依赖检查
patches/        Ink 6.6.0 patch
docs/           交互、attach 与终端兼容说明
```

## 终端兼容与文档

富终端使用全屏 Ink 界面；非 TTY、`TERM=dumb` 使用 plain 输出。复制可用 Shift+拖选与终端复制；需要关闭鼠标报告时设置 `FORGE_MOUSE=0`。缺少符号字形时设置 `FORGE_SYMBOLS=ascii`，屏幕阅读器模式使用 `INK_SCREEN_READER=true`。

- [CLI 交互与工具说明](docs/CLI.md)
- [终端选择、复制与阅读](docs/TERMINAL_SELECTION.md)
- [文档导航与历史说明](docs/README.md)
- [作者说明](docs/AUTHORSHIP.md)

本仓在 Forge 主仓中位于 `repos/forge-cli` 子模块。CLI 与 Core 独立提交，主仓记录各自版本；本仓只通过 `@forge/core/...` 公共路径依赖核心，不维护核心源码副本。
