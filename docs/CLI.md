# Forge CLI

## 使用方式

在终端执行 `forge` 开始当前目录的交互会话；`forge chat --workspace PATH [--session UUID]` 指定工作区或会话。非交互的无参数命令显示帮助，不隐式读取 stdin。

```sh
forge run --workspace '/path with spaces' -- 'Summarize this workspace'
forge resume UUID
# 需要单次续跑或脚本调用时：
forge run --session UUID 'Continue the task'
```

`forge resume UUID` 直接恢复为交互会话，等同于 `forge chat --session UUID`：显示历史、沿用会话模型和工作区，等待输入，不自动重放上次操作。需要交互终端；支持 chat 的 `--approval`、`--thinking` / `--expand-thinking`，不接受额外提示词、`--workspace`、`--session` 或 run 专用选项。旧的单次 `resume UUID 'prompt'` 用法改为 `forge run --session UUID 'prompt'`；`/resume` 会话选择器不变。

使用 `--prompt-stdin` 明确从 stdin 读取提示词。run 的 `--json` 输出 version 1 JSONL event/result envelope，不是交互界面。具体选项以 `forge --help` 为准。

## 文件搜索、条件读取与后台命令

工具名不重复扩张：文件名 glob 合并到 `list_files`，内容搜索增强现有 `search_files`，条件读取仍为 `read_file`；不另加 Grep/Glob/Read 别名。

- `list_files(path?, recursive?, glob?, offset?, limit?)`：glob 相对查询根目录，支持 `*`、`**`、`?`，按文件名匹配；跨目录查找需 `recursive:true`。分页只覆盖本次有界扫描，不承诺扫描完整大仓库。
- `search_files(query, path?, glob?, mode?, case_sensitive?, regex?, context_lines?, offset?, limit?)`：默认字面、区分大小写、逐行搜索。`content` 返回命中内容，`files` 只返回命中文件，`count` 返回每个文件的匹配行数（不是出现次数）。regex 是显式、有资源/时间上限的单行正则子集，不支持任意 PCRE 或跨行搜索。`scan_truncated` 与分页 `truncated/next_offset` 分开；二进制、敏感/超大文件仍跳过，搜索不建立写入授权。
- `read_file` 可传 `if_version`：当前 SHA-256 相同则返回 `unchanged:true`、省略正文；省略结果不建立新的读取授权。默认不传就照常返回正文，尤其模型上下文已压缩、需要真正重读时不要传旧版本。返回读取范围/版本，空文件与未变化明确区分。未新增图片、PDF、Notebook 解码能力。
- `run_command` 增加 `background:true`，先完成原审批并确认进程启动，再返回 task ID。前台参数与语义不变，命令仍受既有 120 秒与 64 KiB 输出上限约束；后台不是持久服务器，也不是沙箱。
- 唯一新增后台控制工具 `command_task(action,id?,offset?,limit?,timeout_ms?)`，action 为 list/read/wait/stop；只控制本轮注册表、当前会话拥有的任务。最多 4 个活跃、32 个累计；读取偏移为 UTF-16 字符单位。运行中只返回状态，完成后才发布全量脱敏过的有界输出并分页读取，避免秘密跨输出片段泄露。不是实时日志流。停止会等待进程退出；等待超时不取消。
- 主代理准备结束时会等待未交付后台结果，追加内部结果供其检查；退出/取消会清理本进程任务。不跨进程恢复后台命令，不自动重试失败任务。想常驻开发服务器需另行明确生命周期需求。

## 只读 LSP 查询

只有用户明确配置服务器时，模型才看到一个 `lsp` 工具；没有各操作的重复工具描述，也不自动安装或下载语言服务器。例如已自行安装 TypeScript language server 后：

```sh
forge config set --lsp-servers '[{"id":"typescript","command":"typescript-language-server","args":["--stdio"],"extensions":[".ts",".tsx"]}]'
forge config show
# 关闭
forge config set --lsp-servers '[]'
```

配置存为公共设置，参数不要放密钥。服务器 ID 与文件扩展不允许重叠。`lsp(operation,path,line?,character?,offset?,limit?)` 支持 symbols、definition、references、hover，路径相对工作区，位置为 1-based UTF-16。只请求语义读取，不接受服务器发起的改文件/执行命令；结果有界、过滤工作区外/敏感位置并脱敏。服务器是外部进程，**语义只读不等于 OS 沙箱**：readonly/plan 拒绝，workspace 每次调用经审批，unrestricted 允许。服务器可以自行访问网络或用户配置，审批应考虑风险。每次调用独立启动并清理，不自动重连或回退；会有初始化开销。

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

