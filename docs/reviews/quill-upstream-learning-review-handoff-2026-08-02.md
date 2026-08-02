# Quill 上游更新学习审查交接

> 日期：2026-08-02
>
> Lantern 分析快照：`main@002feeb`
>
> Lantern 仓库：`/Users/lijianwei/vibecoding/Lantern`
>
> 上游基线：`yicheng47/quill` `v1.2.10`（`b28668f`）
>
> 上游审查目标：`yicheng47/quill` `main@a4376c3`（包含 `v1.2.13`）
>
> 状态：供独立 AI 复核；本文不授权直接修改代码

## 0. 可直接发送给另一个 AI 的提示词

```text
请对 Lantern 从原项目 Quill 分叉后，上游 `v1.2.10` 到当前 `v1.2.13` 的更新做一次独立、证据驱动的学习价值审查。

仓库路径：/Users/lijianwei/vibecoding/Lantern
Lantern 分叉基线：yicheng47/quill v1.2.10，提交 b28668fe987ff10fe92c07c0d05407a6653ffc57
本次已观察到的上游目标：yicheng47/quill main@a4376c30927c8e5f471f7d1ddbe0b7f53c6a74cf，包含 v1.2.13
详细交接文档：docs/reviews/quill-upstream-learning-review-handoff-2026-08-02.md

先完整阅读 AGENTS.md 和交接文档，再执行只读检查。开始时运行 `git fetch origin && git status`，按 AGENTS.md 处理任何非本人改动。然后从 https://github.com/yicheng47/quill.git 获取并核实上述两个上游提交，不要仅依赖交接文档的结论。

重点审查这些上游更新：
1. iCloud 文件“存在但不可读”的限时读取探测、并发保护和 Reader 错误状态（8c3e593）。
2. 点击被 iCloud 驱逐的书籍时主动触发下载（c70f059）。
3. 80%-150% 全局应用缩放、多窗口同步、快捷键、设置持久化和 macOS 标题栏缩放（2eab3b4）。
4. Chats/Words 的书籍筛选从横向 pills 改为带数量的下拉菜单（2560e91）。
5. Chats 和 Words 归入 Memos 的导航调整（3c5df93）。
6. 聊天字号调整及版本、依赖、文档维护提交。

不要默认上游方案正确，也不要默认 Lantern 当前方案更好。逐项给出 Adopt / Adapt / Reject / Defer 结论，并说明：
- 它解决的真实问题和用户价值；
- 上游实现的关键机制、隐患和边界条件；
- Lantern 当前是否已经有等价或更强能力；
- Lantern 的 iOS/桌面、多窗口、用户选择同步目录、书籍转换、OCR、SRS/学习卡和设置架构会如何影响移植；
- 最小可行实现应改哪些现有符号，而不是机械 cherry-pick 哪些文件；
- 必须增加或更新哪些测试；
- 不采用时的明确理由。

特别挑战以下初步判断：
- iCloud 可读性探测和“点击即恢复”可能是最高价值项，但 300ms 阈值、每文件线程、批量并发探测可能带来误判或资源问题。
- 全局缩放值得学习其“本地缓存立即恢复、数据库校准、多窗口同步”模型，但上游 macOS unsafe 标题栏代码不一定适合 Lantern 的移动端路线。
- 下拉筛选可改善大量书籍时的横向溢出，但 Lantern 已有复习到期、查询历史、批量选择和多种排序，不能照搬上游删除排序的做法。
- Memos 分组是产品信息架构选择，不是技术升级；Lantern 的英语学习定位可能要求 Vocab/学习入口保持显著。

本轮只做分析，不修改代码、不提交、不推送。最终输出请按严重性和价值排序：先给结论，再给逐项证据表，然后给推荐实施顺序、明确跳过项和仍需用户决定的问题。所有代码判断都要引用当前 Lantern 文件/符号或上游提交。
```

## 1. 审查目标

本次不是询问“上游有哪些提交”这么简单，而是要回答：

1. 哪些更新揭示了 Lantern 当前仍存在的真实缺口。
2. 哪些实现模式值得学习，但必须按 Lantern 架构重写。
3. 哪些只是 Quill 的产品选择，不适合 Lantern。
4. 若后续实施，最小、安全、可验证的顺序是什么。

本文记录的是前一轮分析的证据和初步判断，不是预设答案。审查者应主动寻找反例。

## 2. 精确基线与复核命令

| 对象 | 提交 | 日期 | 说明 |
| --- | --- | --- | --- |
| 分叉基线 | `b28668fe987ff10fe92c07c0d05407a6653ffc57` | 2026-06-30 | Quill `v1.2.10` |
| 上游当前主线 | `a4376c30927c8e5f471f7d1ddbe0b7f53c6a74cf` | 2026-07-30 | 已包含 Quill `v1.2.13` |
| Lantern 分析快照 | `002feeb40125e68dc595076e07b88b9d79ff6966` | 2026-08-02 | 本文形成前的 Lantern `main` |

建议只读复核：

