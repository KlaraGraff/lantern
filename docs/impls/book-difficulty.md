# 书籍难度预览

样张（已确认）：`docs/impls/book-difficulty-mockup.html`。样张是**验收基准**——文案、状态、留白、分色一律以它为准，实现时不要自由发挥。

这份文档只写样张没法表达的东西：数据从哪来、算什么、存在哪、谁在什么时候触发。

---

## 1. 这个功能到底在回答什么

一句话：**这本书对你来说生词多不多。**

不是「这本书是 B2 级」——那是出版社封底干的事，而且不准。我们手上有的是词频表
（`src-tauri/src/word_frequency/english-fiction.tsv`，5 万词，5 个频段）和这本书的全文。
把全文的每个词映射到频段上，得到一条分布，这条分布就是结论本身。等级只是分布的
一个粗糙摘要，所以样张里等级永远是一句带对冲的话（「比你最近读的几本稍难一点」），
主角是那根 100% 堆叠条和下面那张六行表。

**红线：这个功能永远不改用户的水平设置。** 样张里每个等级结论变体都带着那句
「这里不会自己改动你的水平设置」，一个字都不能删。它属于
`docs/impls/reading-driven-mastery-and-review.md` §6 的 category B——证据要很强，
且只提醒不自动改。

---

## 2. 数据来源：不要依赖 `book_chunks`

最省事的做法是读 `book_chunks`（迁移 023 建的 AI grounding 索引表），全文已经切好在里面了。
**不要这么做。** 那张表由 `ai::grounding::index::ensure_index` 填充，而建索引是用户主动
触发的 AI 功能。挂上去的结果是：没开过 AI 的书永远算不出难度，而这个功能跟 AI 一点关系
都没有——它是纯本地的查表统计。

正确的依赖是**抽取器本身**：`ai::grounding::extract` 里的 `extract_epub` /
`extract_text_book` / `extract_pdf`。这三个是纯解析，不发一个网络请求。

`ensure_index`（`src-tauri/src/ai/grounding/index.rs:216`）当前把「从 `books` 行解析出
可读的源文件路径」这段逻辑写在自己函数体里，包括 PDF 走
`commands::ocr::resolver::resolve_active_asset` 拿 OCR 产物这一支。

**第一步是把那段抽成一个函数**，签名大致：

```rust
pub struct ResolvedSource {
    pub path: PathBuf,
    pub format: String,        // 已小写
    pub sha256: Option<String>,
}

/// `None` = 书不存在；`Unsupported` 格式返回 Err 或专门的变体。
pub fn resolve_book_source(db: &Db, book_id: &str) -> AppResult<Option<ResolvedSource>>;
```

`ensure_index` 改为调用它（行为必须完全不变，它现有的测试就是回归网），难度计算也调用它。
一份路径解析逻辑，两个消费者。OCR 那一支尤其不能复制粘贴——它以后还会变。

---

## 3. 算什么

对抽出来的全文：

1. **分词**：按 Unicode 字母边界切，转小写，丢掉纯数字和长度 1 的 token。不要用正则
   `\w+`——它会把 `don't` 切成 `don` + `t`。撇号（`'` 和 `’`）在词内时保留。
2. **归一化**：`FormIndex::new(db)` 建一次，然后每个 token 走
   `word_frequency::lookup_with(&forms, token)`。`FormIndex` 负责词形还原
   （`running` → `run`），建一次复用，不要每个词建一次。
3. **累加**：
   - `band1..band5` —— 命中频段的**词次**（token 数，不是词种数）。
     频段定义见 `word_frequency/mod.rs`：1 ≤1000，2 ≤3000，3 ≤5000，4 ≤20000，5 更罕见。
   - `band_unlisted` —— `lookup_with` 返回 `None` 的词次。样张里的第六段「未收录」。
     专有名词、生造词、外来语都落在这里。**不要把它折进 band 5**——「小说里反复出现的
     人名」和「真正的罕见词」对读者是完全不同的东西，混在一起会让每本小说都显得更难。
   - `total_tokens` —— 上面六项之和。
   - `distinct_words` —— 去重后的词种数，样张的表里用得到。

**样本下限 5 000 词次。** 低于这个数直接落 `too_short` 状态，样张里的文案是
「这份文件不会再变长」——因为触发点是导入，重算也不会变多。不要写成「稍后再来看」。

---

## 4. 存哪：迁移 041