### 工具上下文瘦身

发给模型的请求副本会省略成功 `write_file/edit_file` 结果中的 before/after 文件预览，只保留执行结果与路径/变更类型，并明确提示省略。完整消息、工具事件、Diff 与 checkpoint 不修改；旧会话恢复后也适用。

缓存优先：已撤销“最近 8 条全文、更旧结果动态摘录”的滑动策略。普通工具结果正文不随年龄改变；成功编辑的预览从首次发送起就固定省略。正常追加消息时，此投影保持历史前缀逐字节稳定；用户消息、助手调用参数及 Responses continuation 不改。摘要请求也使用同一固定精简视图。只有达到既有压缩阈值或显式 /compact 时才集中生成并保存摘要；极端超限仍有既有预算兜底。升级恢复旧会话时投影切换可能造成一次缓存失效，实际命中还受服务商、TTL、模型和工具/指令变更影响，不能承诺缓存命中率或账单降幅。衡量成本应结合 provider 实报输入、cached tokens、未缓存输入与延迟，不只看上下文总量。

模型窗口 80% 自动压缩策略未变，未偷偷更改用户设置。需要更早压缩可显式设置 `forge config set --context-budget-tokens 160000`，`auto` 恢复自动窗口预算。合成 60 次小编辑（每次 before/after 各 8192 字符）估算从 250396 降至 7096 tokens；不是用户真实会话或 provider 实测。

## /tasks 运行任务面板

`/tasks` 打开当前会话的子代理和后台命令面板，空闲/运行期间均可用，不等待父任务结束。它是本地 UI，不新增模型工具、不调用模型，也不把浏览结果当成模型已消费结果。

- 列表每页 20 项、活跃优先，可输入过滤当前页；上下键、Enter 进入详情，Esc/Ctrl+C 关闭当前面板层，不停止父任务。列表打开时每秒串行刷新，保留筛选和选中任务；关闭、出错、退出后停止刷新。主运行结束时关闭面板，可重新 `/tasks` 检查结果。
- 详情显示任务类型、状态、模型/当前工具（可用时）、已报告用量和命令退出码；选择 `View result in history` 将当前有界结果页显示到会话视口，Next/Previous result page 切换页后可查看。不是完整日志导出，后台命令运行中仍只提供状态。
- `Stop task…` 有独立的默认取消确认，粘贴不能确认。停止前后均校验归属，只能停止本进程拥有的当前会话/直接子会话任务，不停止兄弟任务、不重放、不清除失败事实。UI 查阅和停止不会替模型调用 resolve 或确认结果已整合。
- 历史子会话来自保存记录；非本进程运行的 `running` 可能过时，标为历史只读，不能接管。后台命令仅保留本进程最近 8 个已结束工具注册表的结果，退出后不恢复这些内存记录；活跃任务不会因历史容量被淘汰。
- 手动审批优先：先关闭 tasks 面板，再显示审批；不会借选择/停止确认批准其他命令。
- `/tasks agent UUID`、`/tasks command UUID` 可按完整 ID 查看；`/tasks stop agent UUID` 或 `... command UUID` 仍需富终端二次确认。plain 终端只输出第一页列表/结果及提示，不提供无确认停止。
- 本轮未实现代理配置 `/agents`、任务重启、直接给子代理发消息或桌面 tasks 面板。

## TUI 呈现层优化

当前 TUI 使用 Ink 6.6（React/Yoga）组件与框架刷新；旧手写屏幕只保留在测试 fixtures，不进入 CLI 运行包。输入解码薄层保留粘贴来源，不改变模型工具能力：

- 选择器在空间足够时分开标题、单行筛选输入、选项/选中详情和快捷键提示。长任务 UUID 标题不再占据输入前缀挤掉选项；矮窗口优先保留输入和至少一个可见选项，极限一行窗口只保留输入。停止确认显示独立确认提示，审批行为不变。
- 长路径/详情按 Unicode 字素保留首尾，中间省略；控制序列在量宽之前过滤，中文、emoji 和组合字符不拆半。详情缩略只做一次分段和线性扫描，避免反复测量长后缀。
- 底栏紧张时优先完整保留思考等级，缩略长模型名；装饰性迷你进度条只在至少 72 列时显示，把窄屏空间留给模型/等级和用量。
- 工具卡首行保留工具名、目标、成功/失败各自的语义色，不再整行压成一种强调色。无色模式继续用状态文字区分。
- 流式更新由 Ink 合并刷新；只在有活动时触发 80ms 动画，阅读模式停止背景重绘。tail 换行和编辑区布局按快照/宽度缓存；完成输出经 Ink stdout 上下文提交一次，不保留无限增长的 Static 列表。

