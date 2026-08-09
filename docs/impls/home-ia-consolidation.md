# 主页信息架构收拢 — 实施计划

样张（唯一视觉依据）：[`home-ia-consolidation-mockup.html`](home-ia-consolidation-mockup.html)，12 屏。
本文件是把样张翻译成代码任务的清单。**样张和本文冲突时以样张为准。**

## 词汇总表（全项目统一，改名只改这一处口径）

| 这件事 | 现在的名字 | 之后 | 出现在 |
|---|---|---|---|
| 选中一段文字并上色 | 标记 / 划线 / 高亮 / 标注 | **划线** | 选中工具条按钮 |
| 你在书里留下的东西（汇总页） | 标注 | **笔记** | 侧栏行、页标题 |
| 位置书签 | 书签 | **书签**（不变，但和独立笔记并成一样东西） | 阅读器面板 |
| AI 的解释 / 对话 | 解释、对话 | **问答** | 侧栏行 |
| 选中后调 AI | 查词 / 释义 / 解读（三选一） | **解释**（一个名字） | 选中工具条 |
| 单击一个词拿免费释义 | 无 | **词典** | 单击工具条顶行 |

「标记」这个词让给「整词标记 / 查词标记」那套功能，两边不再抢。
「查词」这个名字让给单击的免费词典 —— 否则两个查词一个免费一个收费，必炸。

## 全局纪律

- 所有面向用户的字串走 i18n，`zh.json` / `en.json` 同步改。**禁止对 i18n 文件用 Write 整体覆盖，只用 Edit 局部改**（多个任务并行时会互相吞掉改动）。
- 不写任何版本兼容 / 迁移开关 / 老界面回退（`lantern-no-legacy-compat`）。
- 复习相关文案不带任何催促、指责、倒计时、积压天数。
- 凭证只进 `secrets.db`，不进 `lantern.db`，不进同步容器。
- **砍掉任何零件之前先问：砍掉之后，这件事还有别的路吗？** v3 有三处就是漏了这一问才砍错的。

---

## 步骤 1 — 侧栏收拢 ＋ 词汇统一

**动到**：`src/components/Sidebar.tsx`、`src/components/sidebar-badges.ts`、`src/pages/Home.tsx`（filter 分支）、`src/i18n/{zh,en}.json`（`sidebar.*`）

「随记」→「我的记录」（`sidebar.memos`）。七行 → 四行：

| 行 | 处理 |
|---|---|
| 标注 | 改名 **笔记**（`sidebar.notes` 文案改，filter id `notes` 不变） |
| 单词 | 留。**红点搬到这一行**（原 `dueForReviewCount` 的红点） |
| 复习 | **删行**。入口变成单词页头上的一颗按钮 |
| 对话 | **删行** → 并进「问答」 |
| 解释 | **删行** → 并进「问答」（filter id 用 `qa`） |
| 用户画像 | **删行** → 搬进设置 · 个人（步骤 2） |
| 阅读历程 | 留，独立一行 |

- `activeFilter === "review"` 这条路由删掉；`DictionaryContent` 的 `initialView="review"` 改由单词页自己的按钮切换（组件本来就支持，见 `Home.tsx:492`）。
- 「问答」这一步先只做**路由和名字**：`qa` 这个 filter 暂时渲染现有的 `ChatsContent`，`explanations` 的入口从侧栏消失但组件保留 —— 真正的合并是步骤 7。
- `memoRowBadgeCount` 改成把红点给 `vocab` 行。

**验收**：`npx tsc --noEmit` 通过；`rg '"sidebar.review"|"sidebar.chats"|"sidebar.explanations"|"sidebar.profile"' src/` 无残留引用。

---

## 步骤 2 — 用户画像搬进设置「个人」

**动到**：`src/components/settings/settings-sections.ts`、`src/components/SettingsModal.tsx`、`src/components/settings/PersonalSettings.tsx`（新建，薄壳）、`src/i18n/{zh,en}.json`（`settings.personal.*`）

> 落地时的偏差（核实于 2026-08-09）：`personal` section 已经在，但**那个薄壳没建**——`SettingsModal.tsx:334` 直接 `<ProfileContent embedded />`。计划里的 `PersonalSettings.tsx` 从未存在，别去找它。

- `SETTINGS_SECTIONS` 加 `personal`，`group: "core"`，图标 `UserRound`，放在 `SETTINGS_SECTION_ORDER` 的 **`general` 之后、`reading` 之前**。
- `SettingsModal` 的 render map 加一项，渲染现有的 `ProfileContent`。**`ProfileContent` 内部这一步不动**（内部改动归步骤 3）。
- `isSectionAvailable` 里 `personal` 全平台可用。
- 侧栏底部「设置」那一行的副标题不改。

