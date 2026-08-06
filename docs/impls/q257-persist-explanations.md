# q257 — Explain 结果持久化

Status: Phase 1 已上线；O-1 已拍板（2026-08-07，按推荐：随选中内容切换主操作）。样张制作中，获批后 Phase 2/3 动代码。

产品裁决见 [`docs/features/q257-persist-explanations.md`](../features/q257-persist-explanations.md)
的「## Decision (2026-08-06)」。本文件不重新讨论那个决定，只把它落到代码上。

## 一句话

**持久化和列表是两层，只有列表是显式的。** 每次解释完成自动写库（`saved = 0`，
这是缓存），再次解释同一段零 API 成本回放；footer 的保存按钮把 `saved` 翻成 1，
列表页只显示 `saved = 1`。忘记按保存不丢东西——重新选中就命中缓存，那时再按。

## 现状盘点

| 东西 | 位置 | 说明 |
| --- | --- | --- |
| Explain 弹层 | [`src/components/ExplainPopover.tsx`](../../src/components/ExplainPopover.tsx) | `useExplainStream` 起流、累积 `contentRef`、`done` 时收尾；footer 已有「存入词典 / 追问 / 复制」三个操作 |
| 解释命令 | [`src-tauri/src/commands/ai/explain.rs`](../../src-tauri/src/commands/ai/explain.rs) | `ai_explain`，纯流式，无返回值；prompt 受 `explanation_mode` 与 `cefr_level` 两个 setting 影响 |
| 自定义动作 | 同弹层，走 `ai_custom_action` | 复用同一个弹层与同一套流式通道 |
| 最接近的先例 | [`src-tauri/src/commands/lookup_history.rs`](../../src-tauri/src/commands/lookup_history.rs) + [`migrations/014_lookup_history.sql`](../../src-tauri/migrations/014_lookup_history.sql) | `normalized_text` + `(book_id, cfi, normalized_text)` 唯一索引 + `get_cached_lookup`，本计划的表几乎是它的姊妹表 |
| 列表页先例 | `AnnotationsContent.tsx` / `DictionaryContent.tsx` | 两个都是手写的，没有共享的「保存项列表」外壳 |
| 跳回原文 | [`src/hooks/useOpenBook.ts`](../../src/hooks/useOpenBook.ts) | `openInReader(bookId, { cfi })`，有窗口就开窗口，没有就换路由 |

两条继承来的纪律：

- **`lookup_records` 不进 iCloud 事件流**（`sync/events.rs` 的 `EventBody` 里没有它的
  变体）。解释表在 v1 同样不进——理由见 §6 O-4。
- 迁移编号连续，最新是 `047_review_pile_curation.sql`，本计划占 **048**。

---

## Phase 1 — 表、命令、归一化

### 1.1 迁移 `src-tauri/migrations/048_explanations.sql`

```sql
-- 解释既是缓存又是用户数据，靠 saved 区分：saved = 0 的行是缓存，可随时清理；
-- saved = 1 的行是读者按过保存的，只有读者能删。与 lookup_records 一样，
-- 本表暂不进 iCloud 事件流。
CREATE TABLE IF NOT EXISTS explanations (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  passage TEXT NOT NULL,
  normalized_passage TEXT NOT NULL,
  explanation TEXT NOT NULL,
  context_sentence TEXT,
  chapter TEXT,
  -- 空串而不是 NULL：SQLite 的唯一索引认为两个 NULL 互不相等，
  -- 若允许 NULL，没有 cfi 的选段永远命中不了缓存，只会不断插新行。
  cfi TEXT NOT NULL DEFAULT '',
  -- prompt 指纹：explanation_mode + cefr_level（+ 将来的模型档位）。
  -- 读者把 CEFR 从 B1 调到 C1 之后，回放一条 B1 的解释是 bug，不是省钱。
  variant TEXT NOT NULL DEFAULT '',
  provider_profile_id TEXT,
  model TEXT,
  saved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_explanations_key
  ON explanations(book_id, cfi, normalized_passage, variant);
CREATE INDEX IF NOT EXISTS idx_explanations_saved
  ON explanations(saved, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_explanations_book
  ON explanations(book_id, updated_at DESC);
```

在 `src-tauri/src/db.rs` 的 `MIGRATIONS` 数组尾部追加
`(48, include_str!("../migrations/048_explanations.sql"))`。

### 1.2 归一化规则