```sql
CREATE TABLE IF NOT EXISTS book_difficulty (
  book_id        TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,     -- pending|running|done|failed|too_short|unsupported
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  distinct_words INTEGER NOT NULL DEFAULT 0,
  band1          INTEGER NOT NULL DEFAULT 0,
  band2          INTEGER NOT NULL DEFAULT 0,
  band3          INTEGER NOT NULL DEFAULT 0,
  band4          INTEGER NOT NULL DEFAULT 0,
  band5          INTEGER NOT NULL DEFAULT 0,
  band_unlisted  INTEGER NOT NULL DEFAULT 0,
  source_sha256  TEXT,              -- 算的是哪一版文件
  computed_at    TEXT,
  error          TEXT,              -- status='failed' 时给样张的失败态用
  override       TEXT               -- NULL|'easier'|'matched'|'harder'|'hidden'
);
```

注册到 `db.rs` 的 `MIGRATIONS`（040 已占用，041 是下一个空号）。

`source_sha256` 是重算判据：文件换了（OCR 重跑、重新导入）就作废重算。
`override` 是样张里「用我自己的判断」写进来的，三选一加一个「这本书不显示难度」；
**自动结论仍然显示在它下面**，不是替换关系——这条是样张明确画出来的，别简化掉。

**不进同步。** 难度是从本地文件算出来的确定性结果，每台设备自己算即可，
往同步日志里塞它只会增加冲突面。`override` 是用户输入，理论上该同步，但它依附于
一个不同步的表——这一版先不同步，等有人抱怨再说（`AGENTS.md`：不写兼容垫片，
所以真要加就是加一个新的同步实体，不是给这张表补字段）。

---

## 5. 什么时候算

- **导入完成后**，在后台线程排一个计算。导入路径已经在做重活了，多一次全文扫描
  不改变用户对导入耗时的感受，而算完之后详情页是秒开的。
- **样张的「现在就算」按钮**：`未分析` 状态下给功能上线前导入的书，或者队列卡住时
  的人工出口。走同一个命令。
- **不做**：打开书时算、定时扫描、启动时批量补算。默默吃 CPU 的后台任务不该存在。

失败就是失败：`status='failed'` + `error`，样张有对应的失败态。**不要重试**，
不要静默吞掉。

---

## 6. 命令

```rust
#[tauri::command] pub fn get_book_difficulty(book_id: String, db: State<Db>) -> AppResult<BookDifficulty>;
#[tauri::command] pub fn compute_book_difficulty(book_id: String, app: AppHandle, db: State<Db>) -> AppResult<()>;  // 异步，事件回报
#[tauri::command] pub fn set_book_difficulty_override(book_id: String, value: Option<String>, db: State<Db>) -> AppResult<()>;
```

`compute_book_difficulty` 立刻返回，把 `status` 写成 `running`，算完 emit
`book-difficulty-{book_id}`——跟 AI 流式那套一样的 per-request 事件通道。样张的
「分析中」状态就是靠它转成「已完成」的。

---

## 7. 前端

### 7.1 书籍详情页（新路由）

`/book/:id` → `src/pages/BookDetails.tsx`。`src/App.tsx` 当前只有三条路由且没有任何
`React.lazy`；这一条按 lazy 加（性能批次刚给其他路由加了 lazy，保持一致）。

**入口是右键菜单的第一项「书籍详情」**，左键点击仍然直接进阅读器——这是样张的
选择，不要改成左键进详情页。

### 7.2 阅读统计页的等级观察行

放在阅读统计页**最底部、隐私说明之上**。无强调底色、无图标。数据来自
`commands/language_assessments.rs` 的申报等级，对比查词行为。三种结论：
判断不了 / 申报偏高 / 申报偏低——样张三个都画了，文案照抄。

**每个变体都必须带那句「这里不会自己改动你的水平设置」。**

### 7.3 i18n

所有文案进 `src/i18n/en.json` 和 `zh.json`。样张是中文的，英文要自己写——
写的时候保持同样的对冲语气，主语永远是书、不是读者。
**JSON 只能逐行编辑**，`JSON.parse` + `stringify` 往返会抹掉仓库里的空行分隔。

---

## 8. 验收

后端命令要有单元测试再碰前端。全量门禁：

```
npx tsc --noEmit && npm run lint && npm run test:unit && npm run build
cd src-tauri && cargo check && cargo test
touch src/lib.rs && cargo clippy --all-targets -- -D warnings
```