**验收**：`npx tsc --noEmit`；设置里出现「个人」栏且能渲染画像。

---

## 步骤 3 — 「一键优化」拆成「整理」和「压缩」

**动到**：`src-tauri/src/commands/profile.rs`、`src/components/ProfileContent.tsx`、`src/components/profile/OptimizeComparePanel.tsx`、`src/components/profile/HardLimitDialog.tsx`、`src/i18n/{zh,en}.json`（`profile.*`）

一句话分界：**压缩可以合并，整理不可以。**

| | 压缩 | 整理 |
|---|---|---|
| 管的问题 | 太长了 | 写得乱 |
| 目标 | 字数压到上限内 | 结构清楚，**字数可以变多** |
| 允许 | 合并重复、去掉客套、缩短句子 | **只重排** |
| 禁止 | 丢掉任何一条要求、凭空发明 | **合并或丢掉任何东西** |
| 出现在 | 只在超字数对话框里 | 一直在，编辑框下面 |

- 后端现有的 `profile_optimize_text` **就是「压缩」那一半** —— 改名为 `profile_compress_text`，提示词照旧（它已经是压缩语义）。
- 新增兄弟命令 `profile_tidy_text`，同签名（`text`、`direction`、`app`、`db`、`secrets`），走同一个 `call_utility`。
- 整理的输出格式：**扁平的 `- ` 短句列表**。不要 `##` 标题、不要粗体、不要代码围栏 —— 这段文字会被拼进 system prompt，标题层级会和宿主提示词的结构打架；扁平列表歧义最小、token 最省。
- 整理只做三件事：把成段的拆成一行一条；一行只说一件事；去掉自我描述和客套。
- 两者共用 `OptimizeComparePanel`（加一个 `mode: "compress" | "tidy"` 参数决定文案和调哪个命令）。
- **同一时刻只出现一颗按钮**：字数在上限内 → 编辑框下面是「整理」；超了两倍硬线 → `HardLimitDialog` 里是「压缩」。
- `HardLimitDialog` 保持两颗按钮（回去修改 / 压缩），**不得引入静默截断**。
- 顺手砍掉两行统计文字：`profile.strip` 里的「已攒 18/30」计数、`profile.system.count` 的「5/7 个维度」。**其余全留**：立即总结、移动到文字、幽灵卡、撤销、删卡确认、依据 —— 依据改成默认收起（`profile.expand` / `profile.collapse` 已存在）。

**验收**：`cargo check --manifest-path src-tauri/Cargo.toml`；`cargo test --manifest-path src-tauri/Cargo.toml profile`；`npx tsc --noEmit`。

---

## 步骤 4 — 书签与独立笔记并表

**动到**：新迁移 `src-tauri/migrations/065_*.sql`、`src-tauri/src/commands/bookmarks.rs`、`notes.rs`、`sync.rs`

- 把 `bookmarks` 并进 `notes`，`anchor_kind = 'position'`。**迁移 035 干过一模一样的事**（把 `highlights.note` 并进 `notes`），照那个范式抄，包括它对同步的处理。
- 并表之后「书签」和「独立笔记」是同一行数据：一个位置 ＋ 可有可无的一句话。
- 同步：`updated_by_device` 平局项照现有约定处理，不要新增凭证列、凭证文件或凭证同步事件。
- 旧的 `bookmarks` 表按仓库现有做法处理（不留兼容读路径）。

**验收**：`cargo test --manifest-path src-tauri/Cargo.toml`；迁移在空库和有数据的库上都能跑通（写测试覆盖）。

---

## 步骤 5 — 阅读器面板五标签 → 三标签；笔记页重画

**动到**：`src/components/ReaderTracesPanel.tsx`、`BookmarksPanel.tsx`、`HighlightsPanel.tsx`、`ReaderNotesRail.tsx`、`src/components/AnnotationsContent.tsx`、`src/pages/Reader.tsx`

排在步骤 4 之后，面板一上来读的就是并表后的数据。

阅读器面板：书签和划线**混在一列按位置排**，靠左边那一格区分 —— 一条颜色＝划线，一颗图标＝书签。带不带字都行，不另开一栏。
「记住这里」是唯一的位置类入口（原「在此处添加书签」＋「＋新建笔记」并成一颗），按下去立刻能接着写字，也可以不写。

笔记页（`AnnotationsContent`）：