新函数 `normalize_passage(&str) -> String`，**不要复用 `lookup_history::normalize`**——
那个函数为单词写的（只削首尾非字母数字字符），对整段既不折叠内部空白也不处理软连字符。

按顺序：

1. 删除零宽与排版控制字符：`U+00AD`（软连字符，EPUB 断字常留）、`U+200B`、`U+200C`、
   `U+200D`、`U+FEFF`。
2. 把所有连续空白（含 `\n` `\t` `\u{00A0}` 全角空格 `\u{3000}`）折叠成一个半角空格。
3. `trim()`。
4. `to_lowercase()`。

**不做**的两件事，各有理由：

- **不做 Unicode NFC 归一化**——`unicode-normalization` 不是现有依赖，而选段来自
  同一个 DOM，组合形不会在两次选择之间变。要做就等它有第二个用户。
- **不做哈希**——归一化串直接进索引。选段最长也就几百字符，SQLite 的 B-tree 不在乎；
  引入 `sha2` 只为了缩短索引键是没赚到的复杂度。

`variant` 的构造：`format!("{explanation_mode}|{cefr}")`，自定义动作再拼上动作名
（v1 是否缓存自定义动作见 O-3）。

### 1.3 命令 `src-tauri/src/commands/explanations.rs`（新模块）

| 命令 | 签名要点 | 行为 |
| --- | --- | --- |
| `get_cached_explanation` | `(book_id, cfi: Option<String>, passage, variant) -> Option<Explanation>` | 归一化后按唯一键查；`normalized_passage` 为空直接返回 `None`（选中的全是空白） |
| `save_explanation` | `(book_id, passage, explanation, context_sentence, chapter, cfi, variant, provider_profile_id, model) -> Explanation` | `INSERT ... ON CONFLICT(book_id, cfi, normalized_passage, variant) DO UPDATE SET explanation = excluded.explanation, updated_at = excluded.updated_at` —— **`saved` 不在 UPDATE 列表里**，重新解释一段已保存的内容不能把它踢出列表 |
| `set_explanation_saved` | `(id, saved: bool) -> ()` | 只翻标志、只动 `updated_at` |
| `list_explanations` | `(search: Option<String>, book_id: Option<String>, limit, cursor) -> ExplanationPage` | **只查 `saved = 1`**；`search` 同时 `LIKE` `passage` 与 `explanation`；返回 `{ items, next_cursor, total, books }`，`books` 是书籍 facet，形状抄 `LookupRecordPage` |
| `delete_explanation` | `(id) -> ()` | 见 O-6：v1 实现为「移出列表」= `set_explanation_saved(id, false)`，真删只在缓存清理里发生 |
| `prune_explanation_cache` | `(book_id: Option<String>, keep_per_book: Option<i64>) -> usize` | 删 `saved = 0` 且不在每书最近 N 条内的行，默认 N = 50 |

- `Explanation` 结构体 `#[derive(Serialize, Deserialize)]`，字段与表列一一对应，
  外加 `book_title: Option<String>`（列表查询 `JOIN books` 填，缓存查询留 `None`），
  抄 `LookupRecord` 的写法。
- 时间戳一律 `chrono::Utc::now().timestamp_millis()`，与 014 之后的所有表一致。
- `save_explanation` 写完顺手调一次 `prune_explanation_cache(Some(book_id), None)`，
  同一个事务里做——缓存的上限由写入自己维持，不要另起后台任务。
- 在 `src-tauri/src/commands/mod.rs` 挂模块，在 `src-tauri/src/lib.rs` 的
  `invoke_handler` 里逐条注册。
- 书被删时 `ON DELETE CASCADE` 兜底；另外在 `sync/merge.rs` 处理 `book.delete` 的
  位置补一行 `DELETE FROM explanations WHERE book_id = ?1`，与 `lookup_records`
  那一行（`merge.rs:403` 附近）并排——外键在同步回放路径上未必参与。

### 1.4 单元测试清单

放在 `explanations.rs` 的 `#[cfg(test)]` 里，用内存库 + 迁移，抄 `lookup_history.rs`
的 `#[cfg(test)]` 起手式。

1. `normalize_passage` 折叠换行、制表、NBSP、全角空格为单个半角空格。
2. `normalize_passage` 剥掉软连字符与零宽字符；`"soft\u{00AD}hyphen"` 与
   `"softhyphen"` 归一化后相等。
