# Lantern MCP 接手提示词

> **Archived.** The takeover it asked for was carried out: the product
> direction was re-derived from README section four and re-aligned with the
> user, producing [`mcp-scope-goal.md`](mcp-scope-goal.md) and the shipped
> 29-tool catalog. The 67-tool candidate it refers to was discarded.

你来接手 Lantern 的 MCP 改造。

请在专用 worktree `~/vibecoding/Lantern-mcp-full-surface` 中工作，不要影响正在由其他任务使用的主仓库。开始前先完整阅读仓库的 `AGENTS.md` 和交接文档：

`~/vibecoding/Lantern-mcp-full-surface/docs/impls/mcp-full-surface-handoff.md`

背景是：上一轮希望让 MCP 全量开放 Lantern 已发布的用户能力，不设置需要用户先启用的工具包，也不通过工具描述教用户怎么做事。只有可能产生 API 费用，以及永久删除、破坏性覆盖等危险且不可逆的操作需要确认。

当前的 67 个工具只是候选方案，已有部分评测材料和未完成实现，不能视为已经确认的路线。请先独立重新评审整个 MCP 产品设计，然后只从产品角度和用户重新对齐，不要先讲实现细节，也不要在对齐前继续写代码。

产品路线明确后，由你自行判断如何拆分任务、评测和完成剩余工作。需要委派时只使用 GPT-5.6 系列 Sub-agent，并妥善保留交接文档中记录的现有修改。
