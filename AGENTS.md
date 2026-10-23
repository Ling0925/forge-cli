# Forge CLI 仓库代理约定

本文件适用于 Forge CLI 仓库；位于装配主仓中时，同时遵守外层适用的 `AGENTS.md`。

- 子代理固定使用 `cn:deepseek-v4.1-flash`，除非用户明确指定其他模型；失败不自动切换模型或重放任务。

## 范围

- 只修改本独立仓库：`src/cli/`、`tests/`、构建脚本、包配置和 CLI 文档。
- 跨仓需求在所属仓库另行处理和提交，不从 CLI 的提交中改动父库或其他仓库的索引。
- 桌面端、Web UI、发布、安装和 Rust/Tauri 工作不在本仓库范围内。

## `@forge/core` 边界

- 跨出 CLI 的共享实现一律通过 `@forge/core/...` 子路径导入，例如 `@forge/core/shared/schemas`、`@forge/core/core/harness`、`@forge/core/host/local-client`。
- 不新增 `../../shared/...`、`../../../src/shared/...` 这类跨仓库相对引用。
- 不复制 `@forge/core` 源码，不使用 tsconfig `paths`、Vite alias 或 esbuild alias 伪装包边界。
- `package.json` 使用本地文件依赖 `"@forge/core": "file:../forge-core"`。需要改核心实现时，在 `../forge-core` 单独修改并构建。
- `pnpm verify:boundaries` 会检查上述边界；新增跨仓库导入时应先修正而不是放宽检查。

## 构建与测试

- 独立克隆首次使用时先构建 `../forge-core`，再在本仓执行 `pnpm install` 和 `pnpm build`。主仓开发使用主仓 `node scripts/build-core.mjs`，自动构建 Core、链接依赖并构建 CLI；日常不用重新安装。
- 本仓的 `node scripts/build-core.mjs` 只构建 CLI：生成 `dist/cli-main.mjs` 并复制 production bootstrap 到 `dist/cli.mjs`；不要与主仓同名装配脚本混淆。
- 不要将 `src/cli/bootstrap.mjs` 打进主 bundle，也不要在主 bundle 内设置 `NODE_ENV`；React/Ink 必须在 bootstrap 之后加载。
- 保留 `patches/ink@6.6.0.patch` 和 pnpm `patchedDependencies`，不要用未打补丁的 Ink 替代。
- 默认只做构建、`pnpm verify:boundaries`、`pnpm test:package` 和本轮涉及的 `pnpm exec vitest run <测试文件>`。不把全量 test/typecheck/lint 作为本机更新的前置门槛，也不默认运行桌面构建、Electron 打包、发布校验或安装脚本。
- 启动/测试 CLI 时使用临时 `FORGE_HOME`，避免读取真实配置或改动用户会话；测试后清理临时目录。
- 不把“构建通过”报告成功能全部验证通过；如实说明未覆盖项。

## 运行行为

- 修改入口时保持交互会话、单次运行和 `attach` 各自的协议与恢复契约；用 `docs/README.md` 导航，不把历史拆分记录作为当前使用说明。
- 不引入真实配置、密钥、用户状态或网络凭据到仓库/测试 fixture。

## Git

- 本仓库是独立仓库，提交只包含本仓库本轮自己修改的文件。
- 提交前查看本仓库 `git status` 和 diff，避免夹带构建产物、临时目录或并发任务文件。
- 默认只做本地 commit，不推送；不要改写他人提交或强制操作。
- 主仓本机 launcher 通过根目录 `dist/cli.mjs` 转发到本仓产物，编译后重开生效；不要静默重装或改写 `~/.local/bin/forge`。
