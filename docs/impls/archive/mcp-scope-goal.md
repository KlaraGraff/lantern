# Lantern MCP 改造目标（执行提示词）

> **Archived — shipped.** This is the goal the MCP rework was executed
> against. The result is the 29-tool catalog documented in
> [`mcp-full-product-parity.md`](../../features/archive/mcp-full-product-parity.md).
> Two things drifted afterwards and the shipped code is the authority:
> `export_vocabulary` is a read rather than a write (12 reads, 16 writes), and
> `rmcp` was upgraded 1.7 → 3.1 to put deletion confirmations inside the AI
> client via form elicitation.

你来完成 Lantern 的 MCP 改造。产品方向已经和用户对齐完毕，依据是仓库 README 第四节。**不要重新论证方向，不要扩大范围。** 你的任务是把下面这份目录实现到可交付状态。

工作副本：`~/vibecoding/Lantern-mcp-full-surface`，分支 `codex/mcp-full-surface-audit`。开始前先读 `AGENTS.md`，尤其是 Restraint 一节。

---

## 一 · 产品定义（已冻结）

README 第四节写死了 MCP 是什么：

> 前面三节讲的都是「Lantern 把上下文给了它内置的 AI」。但那些上下文凭什么只有它自己能用？

MCP 的定位是**上下文平权**——内置 AI 拿得到的阅读数据，用户自己的 AI 客户端（Claude Code、Codex）也拿得到。它**不是** Lantern 已发布功能的完整外部控制面。

README 同一节还给了一条硬边界：

> 默认只读；写权限是一个单独的开关，默认关着——**把数据交出去和把控制权交出去是两回事，不该捆在一起**。

由此得到四条判据。每一个候选工具必须能归到其中一类：

| 判据 | 依据 | 处理 |
| --- | --- | --- |
| ① 它是内置 AI 拿得到的**上下文** | README 第四节表格、第一节"它知道的比聊天窗口多" | 必做，只读，不受写开关限制 |
| ② 它让答案**点得回原文** | README 第二节，Lantern 第二个核心主张 | 做，但只需要一个动作 |
| ③ 它是**控制权** | README 点名的"导入书、删书、建合集这些" | 做，放在现有 `mcp_write_enabled` 开关之后 |
| ④ 其余（设备与服务配置、让 Lantern 替客户端调 AI） | README 从未承诺 | **不做** |

### ④ 明确不做的东西

不要实现，不要在文档里留作"后续"：

- 设备与服务配置：语音、OCR、同步、AI 服务与凭据与 OAuth、自定义字体、书籍来源、应用导航与窗口缩放、设置读写、MCP 自身的配置
- 让 Lantern 替客户端调用 AI：AI 查词 / 解释 / 翻译 / 学习卡、书内对话、章节摘要与 embedding 生成、词形 AI 生成、AI 任务取消
  - 理由：调用方本身就是模型。README 第四节标题是「**换成**你自己的 AI」，不是通过 MCP 再调用一次内置 AI。
- 语言档案的写入与评估记录删除：档案是只读上下文，设置在应用里做

砍掉第二组的直接后果：**方案里那套"付费前精确确认"机制整体不需要了。** 不要实现任何与 API 计费相关的确认逻辑。

---

## 二 · 目标目录

29 个工具。**这个数字是审计校验和，不是目标值**；实现中如果有充分理由合并或拆分，改文档和契约测试即可，但不得越过第一节的四条判据。

### ① 上下文 · 只读 · 11 个

| 工具 | 边界 |
| --- | --- |
| `query_books` | 列表/搜索/筛选/排序/分页/计数，或返回单本书的完整用户可见元数据、阅读状态与进度定位、格式、文件与预处理与封面状态、可用性诊断 |
| `query_collections` | 列出/搜索合集，或分页列出某个合集内的书 |
| `query_book_content` | 目录与章节结构、按章节/定位/页/范围返回有界正文、词法检索片段，全部带稳定源位置 |
| `get_book_intelligence` | 预处理、词法索引、embedding、全书概览与章节摘要的状态与内容 |
| `query_annotations` | 书签、高亮、一等公民笔记的列表/搜索/筛选/分页/详情 |
| `query_vocabulary` | 生词列表/搜索/筛选/分页、存在性、详情与统计、待复习项，含释义、语境、来源、掌握状态、FSRS 状态 |
| `query_lookup_history` | 查询历史的列表/搜索/筛选/分页，以及缓存的查询结果 |
| `query_word_forms` | 词形集列表/搜索，或返回单个词形集 |
| `query_word_marks` | 全书规则、启用状态、例外、出现位置标记 |
| `query_chats` | 对话列表/搜索/筛选/排序，或返回单个对话的消息、范围、来源、引用、grounding 与失败状态 |
| `get_language_profile` | 手动等级、换算后的综合档案、考试证据与历史 |