```bash
git fetch origin
git status --short --branch
git fetch https://github.com/yicheng47/quill.git b28668fe987ff10fe92c07c0d05407a6653ffc57
git fetch https://github.com/yicheng47/quill.git refs/heads/main:refs/remotes/upstream/main
git show -s --format='%H %ad %s' --date=iso b28668f
git show -s --format='%H %ad %s' --date=iso refs/remotes/upstream/main
git log --format='%h %ad %s' --date=short b28668f..refs/remotes/upstream/main
git diff --stat --find-renames=20% b28668f refs/remotes/upstream/main
```

若上游 `main` 已前进，不要把新提交混入本文统计后仍沿用本文数字。先报告新的目标提交，再分别比较 `b28668f..a4376c3` 和 `a4376c3..新目标`。

## 3. 已确认的上游变化规模

从 `b28668f` 到 `a4376c3`：

- 15 个提交。
- 52 个文件发生变化。
- 全仓文本统计为 2,318 行增加、338 行删除。
- 应用源码范围 `src/`、`src-tauri/src/`、`src-tauri/migrations/` 为 909 行增加、287 行删除，净增加 622 行。
- 其余增量主要来自依赖锁文件、版本元数据和文档，不代表新业务能力。

因此，上游这一阶段属于稳定性和体验打磨，不是核心架构重写，也不是 Lantern 当前代码体量增长的主要来源。

## 4. 上游功能提交地图

| 提交 | 上游变化 | 初步价值判断 |
| --- | --- | --- |
| `8c3e593` | iCloud 文件实际读取探测、300ms 超时、同路径 in-flight 保护、并发书籍可用性检查、Reader 打开失败状态 | 高价值，但实现需重点审计资源和误判风险 |
| `c70f059` | 点击 `available === false` 的书籍时仍进入恢复流程，以触发 iCloud 下载 | 高价值、小交互闭环，适合优先考虑 |
| `2eab3b4` | 80%-150% 应用级缩放、快捷键、localStorage/DB 持久化、多窗口同步、macOS 标题栏缩放和测试 | 中高价值，应学习状态模型，不应直接复制平台代码 |
| `2560e91` | Chats/Words 书籍筛选 pills 改为带数量的下拉菜单，并删除部分排序 UI | 中等价值，需保留 Lantern 已扩展的学习和批量操作 |
| `3c5df93` | Chats 与 Words 归到 Memos，Vocab 改名为 Words | 产品决策，不是技术升级 |
| `5bb4788` | 聊天消息与输入区字号调整到 15px | 低风险视觉微调，以实际 QA 决定 |
| 其余提交 | `v1.2.11` 至 `v1.2.13` 版本更新、锁文件、文档归档、Codex model picker 规格、Makefile 清理目标 | 维护或未来规格，不能算已实现功能 |

## 5. Lantern 当前对应状态

### 5.1 iCloud 文件可用性

当前关键位置：

- `src-tauri/src/icloud.rs::file_availability`
- `src-tauri/src/icloud.rs::is_file_downloaded`
- `src-tauri/src/commands/books/query.rs::check_book_available`
- `src/pages/Reader.tsx` 的文件不可用状态

当前 Lantern 已经优于旧基线的一点，是区分：

- `Available`
- `ICloudPlaceholder`
- `Missing`

并且只对真实占位文件触发下载，不把所有缺失文件都当成 iCloud 重试。但 `file_availability` 仍把 `path.exists()` 直接视为可用，不能识别“目录项存在、实际读取阻塞或失败”的异常 iCloud 文件。

上游方案需要审查的风险：

- 300ms 是否会把慢磁盘、网络卷或大型同步目录中的正常文件误判为不可用。
- 每个不同路径最多仍可能留下一个阻塞线程；大书库批量探测时是否会形成大量线程。
- `list_books` 并发探测一页所有书，是否会拖慢启动或列表刷新。
- `path.exists()`、`open()`、`read()` 在不同 macOS/iOS 文件提供程序上的阻塞语义是否一致。
- Lantern 已支持用户选择同步目录和 iOS，不能只验证上游私有 iCloud container 场景。

期望审查者提出至少一个比“原样复制 300ms + thread::spawn”更稳妥的备选方案，并比较复杂度。

### 5.2 点击不可用书籍后的恢复

当前关键位置：

- `src/components/BookGrid.tsx::openBook`
- `src/components/BookList.tsx::openBook`
- `src/hooks/useBooks.ts::checkBookAvailable`
- `src-tauri/src/commands/books/query.rs::check_book_available`

当前 Grid/List 在 `book.available === false` 时直接返回。结果是用户能看到书，但点击没有动作。后端已有区分占位与缺失并触发下载的能力，前端却没有在点击时调用它。

候选改进必须区分：

- iCloud 占位文件：触发下载，显示下载状态，完成后打开。
- 真正缺失文件：明确提示文件缺失或提供修复入口。
- 正在转换或准备的书：沿用现有 preparation 状态机，不能误触发 iCloud 流程。
- 已损坏或存在但不可读的文件：与 5.1 的可读性判断协调。

### 5.3 全局应用缩放