3. 大小写与首尾空白不同的同一段落，归一化后相等。
4. 全空白选段归一化为空串，`get_cached_explanation` 返回 `None` 且不写行。
5. 同一 `(book, cfi, 段落)` 写两次只有一行，`explanation` 被后写覆盖。
6. `saved = 1` 的行被 `save_explanation` 重写后，`saved` 仍是 1。
7. `cfi` 传 `None` 与传 `Some("")` 落到同一行（空串归一）。
8. `variant` 不同 → 两行，互不命中。
9. `list_explanations` 不返回 `saved = 0` 的行。
10. `list_explanations` 的 `search` 命中解释正文（不只是选段）。
11. `set_explanation_saved(id, false)` 之后行还在，但列表里没有了。
12. `prune_explanation_cache` 删掉超出每书 N 条的未保存行，**一条 `saved = 1` 都不删**。
13. 删书之后该书的解释行全部消失。

### 1.5 Phase 1 验收

- `cargo test` 全绿，上面 13 条都有对应用例。
- `cargo check` 通过，`Cargo.lock` 无变化（本阶段不加依赖）。
- 手工：`sqlite3` 打开 `lantern.db`，`PRAGMA user_version` 到 48，`.schema explanations`
  与迁移文件一致。

---

## Phase 2 — 弹层接上缓存与保存

### 2.1 读路径：先查缓存，再发请求

改 `useExplainStream`：

```
effect 启动
  ├─ attempt === 0 且非自定义动作
  │    └─ await get_cached_explanation(...)
  │         ├─ 命中 → setContent(row.explanation); setStreaming(false);
  │         │          setFromCache(true); setSavedId(row.id); setSaved(row.saved)
  │         │          （不发请求，不起 listener）
  │         └─ 未命中 → 照常起流
  └─ attempt > 0（重试 / 重新解释）→ 跳过缓存，直接起流
```

要点：

- **缓存查询失败一律当未命中**，`catch` 掉直接起流。缓存坏掉不能让解释功能不可用。
- 缓存查询是 `await`，在它返回之前 UI 停在现有的 `explain.thinking` 骨架上。
  本地一次索引命中是毫秒级，不需要额外的「查缓存中」状态。
- 重试按钮（`AiRetryButton`）与新增的「重新解释」共用 `attempt` 自增，因此
  **天然绕过缓存**——这是必须的，否则失败重试会一直回放同一条坏结果。

### 2.2 写路径：什么时候落库

只在**流正常结束**时写：`event.payload.done === true` 且 `payload.error` 为空且
`contentRef.current.trim()` 非空。

必须**不写**的三种情况，逐个对应现有代码里的分支：

- `payload.error` 有值（含 settings 类错误）——半截或错误文案不能进缓存。
- `invoke` 直接 throw（`catch` 分支里 `setContent("Error: ...")`）。
- 弹层在流中途被关掉——effect 的 cleanup 会 `ai_cancel`，此时 `cancelled === true`，
  落库调用要放在 `if (cancelled) return;` 之后，跟着现有的守卫走。

写库用 `save_explanation`，参数从弹层已有的 props 直接取：`bookId` / `text` /
`sentence` / `chapter` / `cfi`。`variant` 由后端在 `save_explanation` 内部读 setting
自行拼——前端不该知道 prompt 指纹由哪些 setting 组成；`get_cached_explanation` 同理，
**`variant` 参数从命令签名里去掉，改由后端两边各算一次**。（这一条覆盖 §1.3 表格里
的签名，两个命令都不再收 `variant`。）

写库返回的 `id` 存进 `savedId`，保存按钮要用。

### 2.3 保存按钮

弹层 footer 目前是「存入词典 / 追问 / 复制」，其中「存入词典」调 `add_vocab_word`，
把整段当成一个「单词」存进生词表。对一整句话来说这个行为本来就是错的，现在又要加
第二个保存，footer 会变成四个操作——**这是需要用户拍板的地方，见 O-1。**

技术侧按推荐方案实现（O-1 若被推翻，改动只在这一段）：

- 选中是**单个词**（归一化后不含空格）→ footer 保持现状：「存入词典」。
- 选中是**多词段落** → 主操作换成「保存解释」，调 `set_explanation_saved(savedId, true)`，
  按下后变 `Check` 图标 + 「已保存」，禁用。