阅读进度属于 `query_books` 的书籍状态，不单设工具。

### ② 点回原文 · 1 个

| 工具 | 边界 |
| --- | --- |
| `open_in_reader` | 在阅读器中打开指定的书，可选定位到指定位置 |

**实现必须走薄路径。** `.mcp-notify` 哨兵文件加应用侧 watcher 已经跑通（现在发 `mcp:books-changed`、`mcp:collections-changed`，见 `src-tauri/src/mcp/notify.rs`）。加一个 `open` domain，前端监听后调用笔记与生词卡上那个「在阅读器中打开」按钮已经在调的同一段代码。

后端预算约 20 行，前端一个监听器。**不要**实现会话令牌、心跳、认领、所有权绑定、过期回收。这是发射后不管的语义：MCP 侧不保证知道是否打开成功，返回值如实说明这一点。

如果做到一半发现薄路径不成立，停下来向用户说明，**不要**自行升级成完整的控制桥。

### ③ 控制权 · 写开关之后 · 17 个

全部受现有 `mcp_write_enabled` 设置控制，默认关闭。

| 工具 | 边界 |
| --- | --- |
| `import_books` | 导入单个或有界批量的本地文件，返回逐项结果 |
| `update_books` | 单个或批量更新元数据、封面、状态、进度、定位、未读/在读/读完 |
| `delete_books` | 永久删除单本或有界批量，带应用的笔记保留选项 |
| `update_collections` | 创建、重命名、重排、增删成员 |
| `delete_collections` | 永久删除合集，不删除其中的书 |
| `save_annotations` | 创建书签，创建或修改高亮与笔记，含颜色、笔记文本、高亮范围原子替换 |
| `delete_annotations` | 永久删除书签、高亮、笔记 |
| `save_vocabulary` | 创建/编辑生词、设置掌握状态、记录 FSRS 复习结果 |
| `delete_vocabulary` | 永久删除生词及其复习状态 |
| `export_vocabulary` | 返回 JSON/CSV 内容，或写入明确的新目标路径 |
| `import_vocabulary` | 预览或执行有界导入，冲突策略为跳过/合并/覆盖 |
| `save_word_forms` | 创建或替换显式给出的词形集（不含 AI 生成） |
| `delete_word_forms` | 永久删除词形集 |
| `update_word_marks` | 创建或修改规则、启用状态、例外、出现标记与范围 |
| `clear_word_marks` | 按范围永久清除某本书的词标状态 |
| `save_chats` | 创建或重命名对话 |
| `delete_chats` | 永久删除对话及其消息 |

### 确认机制

**只保留一类：永久删除。** 保留 `approval.rs` 中与永久删除相关的路径，删掉付费确认相关的全部代码。确认必须绑定确切的对象类型、ID 集合、数量、范围与保留策略；一次性消费，不可重放，不可授权更大的批量。

覆盖式导入（`import_vocabulary` 的 overwrite 模式）与覆盖已有导出目标算破坏性覆盖，同样需要确认；跳过/合并/写新文件不需要。

其余一切——读取、普通写入、取消、可重建缓存清理——直接执行。

---

## 三 · 仓库现状（已核实，不要相信旧交接文档）

旧文档 `docs/impls/mcp-full-surface-handoff.md` 说"没有任何提交"，**这是错的**。核实结果：

| 项 | 实际 |
| --- | --- |
| `main` 上线的 MCP | 29 个工具，只读为主加少量库写入，全部直接读 SQLite |
| 当前分支 | 领先 `main` 4 个提交、约 6700 行；已把工具改名合并成 38 个，加了审批对话框（`approval.rs` 814 行、`McpApprovalDialog.tsx`） |
| `src-tauri/src/mcp/control.rs` | 1059 行，未提交，前端一行没接，模型侧无 handler 走它——完全不通 |
| 架构 | MCP 是 `lantern mcp` 独立 stdio 子进程，与 Tauri 应用不同进程，共享 WAL 模式 SQLite。读写数据零成本，触碰活体界面才需要跨进程 |
| 工作树噪音 | 7 个文件是 rustfmt 递归格式化产生的无关改动：`ai/router.rs`、`commands/ai/routing.rs`、`commands/books/mod.rs`、`commands/dictionary.rs`、`commands/lookup_history.rs`、`db.rs`、`sync/migration.rs` |

分支上那 6700 行的工具实现**大体符合新方向**，留用并补齐，不要推倒重来。

---

## 四 · 执行阶段

### 阶段 0 · 清理

1. `git fetch origin && git status`，检查是否有其他 agent 的在途改动。
2. 把 7 个 rustfmt 噪音文件恢复到 `HEAD`。
3. `control.rs` 不合入本轮。先把含它的当前工作树状态提交到废弃分支 `codex/mcp-control-bridge-wip` 保底，再从 `mcp/mod.rs`、`state.rs` 移除引用并删除该文件。
4. 把 `docs/impls/mcp-full-surface-handoff.md`、`mcp-full-surface-takeover-prompt.md` 移到 `docs/impls/archive/`——它们已被本文件取代。