当前 Lantern 只有书籍阅读内容缩放，主要位于：

- `src/pages/Reader.tsx` 的 `zoom`、`applyZoom`、`handleZoom`
- `reader-zoom-${bookId}` 的每书 PDF 缩放持久化

当前没有独立的 app-level zoom。上游值得学习的不是加减按钮本身，而是：

1. 启动时先从 localStorage 同步恢复，减少窗口显示时的尺寸闪烁。
2. 后端设置加载后再校准持久值。
3. 使用 storage 事件同步多个 WebView/窗口。
4. 把应用缩放快捷键与 PDF 内容缩放快捷键分开。
5. 把可测试的快捷键解析、档位吸附提取成纯函数。

Lantern 的额外约束：

- `src/services/platform.ts` 已集中表达桌面和移动平台能力。
- Settings 由 `SettingsHost` 挂在 Router 之上，不能照搬旧 App 结构。
- Lantern 已有主窗口、Reader 窗口和 iOS 路线。
- 上游通过 `unsafe` AppKit 调整 macOS traffic lights；必须证明当前自定义标题栏确实需要它，并为非 macOS 平台明确降级。
- 应审查 Tauri WebView 缩放对 Canvas、PDF、foliate iframe、命中区域和无障碍字号的影响。

### 5.4 Chats/Words 筛选

当前关键位置：

- `src/components/ChatsContent.tsx`
- `src/components/DictionaryContent.tsx`
- `src/components/ui/Select.tsx`

当前仍使用横向书籍 pills 和排序按钮。上游改成带数量的单一下拉菜单，优点是书多时不横向溢出、顶部更紧凑。

但 Lantern 的 `DictionaryContent` 已经增加：

- 复习到期筛选。
- 查询历史。
- 批量选择和删除。
- newest / oldest / A-Z 排序。
- SRS/学习相关状态。

因此审查重点应是“仅把书籍维度改成下拉或响应式菜单”是否更好，而不是照搬上游删除排序和简化数据流。

### 5.5 Memos 导航

当前 `src/components/Sidebar.tsx` 将 Chats 独立展示，并把 Vocab 与 Notes 放在 Saved 下。上游把 Chats 和 Words 放在 Memos 下，但上游没有 Lantern 当前的完整 Notes、SRS 和学习卡定位。

审查者应从目标用户工作流判断，而不是从代码行数判断：

- Chats、Vocab、Notes 是同一类“备忘”对象，还是三个不同频率和目标的工作区。
- 把 Vocab 改名为 Words 是否弱化复习、掌握度和学习卡能力。
- 导航密度是否真的已经成为问题。
- 是否存在更适合 Lantern 的 Learning / Memos / Notes 分组。

除非有明确的信息架构收益，本项默认不应与技术改进一起实施。

## 6. 前一轮初步优先级

这只是待挑战的初步判断：

| 优先级 | 项目 | 初步建议 |
| --- | --- | --- |
| P0 | 点击不可用书籍触发准确恢复流程 | `Adapt`，价值明确且改动可控 |
| P0/P1 | 存在但不可读的文件探测 | `Adapt`，先完成并发、超时和平台设计审查 |
| P1 | 全局应用缩放 | `Adapt`，先写跨平台行为与快捷键规格 |
| P1/P2 | 书籍筛选下拉 | `Adapt`，仅替换书籍维度，不删除 Lantern 学习操作 |
| P2 | Memos 导航 | `Defer`，等待产品信息架构决定 |
| P3 | 15px 聊天字号 | `Defer` 或独立视觉 QA |

## 7. 要求另一位 AI 交付的内容

最终审查至少包含：

1. 一段明确结论：最值得学习的 1-3 项是什么，为什么。
2. 一张逐项表格：`Adopt / Adapt / Reject / Defer`、用户价值、风险、当前等价能力、证据。
3. 对 iCloud 探测方案的技术反驳：阈值、线程、批量列表、移动端和网络卷。
4. 对全局缩放的状态时序说明：启动、持久化、多窗口、快捷键、平台降级。
5. 若实施，每项最小修改的现有文件和符号，不要给机械 cherry-pick 清单。
6. 每项覆盖测试：Rust 单元测试、前端纯函数测试、交互测试和必要的 macOS/iOS 实机检查。
7. 明确列出不建议学习或不建议现在实施的内容。
8. 区分“事实”“推断”“仍需用户决定”，不能把产品偏好写成技术结论。

## 8. 审查边界

- 本轮只读，不修改、不提交、不推送。
- 不因上游代码较新就假设它更正确。
- 不因 Lantern 代码量更大就假设它覆盖了上游边界条件。
- 不把锁文件增长计入产品能力。
- 不把文档规格当成已实现功能；例如 Codex subscription model picker 只有规格提交。
- 不建议直接 cherry-pick。Lantern 已拆分 `books.rs`、扩展 Reader、重构 Settings，并加入移动平台能力，必须按当前所有调用方重新设计。
- iCloud、同步和文件可用性属于数据安全敏感路径；任何建议都必须保持“缺失文件”和“可下载占位文件”的区分。