- 「保存解释」只在 `savedId` 存在时可用（即已落库成功）。缓存命中时 `savedId` 一开始
  就有，读者可以直接按。

### 2.4 缓存命中时的 UI

要让人看出这是回放，但不能像个警告：

- 内容区顶部、选段引用块下方，一行 12px 弱化文字：「上次解释于 3 天前」（相对时间）。
- 「重新解释」放在**弹层顶栏、关闭「X」左边**，图标按钮（RotateCcw 圆圈箭头，与
  应用里其他刷新/重试处同一符号），带 tooltip（用户 2026-08-07 拍板：不放正文行内，
  不做胶囊按钮）。**常驻**：四个弹层状态（首次解释完成、已保存、单词、缓存回放）
  顶栏都有——第一次的结果也可能不满意，重新生成不是缓存回放的专属出口
  （用户 2026-08-07 拍板）。流式进行中该按钮禁用，流结束后可用。
- 没有加载动画、没有流式光标——内容一次性出现。
- 如果这条已经 `saved = 1`，footer 的保存按钮直接是「已保存」态。
- 「重新解释」= `attempt + 1`，走真实请求，结束后覆盖同一行（`saved` 不变）。

### 2.5 i18n

新增键（`src/i18n/en.json` 与 `zh.json` 同步）：

```
explain.saveExplanation / explain.explanationSaved
explain.cachedAt          // "Explained {{when}}"
explain.reexplain
```

### 2.6 Phase 2 验收

- 解释一段 → 关闭 → 重新选中同一段：立即出结果，`ai_usage` 表无新记录（这是零成本
  回放的机器可验证判据，比看 UI 可靠）。
- 流到一半关闭弹层：库里没有这一行。
- 断网解释失败：库里没有这一行；重试按钮能正常走。
- 改 CEFR 等级后重新解释同一段：发真实请求，库里两行。
- 保存后重开弹层：footer 直接显示「已保存」。
- 中英两种 UI 语言下所有新文案有译文，无 key 泄漏。

---

## Phase 3 — 解释列表

### 3.1 入口位置（推荐：侧边栏「记录」段，同页 filter）

**推荐：在侧边栏「记录」段的「笔记」之后、「阅读统计」之前新增「解释」，
`activeFilter === "explanations"`，同页换内容，不新增路由。**

三条理由：

1. [`docs/roadmap/product-ux-audit-2026-08.md`](../roadmap/product-ux-audit-2026-08.md)
   §四把「侧边栏两套导航模型并存」列为 P1 摩擦：记录段里只有阅读统计是
   `navigate("/reading-stats")`，其余全是同页 filter，审计的原话是留一个路由做例外，
   将来加第二个统计类页面时会再破一次。解释就是那个「将来」。新增一条路由等于把
   已经写在案上的债又抬高一次。
2. 侧边栏三段式已经落地（`Sidebar.tsx` 的 `memoFilters`，`sidebar.memos` 分组），
   语义是「书库（读什么）· 记录（读出了什么）· 收藏集（怎么归置）」。解释是标准的
   「读出了什么」，和生词、笔记同类，spec 里说的 Saved 分组就是现在这个记录段。
3. 加一条 filter 的成本是 `Sidebar.tsx` 一行 + `Home.tsx` 一个三元分支，
   `AnnotationsContent` 的整套列表/搜索/facet/删除确认可以照抄。

条目形状（`Sidebar.tsx` 的 `memoFilters` 数组）：

```ts
{ id: "explanations", label: t("sidebar.explanations"), icon: WandSparkles }
```

图标用 `WandSparkles`——和 `ExplainPopover` 头部同一个符号，读者按下的东西和它的
归档处共用一个记号，这比再挑一个更「像列表」的图标值钱。

排在「笔记」之后、「阅读统计」之前：统计是聚合视图，留在段尾。

### 3.2 `ExplanationsContent.tsx`

新组件，结构照 `AnnotationsContent.tsx`（那是最近写的、离得最近的一个），
不去抽公共外壳——两个现有面板都是手写的，为第三个抽象是过早的。

- 数据：新 hook `src/hooks/useExplanations.ts`，返回
  `{ items, total, books, hasMore, loadingMore, refresh, loadMore, remove }`，
  形状对齐 `useAllLookupHistory`。分页 100 条一页，搜索 180ms 防抖。