### 阶段 1 · 冻结目录文档

重写 `docs/features/mcp-full-product-parity.md`：换成本文件第一、二节的产品定义与目录。删掉 67 工具候选、全量控制面的表述、付费确认政策、187 条命令覆盖审计（那份审计的前提是"完整控制面"，已不成立）。

### 阶段 2 · 只读 11 个

对齐名称与 schema，补齐 `get_book_intelligence`（吸收现有 `get_book_summaries` 与 `request_book_index` 的状态部分），去掉 `request_book_index` 的触发语义——除非你验证出 `query_book_content` 的词法检索在没有索引时不可用；若确实不可用，向用户说明后再决定。

同样去掉 `save_language_assessment`、`delete_language_assessments`、`preview_vocabulary_import`（并入 `import_vocabulary` 的预览模式）、`get_settings`、`update_settings`、`get_app_info`、`get_mcp_integration`、`update_mcp_integration`。

### 阶段 3 · 写入 17 个 + 简化确认

补齐写入侧，把 `approval.rs` 收缩到只服务永久删除与破坏性覆盖。

### 阶段 4 · `open_in_reader`

按第二节的薄路径实现。

### 阶段 5 · 收尾

1. **同步 README。** `README.md` 第四节现在写着「一共 29 个工具」和那张"它们能读到"的表；改完之后数字与内容都要重新核对。`README.en.md` 同步。
2. `src/i18n/en.json` 与 `zh.json` 保持同步，无硬编码用户可见文案。
3. 测试：目录契约测试（`tool_router_registers_all_tools`）、每个工具的 schema 测试、写开关关闭时写工具的拒绝行为、每个永久删除工具的绑定/拒绝/一次性/防重放、`open_in_reader` 在应用未运行时的行为。
4. 检查：`cargo test`、`cargo clippy -- -D warnings`、`npx tsc --noEmit`、`npm run lint`、`npm run test:unit`。
5. 合入 `main` 并推送。

### 阶段 6 · 命名抽查（可选，不是门禁）

`docs/testing/mcp-tool-selection-corpus.json` 有 87 条语料，但它是为 67 工具目录写的。删掉不再适用的用例后跑**一次**，只用来发现命名是否容易混淆。发现反复混淆的一对再考虑合并或改名；单次误选不作为证据。**不要**把它当成冻结目录的前置门禁。

---

## 五 · 硬性约束

- **遵守 `AGENTS.md` 的 Restraint。** 写能跑起来的最少代码。每加一层抽象前先问：资深工程师会不会觉得这过度设计了。上一轮失败的直接原因就是在这里失守。
- **工具数不是 KPI**，但越过第一节四条判据去加工具是范围外行为。
- **不要**做 `enable_toolset`、隐藏域、通用执行器，或任何服务端解锁仪式。`tools/list` 一次返回完整目录。
- **工具描述只陈述事实**：对象、效果、范围、结果、约束。不写"应该什么时候用"、"建议先调用 X"这类教用户干活的内容。
- 凭据类明文永不返回。
- 单项与批量共用一套有界数组 schema，返回逐项成败。
- **测试期兼容政策**：不写任何面向旧版本、旧数据、历史 schema 的兼容或迁移代码。
- 遇到与本文件或 README 矛盾的情况，**停下来向用户说明**，不要自行判断后扩大范围。
- 如需委派子任务，只使用 GPT-5.6 系列 Sub-agent。

## 六 · 留给下一轮的线索（本轮不做）

[issue #11](https://github.com/KlaraGraff/lantern/issues/11) 指出应用内 AI 拿不到生词本和学习状态，而 README 声称语言档案「和内置 AI 用的是同一份」。① 类的查询逻辑将来要被应用内 AI 复用来补上这个不一致。**本轮只需要在写这些查询时不要把它们和 MCP 协议层耦死**，不要实现任何注入逻辑。

---

## 七 · 完成的定义

- 目录恰好是第二节的名单，契约测试与文档一致。
- 每个 ① 工具无需打开写开关即可调用；每个 ③ 工具在写开关关闭时明确拒绝。
- 每个永久删除与破坏性覆盖有精确绑定的一次性确认；其余路径不弹确认；代码里不存在任何计费相关的确认逻辑。
- `open_in_reader` 在应用运行时能打开并定位，在应用未运行时返回如实结果，且没有引入会话/心跳/所有权体系。
- README 中英双语的 MCP 一节与实际目录一致。
- 第五节列出的全部检查通过。
- 改动已合入 `main` 并推送，工作树没有夹带无关改动。
