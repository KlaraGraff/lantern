# 词卷评卷页 · 复用正文查词交互

> 样张：`quiz-word-lookup-mockup.html`（状态 A–D），已拍板：查询界面直接复用阅读界面的那套。
> 范围：**只在评卷页（GradeView，交卷后）开启**；做题中不开查词。

## 拍板结论

- 手势与菜单**接管线，不造轮子**：正文的手势识别（`src/components/reader-interaction.ts`）是纯 DOM 函数，AI 面板气泡（`usePanelTextSelection.ts` + `detachedInteraction()`）已经证明这套东西能脱离书本用。词卷是第三个接入方。
- 现有评卷页「划选→问 AI 小气泡」（`useAskThread.ts` 的 selectionchange 监听）**并入统一菜单**，不再保留两套浮层。
- 收藏落到同一个生词本、同一套复习，来源列显示「词卷」。这需要一次正式表迁移（难改层，见下）。

## 一、前端交互层

新 hook `src/pages/quiz/useQuizLookup.ts`（参照 `useReaderInteractions.ts` 手势判定 + `usePanelTextSelection.ts` 的脱书接法）：

- 作用范围：GradeView 的文章段落、讲解、题干与选项文本容器（挂 data 标记圈定，样张 A 注明的范围）。
- 单击词 → `wordRangeAtPoint(document, x, y)` → `detachedInteraction()` 产出 `ReaderInteraction`（`location: ""`，`source: "text"`）→ 打开 `ReaderContextMenu`。
- 双击 → 学习卡（同正文快速查询）。
- 三击（`mousedown` 且 `event.detail === 3`）→ `tripleClickRangeAtPoint` 选句/段 → 选段菜单。
- 普通拖选 → 选段菜单（替代现有 useAskThread 气泡的触发方式）。

菜单行（复用 `ReaderContextMenu`，纯展示组件，行由调用方给）：

- 单词：解释（内嵌词典卡，`dictionary_lookup_word` 不依赖书）/ 问 AI / 收藏 / 仅翻译 / 复制 / 朗读。**无「标记」行**——高亮是书内实体。
- 选段：问 AI / 仅翻译 / 复制 / 朗读。
- **问 AI 一律路由到评卷页既有的追问抽屉（AskDrawer）**：出题钉定模型、对话随卷保存，不混进正文 AiPanel。`useAskThread` 里 selectionchange 气泡逻辑删除，入口只剩菜单。

学习卡：`LearningCardController` 的 `bookId` 改为可选。缺省时优雅降级——跳过查询缓存（get_cached_lookup / save_lookup_record）、上下文笔记、记忆线索；`ai_learning_card` 调用本就不带 bookId，不受影响。收藏按钮走下面的新契约。

## 二、收藏契约（前后端接口）

`add_vocab_word` 增加可选参数，旧调用方零改动：

```
add_vocab_word(
  book_id: Option<String>,      // 词卷收藏传 None
  word, definition,
  context_sentence, context_explanation, cfi, card_snapshot,
  source: Option<String>,       // None → "book"；词卷传 "quiz"
  source_label: Option<String>, // 展示用，如 "8/14 今日词卷"（B 端从 paper 日期取）
)
```

- 去重口径：`book_id` 为 NULL 的写入**对全表去重**（任何来源同词 COLLATE NOCASE 即命中）——同一个学习词不该因来源不同出现两条复习条目。命中 watchlist 照旧提升为 confirmed。带 book_id 的写入维持原有「按 (book_id, word) 去重」不变。SQL 里 NULL 比较用 `IS ?1` 不用 `= ?1`。
- 新增只读命令 `check_vocab_exists_global(word) -> bool`（全表 COLLATE NOCASE），菜单用来显示「已收藏」态。

## 三、表迁移（难改层）——`074_vocab_source.sql`

SQLite 放宽 NOT NULL 只能重建表（12 步法）：按 **073 之后的实际生效 schema**（迁移 002/012/017/019/034/044/047/061/067 叠加的全部列）新建 `vocab_words_new`，仅两处不同：

1. `book_id TEXT REFERENCES books(id) ON DELETE CASCADE`（去掉 NOT NULL；NULL 不受外键约束）；
2. 新列 `source TEXT NOT NULL DEFAULT 'book'`、`source_label TEXT`。

拷贝数据 → drop 旧表 → rename → 重建 vocab_words 上的全部索引。**生效 schema 不许凭记忆手抄**：加一个 cargo 测试跑完全部迁移后 `PRAGMA table_info` 断言列集合与索引集合，作为重建正确性的机器验收。

## 四、同步层跟改

- `sync/events.rs`：`VocabPayload.book_id` → `Option<String>`，新增 `source` / `source_label` 字段，全部 `#[serde(default)]`——旧日志里的历史事件（book_id 恒有值、无 source）反序列化不受影响。不做版本门（Lantern 未广泛发布，无旧端兼容负担）。
- `sync/merge.rs`：VocabAdd 插入带新列；按 book 删除的级联（`DELETE ... WHERE book_id = ?1`）天然不碰 NULL 行，符合预期（词卷收藏不随任何书删除）。
- `sync/snapshot/apply.rs`：快照写入带新列。
- 全仓 grep `vocab_words` 的查询：凡 `JOIN books` 的改 `LEFT JOIN` 并给书名回退；凡 `book_id = ?` 且可能吃到 NULL 的改 `IS ?`。复习队列（`list_vocab_due_for_review` 等）不筛书的照旧，词卷词自然进入同一套复习。

## 五、生词本 UI

`book_id` 为 NULL 的行：来源显示「词卷 · {source_label}」（样张 D），**无「定位原文」动作**（没有 CFI 没有书）。列表按书分组的视图给这些行一个「词卷」分组。

## 六、验收

- 后端：cargo 测试——迁移 schema 断言；NULL book_id 增删查；全表去重（含 watchlist 提升）；同步事件新旧负载反序列化 + merge round-trip；`check_vocab_exists_global`。
- 前端:`npm run test:unit`、`tsc`、`eslint` 全绿；交互本身人工验收（评卷页三种手势 + 菜单六行 + 收藏 toast + 生词本来源显示）。
- 文案全部走 i18n（`quizLookup.*` 命名空间，双语言）；复习相关文案不带催促（既有红线）。