## 交互按键

- 输入 `/` 打开 composer 下方的命令建议；继续输入过滤。按窗口高度最多显示 8–12 个选项，矮窗口缩略。
- 上/下箭头或 Ctrl+P / Ctrl+N 导航；Enter 提交选中的完整命令。
- Tab 补全命令并保留尾部空格；Esc 关闭建议但保留完整草稿。
- `/model` 打开模型 picker；输入过滤，Enter 选择，Esc 取消。`/model EXACT_ID` 仍支持明确 ID。富终端中切换模型后会接着打开思考强度 picker；取消强度选择保留原强度，不撤销模型切换。catalog 不保证额度或可用性。
- `/reasoning`（也可从 `/` 菜单选择）独立打开思考强度 picker，当前档位预选；Esc 取消不保存。`/reasoning high` 等可直接设置，`/reasoning default` 恢复服务端默认。设置保存为共享全局配置，从后续请求生效；plain 模式无参数仅列出档位，使用带参数命令设置。
- `/resume` 打开持久化会话 picker；`/resume UUID` 明确选择会话。选中项下方显示状态、本地更新时间和工作区，长路径保留首尾。
- 列表超出当前窗口时显示可见范围与总数；方向键继续浏览，输入文字过滤。
- 运行期间 Enter 将消息加入下一轮队列，不并发派发运行；当前运行成功后按 FIFO 发送。取消/失败后暂停，通过 `/queue run` 显式继续，`/queue clear` 清空。
- 向当前运行插话使用 `/steer 内容` 加普通 Enter，或 **Alt+Enter**（macOS 通常为 Option+Enter，需终端发送 Esc/Meta）。支持 ESC+CR/LF、CSI-u 和 modifyOtherKeys 的 Alt+Enter 键码；Shift+Enter 保留为兼容别名。Command+Enter 未设为默认，因为终端可能截获、不发送键码；快捷键不可用时使用 `/steer`。插话在当前模型请求及整批工具交换结束后的安全边界进入当前运行，不强杀工具、不重放副作用，也不能保证模型一定遵从。
- 输入区固定显示 Steer/Queue 数量和各自首条内容预览，不随会话输出滚走，输入草稿时也保留；窄/矮窗口会缩略，审批与选择器临时隐藏。`/queue` 查看更多内容。插话交给运行时有明确回执；未消费的插话在运行结束后保留为暂停队列，不悄悄附到后续运行。
- Ctrl+C 在实时界面取消运行；空闲时先清除草稿，空草稿时退出。EOF、`/quit` 正常结束；SIGHUP/SIGTERM 会触发关闭通知并恢复终端模式。
- Ink 使用主屏幕，不捕获鼠标。已完成内容进入终端原生 scrollback，滚动/选择/复制使用终端自身操作，不发送 OSC52。
- **PgUp** 打开近期历史和当前未完成输出的冻结阅读快照；PgUp/PgDn 翻页，**End/Esc** 回到实时界面。阅读中 Ctrl+C 只退出阅读；文本和 Enter 不提交。后台继续运行，审批/选择器会退出阅读保证可见。
- 阅读缓存上限 2000 行 / 1 MB，冻结快照最多 2000 个物理行；待显示完成输出上限 2 MB，超限明确提示，持久化会话不裁剪。完整内容用 `/export`。详见 `TERMINAL_SELECTION.md`。

交互 `forge` / `forge chat` 默认 **full-access**：自动批准现有权限允许的工具请求（含 MCP、浏览器、子代理），启动时提示非沙箱风险，逐次回显自动批准并在每轮结束汇总数量。`/approval manual` 切到逐次询问，提示 `[Y/n]`：本次新鲜空回车或 `y/yes` + Enter 批准，`n/no`、其他非空输入、Esc、取消、EOF 拒绝。粘贴、预输入、历史回忆不是授权。命令不是 OS 沙箱，可访问工作区外文件与网络。`/approval auto` 仅自动批准符合条件的根会话 run_command，其余仍询问。`/approval ask` 是 manual 的兼容别名。CLI 标志 `--approval full-access|auto|manual` 可覆盖启动默认。选择仅本 CLI 进程有效，/new、/resume 保持当前选择，不会把 manual 偷偷切回 full-access；重启恢复默认。plan、readonly 与子代理权限上限优先，审核模式不提升权限。

