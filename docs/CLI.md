# Forge CLI

## 使用方式

在终端执行 `forge` 开始当前目录的交互会话；`forge chat --workspace PATH [--session UUID]` 指定工作区或会话。非交互的无参数命令显示帮助，不隐式读取 stdin。

```sh
forge run --workspace '/path with spaces' -- 'Summarize this workspace'
forge resume UUID 'Continue the task'
```

使用 `--prompt-stdin` 明确从 stdin 读取提示词。run 的 `--json` 输出 version 1 JSONL event/result envelope，不是交互界面。具体选项以 `forge --help` 为准。

## 思考强度

```sh
forge config set --reasoning-effort high
forge config show
forge config set --reasoning-effort default
```

此项持久化为共享 provider 配置，后续 CLI 和桌面模型请求使用该设置。可选值为 `default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`；未设置或 `default` 时不发送思考强度字段，使用服务端默认值（`none` 则明确发送禁用值）。Chat Completions 发送 `reasoning_effort`，Responses 发送 `reasoning.effort`。不同模型/网关支持的档位不同，不支持时可能拒绝请求；不会自动降档重试。这不是思考过程显示开关，也不是单次 run 参数。

## 交互按键

- 输入 `/` 打开 composer 下方的命令建议；继续输入过滤。最多显示 8 个选项。
- 上/下箭头或 Ctrl+P / Ctrl+N 导航；Enter 提交选中的完整命令。
- Tab 补全命令并保留尾部空格；Esc 关闭建议但保留完整草稿。
- `/model` 打开模型 picker；输入过滤，Enter 选择，Esc 取消。`/model EXACT_ID` 仍支持明确 ID。富终端中切换模型后会接着打开思考强度 picker；取消强度选择保留原强度，不撤销模型切换。catalog 不保证额度或可用性。
- `/reasoning`（也可从 `/` 菜单选择）独立打开思考强度 picker，当前档位预选；Esc 取消不保存。`/reasoning high` 等可直接设置，`/reasoning default` 恢复服务端默认。设置保存为共享全局配置，从后续请求生效；plain 模式无参数仅列出档位，使用带参数命令设置。
- `/resume` 打开持久化会话 picker；`/resume UUID` 明确选择会话。选中项下方显示状态、本地更新时间和工作区，长路径保留首尾。
- 列表超出当前窗口时显示可见范围与总数；方向键继续浏览，输入文字过滤。
- 运行期间可以编辑下一条草稿；busy 时 Enter 不应派发第二次运行，完成后再明确提交。
- Ctrl+C 取消运行并恢复输入；空闲时清除草稿，再次中断退出。EOF 退出。`/quit` 正常结束。

审批默认拒绝。查看完整 argv 和来源后，仅用请求出现之后新输入的 `y` 加 Enter 授权。粘贴、预输入、历史回忆不是授权；拒绝已结束的请求不能靠后来输入 `y` 复活。每次请求都需独立决定。

主题有 system/light/dark；system 根据终端背景信息解析。`NO_COLOR` 禁止 SGR 但允许必要的光标控制；TERM=dumb 与非 TTY 使用 plain 输出。Markdown、工具输出和外部文本均不应直接注入未受信任的终端控制序列。

## 命令与边界

`/help` 提供当前完整命令列表，包括 mode、plan、model、permission、sessions、resume、new、fork、rename、archive、compact、diagnostics、context、skills、checkpoints、mcp、export、quit。Slash 参数按空白切分，不支持 shell 式引号分组；含空格的路径或参数使用直接命令。shell 对直接命令负责引号分组，MCP 的 `--` 分隔后续服务器参数。

`forge config show` 只显示公共配置；`forge config set --api-key-stdin` 避免把 key 放在 argv。不要分享私有配置。`/export` 导出对话，分享前检查。checkpoint restore 会修改文件，先 list/diff。非交互自动审批仅限明确的 unrestricted 权限与 `--yes`；workspace 权限不能自动授权。

## 源码工作区验证

运行 `env -u NO_COLOR TERM=xterm-256color pnpm test`、`pnpm typecheck` 和 `pnpm exec biome check src/cli tests/cli`。完整测试包含富终端呈现断言，需要上述明确的终端环境；NO_COLOR、dumb 和非 TTY 降级由专门用例覆盖。终端模拟器测试需要预先准备 Chromium、xterm.js 和官方 Unicode11 addon；缺少资源会明确失败，不会跳过测试或自动安装。

`scripts/qa-cli-terminal.mjs --suite v2` 使用真实 PTY，记录原始终端字节、按键、窗口变化和请求，再通过浏览器中的 xterm.js 生成截图与逐格数据。它覆盖菜单、模型与会话选择、流式草稿、审批、中断、EOF、窄窗口、Markdown、文件差分和长会话。模拟 provider 的交互验收与真实 API 连通性验收分别进行。

每个尺寸和主题使用独立工作区及新的证据目录。以下是一组示例；完整矩阵分别运行 40、80、120 列的 light 和 dark 六组：

```sh
env -u NO_COLOR TERM=xterm-256color node scripts/qa-cli-terminal.mjs --cli dist/cli.mjs --suite v2 --cols 80 --themes dark --evidence-dir .omo/evidence/cli-80-dark-UNIQUE
```

`--scenario NAME` 运行单一场景。启动、菜单、选择器与扩展场景使用指定的初始宽度；部分交互场景从 120 列开始，再执行明确的 80／40 列缩放。验收报告须区分这些覆盖范围。

`QA_CHROME` 可指定现有 Chromium。主截图脚本的 `XTERM_ROOT` 指向包含 `@xterm` 的目录；单元测试的 `XTERM_ROOT` 指向 `@xterm` 目录本身。Unicode11 addon 的默认位置是 `.build/qa-deps/@xterm/addon-unicode11`。截图脚本会先验证中文、emoji、组合字符及光标的实际单元格宽度。
