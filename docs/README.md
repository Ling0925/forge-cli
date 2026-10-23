# CLI 文档导航

第一次使用从 [仓库 README](../README.md) 开始；命令参数以当前 `node dist/cli.mjs --help` 为准。

## 使用终端

- [CLI 使用与交互](CLI.md)：会话、模型、工具、队列、插话和终端按键。
- [本地 host / attach](CLI_ATTACH.md)：Unix socket、JSONL、任务控制与断线恢复。
- [终端选择与复制](TERMINAL_SELECTION.md)：全屏模式、历史阅读和终端兼容。

## 修改实现

- [开发约定](../AGENTS.md)：仓库边界、构建与提交要求。
- [Core 契约归属](https://github.com/Ling0925/forge-core/blob/master/docs/CONTRACT_BOUNDARIES.md)：客户端共享类型与 schema。
- [Core 输入队列](https://github.com/Ling0925/forge-core/blob/master/docs/INPUT_QUEUE.md)：持久排队与运行时语义。
- [Core 专题导航](https://github.com/Ling0925/forge-core/blob/master/README.md#深入阅读)：项目上下文、模型接入与运行机制。
- [Core 权限与审批](https://github.com/Ling0925/forge-core/blob/master/docs/ARCHITECTURE.md#permission-run-mode-and-cli-approval)：权限和交互审批策略。
- [作者说明](AUTHORSHIP.md)。

CLI 源码在本仓，运行时与存储在 Core，浏览器界面在 Web。独立克隆通过上面的仓库链接查阅跨模块文档；在装配主仓内可直接查看相邻子模块。