主题有 system/light/dark；system 根据终端背景信息解析。实时界面、历史、选择器和审批共用同一配色源：亮色鼠尾草 `#55684d`、暗色 `#8fad82`，配合灰阶元数据、绿/黄/红状态色及原有 diff 增删底色。按实际 UI 输出流能力降级为 256/16 色；背景未识别时保留终端原生语义色，不把界面退成黑白，也不猜测背景或改写终端画布。`NO_COLOR` 禁止 SGR 但允许必要的光标控制；TERM=dumb 与非 TTY 使用 plain 输出。Markdown、工具输出和外部文本先清洗，只有受信任的主题 token 能生成颜色控制序列。

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
- 审批默认值后续已按需求方确认更新为 full-access；manual 为 `[Y/n]`，详见上方审批契约。

### 文件编辑工具选择与命令边界

共享核心提示词明确：新建/整体替换文件用 `write_file`，局部字面替换用 `edit_file`，缺少父目录时用 `make_directory`。不得用 Node/Python/sed/cat、重定向或脚本替代原生文件编辑工具。`run_command` 保留构建、测试、git、包管理等用途；正常构建生成产物不等于借命令改写源文件。

文件工具实行运行时“先读后写”：覆盖或编辑已有文件之前，必须由同一会话成功调用 `read_file` 读取当前版本。内部读取、`search_files`、越界空页不算；至少返回一行的分页读取可以建立读取记录，但模型仍须读完与修改有关的页面。文件被外部改动或本次写入成功后，须重新读取；新建文件无需先读不存在的目标。读取记录仅在当前工具实例内有效，重启后须重读，并发会话不能互相授权。`read_file` 额外返回 SHA-256 `version`、`size_bytes` 和 `lines_returned`。内容完全相同的 write/edit 返回 `unchanged: true`，不写磁盘、不创建 checkpoint，也不输出伪 diff。

原生 write/edit 在写入前使用完整 before/after 计算结构化 `patch`，不是工作区累计的 `git diff`。共享层复用有预算的 Myers 搜索，保留原始 Tab、CR 与末尾换行，邻近修改合并并保留 3 行上下文；统计只计完整编辑脚本的真实插入/删除。结果保存最多 400 行、64 个 hunk、24 KiB 编码预算的有序 patch 前缀，单行最多 8192 字符；超限不截半行、不移动后方新增行。`patch.status` 区分 complete / truncated / unavailable，保存截断仍保留精确总增删数与省略计数，计算超预算则不报伪造的 0。原有 before/after 各 8192 字符预览仍保留，其 truncated 不影响新 patch。因此大文件后部的小修改也可显示真实 diff。

CLI 实时与恢复历史优先消费保存的 patch，不读取当前文件重建历史；旧历史只有完整 before/after 时才兼容计算，截断旧记录仍明确不可用。patch 内容与 before/after 同样从模型请求副本剔除，完整工具记录保留。checkpoint 继续保存完整可恢复内容，diff/预览都不是备份；未实现全屏 /diff 或语法高亮。

默认 harness 为原生文件编辑配置 checkpoint store，可通过 checkpoint 恢复；自定义工具注册器未配置 store 时不能承诺恢复。有限的 before/after 预览不等于备份。命令副作用不纳入 checkpoint。这是工具选择指引，不是 shell 写入的运行时检测器，更不是 OS 沙箱；不能声称已强制识别/拦截任意脚本写文件。

`run_command` 运维契约：显式 argv（允许显式 shell），cwd 经路径守卫；最小环境不继承凭据或代理环境变量，但 HOME 使用宿主用户目录（`os.homedir()`，优先尊重宿主 HOME），不再重定向到工作区。因此命令可使用本机用户配置和认证，也可能改动用户目录；命令审批仍须考虑这些副作用。TMPDIR/TMP/TEMP 仍指向工作区，PATH 包含系统工具、宿主 Node 目录及已有的绝对调用方 PATH 目录。超时默认 30 秒、最大 120 秒；stdout/stderr 合计上限 64 KiB，溢出终止进程组并不返回部分输出。编码结果上限 128 KiB，截断有明确标记；UTF-8 尾部不完整序列替换解码。超时/取消等待进程实际关闭。不因压缩面向模型的工具描述而放宽上述行为。