- 头部：搜索框（`Input` + `Search` 图标）+ 书籍 `Select`。
- 列表项：
  - 左侧 2px 紫色竖线（`#c084fc`，与弹层的选段引用块同色）+ 选段，斜体、
    12px、`line-clamp-2`。
  - 解释正文，13px，`Markdown` 渲染，默认 `line-clamp-3`，点击整项展开/收起。
  - 底行：书名 · 章节 · 相对时间。
  - 行操作**常驻**（2026-08-07 裁定，对齐 `AnnotationsContent` 的 32px 图标按钮；
    触屏没有悬停，悬停出现的方案作废）：「跳回原文」「移出列表」。
  - 移出列表用**移出箭头图标**（如 `ArrowRightFromLine`），**不用垃圾桶、确认框不用
    危险红**（2026-08-07 用户裁定）——这个动作不删任何东西（缓存还在），视觉不能
    暗示不可逆。行内确认样式沿用，但配色中性。
  - 两处「已保存」（`lookup.saved` 与 `explain.explanationSaved`）**共存不改名**
    （2026-08-07 裁定）：两个按钮互斥出现，按前的按钮文案已说明保存去向。
  - 缓存命中态的「重新解释」入口固定在顶栏「X」左边，图标按钮（用户 2026-08-07 关切：不能让读者
    以为被第一次的结果锁死）——它是缓存回放的法定逃生口，每次命中都必须可见。
- 空态两种：从没保存过任何解释（一句引导：在阅读时选中一段 → 解释 → 保存）；
  有数据但当前搜索/筛选无结果（复用 `annotations.noResult` 那套的「清除筛选」按钮）。
- 跳回原文：`useOpenBook()` → `openInReader(item.book_id, { cfi: item.cfi })`。
  `cfi` 为空串的行不显示这个操作（PDF / 文本阅读器可能给不出 cfi）。
- 移出列表：`set_explanation_saved(id, false)`，沿用 `AnnotationsContent` 的
  行内二次确认（`confirmingId` 那套），不弹模态。

### 3.3 刷新时机

解释可能是在独立的阅读器窗口里保存的，而列表在主窗口。v1 不做跨窗推送：
面板在切成当前 filter 时 `refresh()`，窗口重新获得焦点时 `refresh()`。
`notifyReaders` 是发给阅读器窗口的，方向反了，不要硬套。

### 3.4 i18n

新增 `sidebar.explanations` 与 `explanations.*` 命名空间（标题、搜索占位、两种空态、
移出确认、跳回原文、相对时间单位若不能复用现成的则一并补）。

### 3.5 Phase 3 验收

- 保存 3 条解释（跨 2 本书）→ 列表出 3 条，书籍下拉能筛到各自的书。
- 搜索能同时命中选段和解释正文。
- 点「跳回原文」在阅读器里落到正确位置。
- 「移出列表」后条目消失；回到那一段重新解释仍然是零成本回放（缓存还在）——
  这条是本方案两层结构的核心，必须实测。
- 未保存的解释一条都不出现在列表里。
- 中英双语无 key 泄漏；窄窗（抽屉态）下列表可用。

---

## 样张（开工前的闸门）

按仓库约定，**新板块和界面大改先出样张**。Phase 3 是新板块，Phase 2 动了弹层 footer，
两者都要先渲染成单文件 HTML 给用户看过再写实现代码。样张放
`docs/impls/q257-explanations-mockup.html`，一次给全，不分批。

必须覆盖的状态：弹层 footer 的两版对比（O-1 的两个选项各一屏）、缓存命中态、
列表满态、列表首次空态、搜索无结果态、移出列表的行内确认态、窄窗抽屉态。

### Figma design prompt — 解释列表（记录段）

> 为一个阅读应用设计「解释」列表面板，它和已有的生词、笔记面板并列在同一个侧边栏
> 分组下，视觉语言必须与它们同族——同样的行高节奏、同样的分隔线、同样的搜索框与
> 筛选下拉位置。
>
> 每一项承载两段文本：读者当初选中的原文（引用感，弱化，最多两行），和 AI 给出的
> 解释（正文感，最多三行，可展开）。原文和解释的主次关系要一眼可辨——读者扫这个
> 列表时找的是「我当时在读什么」，解释是展开后才细看的。每项底部是书名、章节、
> 时间这三条轻元数据。
>
> 悬停时露出两个操作：回到原文、移出列表。移出是在行内确认的，不弹窗。
>
> 请给出：满列表、首次空态（引导读者去阅读页选中一段）、搜索无结果、行内确认、
> 以及一个手机宽度的版本。不要标注像素值，我要的是层级和节奏。