- 删掉五个筛选 pill 和两个日期选择器。头上只剩搜索框和书籍下拉。
- 时间能力用**按时间分段的列表**补回来：`今天` / `本周` / `更早` 分隔行。
- **必须先给正文加 `onClick` 进编辑，再删铅笔图标** —— 顺序反了就删掉了唯一入口。
- 左边一条颜色＝划线的颜色；左边一颗书签图标＝书签。**页面上不出现一个分类词。**
- 单词不在这一页特殊显示 —— 查过的词归单词页管，一个东西一个家。

**验收**：`npx tsc --noEmit`；`npm run build`。

---

## 步骤 6 — 词典层（和 1–5 完全不相干，可并行）

**动到**：`src-tauri/src/commands/dictionary.rs`、`src/pages/reader/useReaderInteractions.ts`、`src/components/ReaderContextMenu.tsx`、设置里加一个开关、`src/i18n/{zh,en}.json`

**绑定**：单击 = 词典（免费），双击 = 解释（AI，**完全不变，这是核心特色**）。
不新增手势、不新增弹窗 —— 单击本来就会弹工具条，词典只是在工具条顶上多一行。`cancelPendingWordClick` 那套「等一下看是不是双击」的机制已经写好了，双击时词典行来不及出现。

**接口**：主路径换成 `https://dict.youdao.com/jsonapi`，必须带 `dicts` 参数把返回裁到 `ec`（英→中）/ `ce`（中→英）：

- 不加 `dicts`：115 KB / 2.7 秒。加了：**1.4 KB / 0.8 秒**。
- 取 `ec.word[].usphone`（美音）/ `ukphone`（英音）作音标。
- 取 `ec.word[].trs[].tr[].l.i[]`，**每个词性一条字符串，未截断**。
- **先把兜底写对再上默认开**：超时 / 非 200 / 解析失败 → 落回现有的 `suggest`（画质降级，不是空白）。查不到 → 这一行直接不出现，不要「未找到」这种没用的提示。
- 中文词走 `ce` 段，结构和 `ec` 不同要单独解析。
- 两个接口都没有官方契约，没文档没服务条款，随时可能改字段 —— 所以兜底不是可选项。

**展示**：**默认全展开，没有折叠/展开按钮。**

- 按词性分行（`n.` / `v.` / `名`）—— 这是这一屏唯一重要的设计，词性往往直接决定义项。
- 上限：**每个词性最多 2 行，最多 3 个词性**。超出用 `…` 收尾，**不滚动、不展开、不给找回路径**。
- 超了就在下面留一句灰字：还有 N 条较少见的义项没显示 · 双击让 AI 告诉你这里是哪个意思。
- 上限压在词性内部而不是词性数量：**宁可每个词性都露一点，也不要让某个词性整个消失** —— 词性是判断入口。
- **绝不只显示第一个义项**：只给「银行」而书里说的是「河岸」，比不给还糟。
- 不显示词形变化（复数 / 过去式）和考试标签（CET4 / 考研）—— 那是应试词典的零件，跟读书无关。

**改名**：`contextMenu.lookUp`（查词）/ `definePhrase`（释义）/ `interpretPassage`（解读）三个 key 合并成一个「解释」。代码里主按钮本来就只有**一个位置**（`ReaderContextMenu.tsx:174`），按 `classifySelection` 换名换活 —— 现在三个名字统一成一个。

**隐私**：改完之后每点一个词就往 `dict.youdao.com` 发一次请求（今天只在没配 AI 时兜底才发）。**设置里必须写明这件事，并且给一个开关**（默认开）。已有的会话缓存挡住重复词。

**验收**：`cargo test --manifest-path src-tauri/Cargo.toml dictionary`（含解析单测和兜底单测）；`npx tsc --noEmit`。

---

## 步骤 7 — 「对话 / 解释」合并成一个列表

**动到**：`src/components/ChatsContent.tsx`、`src/components/ExplanationsContent.tsx`

> 落地时的偏差（核实于 2026-08-09）：这一步做了，但不是就地改这两个文件——两者被删除，合并结果是 `src/components/qa/`（`QaContent.tsx` + `useQaTimeline.ts` + `types.ts`）。计划里的这两个文件名今天已经不存在。

**单独一步，放最后。** 两种记录字段不同构（一个是多轮线程 `ChatSummary`，一个是绑 CFI 的单次解释 `Explanation`，公共字段只有 `id`/`book_id`/`model`/`created_at`/`updated_at`），混一个时间线要**按类型分叉渲染**，接近重写这两个页面的展示层 —— 这不是删标签。前六步都不依赖它，所以它出问题不会卡住别的。

- 一个列表按时间排，**里面不再分标签**。
- 多轮的在末尾多一行「继续问了 N 轮 · 展开」。

**验收**：`npx tsc --noEmit`；`npm run build`。