### 底栏会话名称

模型与思考等级后显示当前会话名称，例如 `provider/model (high) · 优化 CLI`，启动信息、双行底栏和紧凑底栏保持同一顺序。尚未创建会话时显示“新会话”；新建、重命名、恢复、分支和运行返回新会话快照时更新。默认标题的会话在运行结束后约 2.2 秒非阻塞刷新一次自动命名元数据；切换会话或进入下一轮运行后，不用旧结果覆盖当前状态。标题只占剩余宽度，过长以省略号截断，极窄窗口优先保留模型/思考等级与右侧上下文统计；标题中的终端控制序列会被清理。

### 上下文缓存率

上下文百分比后显示会话累计缓存率，例如 `≈50.0% · R90% · 128k`，紧凑底栏和双行底栏一致。口径为当前会话所有请求的 `Σ cachedPromptTokens / Σ promptTokens`（输入 token 加权平均，不是逐次百分比的算术平均），跨用户轮次累计；每次模型请求收到用量实报后立即重算，无需等待整轮运行结束。下一请求的预估/生成阶段保留累计值，不显示横杠；新会话未有用量时显示 `R0%`。

恢复会话从持久化请求事件重建；旧记录只有运行汇总时兼容使用汇总，不将请求明细与汇总重复累加。模型切换、上下文压缩不清零；新建/分支会话独立统计。仅统计当前会话自身的模型请求，不混入子代理的独立会话或未记录的后台命名请求，不包含输出 tokens。服务商缺报或缓存数无效的请求不当作零命中，保留有效数据的累计值并显示 `R≈90%` 这样的不完整标记；全无有效数据时为 `R≈0%`，不宣称实测零命中。最多保留一位小数。Chat Completions 继续显式请求 `stream_options.include_usage`。

### 思考内容单行预览

- 当网关下发推理内容（Chat Completions 的 `reasoning_content`，或 Responses 的 `reasoning_summary_text.delta`）时，富终端在可替换的 tail 区显示**单行**思考预览：前缀 `✻`，只保留**最新一行**，随流式滚动原位替换；到达答案正文、工具调用、错误或运行结束时立即清除。
- 思考内容**随会话持久化**：有界（上限 128 KiB）保存在该轮助手消息的可选 `reasoning` 字段上，因此 `/resume`、`--session` 恢复会话后会重建为同样的单行 `✻` 预览（每条助手消息取最新一行）。它是展示专用元数据：**不**进入助手正文字段、**不**发送给模型、**不**进入事件日志，也不是 `providerState`；加密推理仍只作续跑用，不回显。
- plain 模式与机器 JSONL 输出不显示该预览（`reasoning` 仍在持久化 JSON 中，`--json` 导出为事件流，不额外发事件）。这不是“思考强度”开关；思考强度见上。

### 工具结果紧凑卡片

- 实时结果和恢复历史通常显示两行：工具/目标/状态/耗时、关键摘要；有警告时增加一行。不再逐次显示 `details: /tools N` 提示，手动 `/tools N` 仍可用。普通工具不自动铺开正文、完整 JSON 或长日志。
- `run_command` 的命令本身较长、放不进首行时，改为把命令按词折到**悬挂缩进分支**（首行只留 `run_command · done · exit N`，命令逐行缩进，末行以 `╰` 收束，最多 6 行后省略）；能放下的短命令仍保持单行静默卡片，窄于 24 列的极窄窗口回退为单行缩略。只影响 CLI 展示，命令参数本身不变。
- `edit_file` 与覆写 `write_file` 共用结构化 diff：行号、增删符号、分块上下文、长行字素软换行与续行对齐；增删行使用浅底色，相似行变化片段加强强调。新建文件显示总行数与带行号的代码预览，空文件单独提示。默认首个文件最多 20 个物理行，省略时提供 `/tools N` 提示；详情 diff 预算共 200 行，仍受保存 patch 上限约束。不会凭调用参数编造原文，NO_COLOR 下保留符号和行号。历史恢复使用相同记录。
- 工具完成耗时统一递进显示 `ms → s → m → h → d`（1000ms、60s、60m、24h 换单位），ms 显示整数，其余最多一位小数并向下取整。实时按 tool_started 到 tool_finished 的显示端间隔计时，包含期间审批等待；完成后冻结，在 `/tools` 和详情中一致。历史优先使用已保存的起止事件时间，无事件时仅 run_command 可回退到结果中的 duration_ms（命令执行时长），其他无计时数据的旧记录不编造 0ms。
- 内置工具按工具名适配固定字段：文件读取范围、目录/搜索计数和少量路径、写入/替换结果、命令退出码/耗时/首行 stderr 或 stdout、Git 状态/提交/diff 计数、计划进度、指令来源、技能、模型目录、代理状态及浏览器结果。外部 MCP 结构化正文仅提示按需查看，不假装识别任意外部协议。
- `/tools` 列出近期工具；`/tools N` 展开参数和有界详情（结构化结果可显示缩进 JSON），不重新执行工具。详情仍有预览上限，不代表完整文件备份。错误、超时、分页、截断和代理失败在宽度允许时显式显示；极窄窗口文字会缩略。
- 紧凑卡片不改变审批、checkpoint 或执行语义；新文件变更结果新增可选 patch 元数据（持久化和机器 JSON 可见），旧记录仍可读取，模型请求不携带 patch 正文。历史恢复按保存的 ToolResult envelope 还原错误状态，不再把已保存的失败一律显示为成功。