### Figma design prompt — 弹层的保存与缓存回放

> 一个从正文选段唤起的解释弹层，底部有一排操作。现在要加入「保存这条解释」这个
> 动作，同时底部已经有「存入词典」「追问」「复制」三个。请给两版：一版四个操作
> 并排，一版把保存提为唯一主操作、其余降为次级。我要比较的是拥挤程度和主操作的
> 可发现性。
>
> 另外设计一个「这是上次解释的回放」的状态：内容一次性呈现而非流式，顶部有一条
> 极轻的说明和一个「重新解释」的出口。这条提示要读起来像一句备注，不像一个警告——
> 回放是好事，是省下的等待，不是降级。

---

## 风险与开放问题

### 风险

| # | 风险 | 处置 |
| --- | --- | --- |
| R-1 | 唯一索引遇上 `NULL` cfi 会永远不去重，缓存无限膨胀 | 表结构里 `cfi TEXT NOT NULL DEFAULT ''`，前端 `null` 在后端转空串；测试 7 专门守这条 |
| R-2 | 流式中途关窗把半截解释写进缓存，之后一直回放半截 | 只在 `done && !error && !cancelled` 落库；测试与手工验收各守一遍 |
| R-3 | 设置变更（CEFR / 解释模式）后回放过时结果 | `variant` 进唯一键；`variant` 由后端算，前端无从绕过 |
| R-4 | footer 操作数量继续膨胀，与 UX 审计对工具栏拥挤的批评撞车 | O-1 先拍板，样张两版对比后再写代码 |
| R-5 | 长选段 + Markdown 让列表项高度失控 | 选段 2 行、解释 3 行硬 clamp，展开才放开 |
| R-6 | 缓存表随重读同一本书增长 | 每书保留最近 50 条未保存行，写入时同事务清理；`saved = 1` 不受限 |

### 开放问题

- **O-1（已拍板，2026-08-07）** 按推荐执行：选中单个词 → footer 保持「存入词典」；
  选中多词段落 → 主操作换成「保存解释」（§2.3）。底部始终三个操作，不做四按钮版。
  样张据此只渲染定案方案，不再做两版对比。
- **O-2** `variant` 变化后，旧 `variant` 的行是留着还是删掉？
  推荐：留着并存——它们是不同的东西，且都可能已被保存。清理交给 R-6 的每书上限。
- **O-3** 自定义动作（`ai_custom_action`）进不进缓存和列表？
  推荐：v1 都不进。自定义动作的 prompt 可以被用户随时改写而名字不变，缓存键无法
  察觉这种变化，回放错误结果的风险高于省下的成本。
- **O-4** 解释要不要进 iCloud 同步？
  推荐：v1 不进，与 `lookup_records` 一致——那张表当初也是先本地、等有了完整的
  事件/合并/快照协议再说。`saved = 1` 的行将来若要同步，是一个独立的事件类型，
  不该顺手塞进本计划。
- **O-5** 缓存上限 50 条/书要不要给用户一个设置项？
  推荐：不要。它是缓存，读者不需要管理它；真要有开关，位置在设置 → 阅读工具，
  和查词历史保留天数并排，那是另一个 issue。
- **O-6** 列表上的「删除」到底删什么？
  推荐：翻回 `saved = 0` 而不是删行，文案用「移出列表」。这样读者清理列表不会
  顺手把省钱的缓存也清掉；真正的删除只发生在缓存清理和删书时。
  如果用户认为「删除就该是删除」，改成真删即可，一行 SQL 的差别。
- **O-7** 给不出 cfi 的阅读器（PDF、纯文本）怎么办？
  推荐：缓存降级为 `(book_id, '', 归一化选段, variant)`——同一本书里同样的文字
  仍然复用，只是失去了位置精度；列表上这类条目不显示「跳回原文」。

---

## 交付顺序

Phase 1 可以立刻开工（纯后端，机器可验收，不碰任何界面）。
Phase 2 与 Phase 3 等 O-1 拍板 + 样张获批。
Phase 3 依赖 Phase 1 的 `list_explanations`，但不依赖 Phase 2——列表可以先用
Phase 1 的命令加几条手写数据跑通。
