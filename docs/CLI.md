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

## 上下文预算

- 已知模型窗口时，按估算 token（含系统指令、工具定义、对话和 continuation）在窗口的 **80%** 触发自动压缩，尽量整理到 **60%**；不再用默认 100000 字符限制大窗口模型。
- 优先保留最近 **3 个人类请求轮次**原文。只合并旧摘要与新历史，摘要请求分块且不重放工具；完整会话仍保存在本地。极端超限会进一步裁剪完整旧轮次/工具交换；最新请求、最近交换或未决调用本身超限时仍安全报错。
- token 是启发式估计，不是精确 tokenizer；窗口元数据也可能受网关限制。未知模型不猜窗口，仍用 `--context-chars`（默认 100000）兜底。底栏显示窗口占用和压缩触发值，窄终端会缩略。
- 可显式声明当前模型/网关的实际窗口：`forge config set --context-tokens 128000`（`auto` 清除覆盖）。
- 可选较低的全局 token 预算：`forge config set --context-budget-tokens 64000`；`auto` 恢复随窗口计算。已知窗口时实际阈值取此预算与窗口 80% 的较小值；未知窗口时使用显式 token 预算代替字符兜底。
- `/compact` 是主动整理全部已有历史，不受“保留最近 3 轮”的自动策略限制。摘要失败会保留带失败标记的有限摘录，不代表完整语义记忆。

## 交互按键

- 输入 `/` 打开 composer 下方的命令建议；继续输入过滤。最多显示 8 个选项。
- 上/下箭头或 Ctrl+P / Ctrl+N 导航；Enter 提交选中的完整命令。
- Tab 补全命令并保留尾部空格；Esc 关闭建议但保留完整草稿。
- `/model` 打开模型 picker；输入过滤，Enter 选择，Esc 取消。`/model EXACT_ID` 仍支持明确 ID。富终端中切换模型后会接着打开思考强度 picker；取消强度选择保留原强度，不撤销模型切换。catalog 不保证额度或可用性。
- `/reasoning`（也可从 `/` 菜单选择）独立打开思考强度 picker，当前档位预选；Esc 取消不保存。`/reasoning high` 等可直接设置，`/reasoning default` 恢复服务端默认。设置保存为共享全局配置，从后续请求生效；plain 模式无参数仅列出档位，使用带参数命令设置。
- `/resume` 打开持久化会话 picker；`/resume UUID` 明确选择会话。选中项下方显示状态、本地更新时间和工作区，长路径保留首尾。
- 列表超出当前窗口时显示可见范围与总数；方向键继续浏览，输入文字过滤。
- 运行期间 Enter 将消息加入下一轮队列，不并发派发运行；当前运行成功后按 FIFO 发送。取消/失败后暂停，通过 `/queue run` 显式继续，`/queue clear` 清空。
- 向当前运行插话使用 `/steer 内容` 加普通 Enter，或支持独立键码的终端中的 Shift+Enter。部分终端会把 Shift+Enter 发成普通 Enter，此时必须使用 `/steer`。插话在当前模型请求及整批工具交换结束后的安全边界进入当前运行，不强杀工具、不重放副作用，也不能保证模型一定遵从。
- 输入区固定显示 Steer/Queue 数量和各自首条内容预览，不随会话输出滚走，输入草稿时也保留；窄/矮窗口会缩略，审批与选择器临时隐藏。`/queue` 查看更多内容。插话交给运行时有明确回执；未消费的插话在运行结束后保留为暂停队列，不悄悄附到后续运行。
- Ctrl+C 在没有文字选区时取消运行并恢复输入；空闲时清除草稿，再次中断退出。EOF 退出。`/quit` 正常结束。
- 富终端使用独立会话视口和固定底部输入区；滚轮或 PgUp/PgDn 浏览会话（包含流式输出）。向上浏览时新输出不会拉回底部，向下滚动到底恢复跟随。
- 鼠标左键拖选会话或输入区文字，Ctrl+C 复制选区，Esc 清除；其他编辑按键会清除选区并按原语义执行。选区存在时暂缓画面更新，后台仍接收输出，清除后显示最新内容。审批和窗口缩放会清除选区，避免隐藏审批或保留失效坐标。
- 复制使用 OSC 52，需要终端允许该剪贴板协议（部分终端或 tmux 配置会拦截）。Shift+拖选通常可绕过应用鼠标处理使用终端原生选区，但原生选区不保证在流式刷新中保留。

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

## 会话与模式更新（2026-10-14）

- CLI 启动不再立即落盘会话：首条真实消息才创建，`/new` 仍显式立即创建；空白、帮助、模式/权限/模型选择、EOF、退出不会创建。`/sessions`、`/resume` 无活动会话也可用；依赖会话的命令明确提示先发消息或新建/恢复。存量空会话沿用显式 archive，不自动删除。
- Shift+Tab（CSI Z）在普通输入区切换 build/plan，保留草稿，文字回显模式；plan 箭头使用 warning tone。审批、picker、文字选区和粘贴不触发。终端不发送该键码时使用 `/mode plan|build`。忙时只影响下一次运行，当前运行权限与模式保持不变。
- 新建且未显式命名的会话在 completed 后后台尝试自动命名一次。先持久化本地首行标题，再用当前模型生成短标题，2 秒超时；失败或退出保留本地标题。不会新增对话消息或消耗运行轮次/工具预算，但可能产生一次模型费用。手动标题、旧版无来源标记标题、fork 和子代理不自动覆盖。CLI 下次 sessions 刷新可见。
- 审批仍为原有 ask/显式 auto、`[y/N]`；审批新需求中的冲突默认值尚待确认，本轮未放宽权限。

### 固定计划与编辑补充

固定屏输入行上方复用状态槽显示当前会话 `Plan n/m` 和当前步骤；/plan 仍显示全文。计划优先于普通耗时/历史提示，极矮窗口隐藏，不扩大 dock。没有计划时，历史浏览显示距底部行数；End 或空草稿 Esc 回到底部。Ctrl+L 重绘；Alt+Enter 换行；Ctrl+U/K 删除至本行首/尾；Alt+B/F 按词移动。Shift+Enter 仍保留 steer 语义。