### 子代理进度卡片

子代理活动在可替换的 tail 区显示，每个代理一行，最多 4 个：短 ID、模型、状态和当前工具/命令。工具切换原位替换，不向主会话追加子代理正文、命令日志或 diff；命令结束后回到 thinking。子代理自动审批只更新卡片，不再单独追加 Auto-approved 记录；手动审批仍正常弹出，不能因折叠进度而跳过确认。结束/失败只追加一次简短状态，原始结果保存在子会话中，主代理仍正常收到结果进行整合。

核心 agent_update 事件新增可选的有界 currentTool 字段，不转发文件正文/修改文本/工具结果；命令参数沿用常见秘密模式脱敏（不是任意秘密检测器）。历史恢复将 agent_reconciliation 原文折叠为提示，持久化内容不删除。无可替换 tail 的纯文本输出不逐步打印子代理进度，仅保留结束状态。机器事件流仍包含结构化进度事件。

### CLI 显示与输入历史补充

- CLI Markdown 使用 `marked` + `marked-terminal`（GFM），不再使用手写逐行解析；支持嵌套/任务列表、六级标题、强调/删除线、引用链接与对齐表格。代码块使用语言分隔线与缩进，`cli-highlight` 负责高亮；未知语言纯文本。表格过窄/超过 12 列或整段超过 100000 字符时降级源文本。流式整段更新，在工具/结束边界提交；链接仅显示文本、图片不联网。详见 `MARKDOWN_REQUIREMENTS.md` §12。Diff 显示增删行数；源内容截断时标明 `partial preview`，不是完整文件统计。
- 动态区域按终端实际高度分配，不再限制为 20 行；编辑区最多 6 行，Slash 建议最多 8 项，剩余空间给流式内容。菜单/选择器打开时保留少量实时输出；矮窗口优先输入。高度 ≤20 行使用紧凑上下文底栏。
- 复制完全使用终端原生操作，无 OSC52 回执或系统剪贴板程序。`INK_SCREEN_READER=true` 启用 Ink 无障碍路径并关闭 timer-only 动画/未完成 tail，完成内容正常输出；真实读屏软件仍需人工验收。
- `/history on` 显式开启当前进程的输入历史加载/保存；新进程需再次开启。`/history off` 停止记录并清空当前编辑器历史，保留已保存文件；`/history clear` 清空当前工作区的持久历史并停止记录；`/history status` 查看状态。
- 历史按工作区隔离，位于 `FORGE_HOME/prompt-history`（默认 Forge 数据目录），目录 0700、文件 0600，每工作区最多 1000 条/1 MB。审批答案、slash 命令、首字符空白及常见秘密模式不保存；**不能识别任意秘密，敏感输入请先关闭记录**。此开关不影响原有会话消息持久化。并发锁冲突/存储失败会停止记录并提示，不自动重试。运行中 `/history` 命令排队到本轮结束再处理。

### 固定计划与编辑补充

输入区旁显示当前会话 `Plan n/m` 和当前步骤；`/plan` 显示全文。运行状态优先，空间不足时缩略计划和上下文，不挤掉输入。PgUp 阅读时显示快照范围，End/Esc 回实时。Alt+Enter steer，换行使用行尾 `\` 后 Enter 或多行粘贴；Ctrl+U/K 删除至本行首/尾；Alt+B/F 按词移动。Shift+Enter 仍保留 steer 语义。
