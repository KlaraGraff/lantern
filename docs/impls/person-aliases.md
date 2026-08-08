# 人物别名与分级路由

样张：[`alias-routing-mockup.html`](alias-routing-mockup.html)（已定稿，8 屏）

## 要解决的问题

问「达西第一次向伊丽莎白求婚」，书里写的是 Darcy 和 Elizabeth。关键词检索按 token 对，两边一个词都对不上。

上一轮 A/B（[`contextual-retrieval-ab.md`](contextual-retrieval-ab.md)）已经确认：定位句在关键词这条路上只是个平局裁判（权重 0.3），救不了差几十名的查询。别名解析走的是另一条路——它不改排序，它改查询本身。

## 分两层，只做第一层

| | 做法 | 每次提问的代价 | 这轮 |
|---|---|---|---|
| 第一层 别名解析 | 按书存一张表，导入时建一次 | 零模型调用 | **做** |
| 第二层 意图理解 | 模糊问句交给模型改写成检索词 | 一次模型往返 | 不做 |

不做第二层的理由：它给**每一个**问题都加一次往返，包括本来就检索得很好的大多数。真要解决「第一次捞得不好」，正确做法是让模型能主动再检索一次，而不是加一个所有人都交过路费的前置阶段。那是更大的改动。

---

## 数据

迁移 **059**（055–057 已被别的会话占用，不要碰；描述类别名的向量表另起一个迁移 **060**，见 `060_person_alias_embeddings.sql`）。

```sql
CREATE TABLE book_person_aliases (
  id         TEXT PRIMARY KEY,
  book_id    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  canonical  TEXT NOT NULL,   -- 书里的写法，如 "Mr. Collins"
  alias      TEXT NOT NULL,   -- 另一种叫法，如 "柯林斯"
  source     TEXT NOT NULL,   -- 'auto' | 'user'
  mentions   INTEGER NOT NULL DEFAULT 0,  -- canonical 在书里出现的 chunk 数
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_book_person_aliases_unique
  ON book_person_aliases(book_id, alias, canonical);
CREATE INDEX idx_book_person_aliases_book ON book_person_aliases(book_id, alias);
```

**关键决定：唯一约束是 `(book_id, alias, canonical)`，不是 `(book_id, alias)`。** 一个别名允许指向多个 canonical——「达西小姐」既可能是 Georgiana Darcy 也可能是 Miss Darcy。置信度分级就是对这个数出来的 `COUNT(DISTINCT canonical)`，不是问模型。

`mentions` 用来在歧义时选默认：出现得多的那个胜出。建表时算一次，`SELECT COUNT(*) FROM book_chunks WHERE book_id = ? AND text LIKE '%canonical%'`。

## 建表（一次模型调用）

放进自动分析注册表，job id **`person_aliases`**，触发层 `BookImported`，层级 Feature。

> ⚠️ `AutoAnalysisJob.id` 必须和 `ai_usage_records.feature` 标签**逐字相同**，否则用量控制台永远显示 0 花费且不报错。传给 `router::complete_with_failover` 的最后一个参数就用这个常量。

输入：书名 + 作者 + `books.language` + 章节摘要拼起来（已有 `book_sections`，不要重读全书）。
输出：JSON，`[{ "canonical": "...", "aliases": ["...", "..."] }]`。

提示词要点（按这个写，别自由发挥）：
- canonical **必须是书里逐字出现过的写法**，不许模型自己规范化。写完在 `book_chunks.text` 里验一遍，验不过的整条丢掉——一个书里不存在的 canonical 加进检索式只会是噪声。
- aliases 要覆盖三类：**目标语言的常见译名**（柯林斯 / 达西）、**书里出现的简称与别写**（Lizzy / Eliza）、**称谓变体**（达西先生）。
- 明确禁止编造原文没有的人物。
- 只要人物，不要地名——地名歧义大、收益小，这轮不做。

失败预算：沿用 `context.rs` 里的写法，连续失败 5 次才判定 provider 挂了。

## 查询时解析（零模型调用）

`fn resolve(conn, book_id, query) -> AliasResolution`

1. 取这本书的全部 alias，**按字符长度降序**。
2. 在原始查询串上做大小写不敏感的子串扫描，**长的先匹配**——「达西小姐」必须赢过「达西」。匹配到就把那一段从待扫描区挖掉，不重复匹配。
   - 中文没有空格，所以是子串扫描不是 token 匹配；拉丁别名额外要求两侧是词边界，避免 "Eliza" 命中 "Elizabeth"。
3. 收集命中的 alias → 它们的 canonical 集合。
4. 检索式扩展：原查询的 token **OR** 上所有命中的 canonical 的 token。原 token 一个都不丢——别名解析只做加法。

**置信度，数出来的：**

| 档 | 条件 | 界面 |
|---|---|---|
| 高 | 至少命中一个 alias，且每个命中的 alias 都只对应 1 个 canonical | 什么都不显示 |
| 中 | 有 alias 对应 >1 个 canonical | 回答**上面**一行「我按 X 找的」+ 换成别的 |
| 低 | 一个 alias 和 canonical 都没命中，**且**查询的文字系统和 `books.language` 不同 | 回答**上面**一行「没认出是谁」+ 回答**下面**一对确认按钮 |

低档那个「文字系统不同」的条件是刻意的：它精确圈住这个功能存在的理由（跨语言提问），而不会在「这本书讲什么」这种问题上冒出来添乱。判断用现成的 `grounding::language`。

中档选默认：`mentions` 大的那个。

## 命令

- `list_person_aliases(book_id)` → 按 canonical 分组，标 source
- `build_person_aliases(book_id)` / 重建（先清 `source = 'auto'`，**保留 `source = 'user'`**）
- `add_person_alias(book_id, canonical, alias)` → source `'user'`
- `delete_person_alias(id)`
- `clear_person_aliases(book_id)` → 全清，含 user

## 界面

**索引管理器**（`IndexManagerModal.tsx`）加一节「人物别名」：空态 / 加载 / 表格 / 清空确认。用户教的和自动认的底色不同——清空的后果不一样，自动的重建能回来，用户的删了就没了，确认文案要点出「包括你教过的 N 条」。

**对话**：中/低档的披露行在回答**上面**（放下面等于让人读完才发现找错人）。低档在回答**下面**给一对按钮：`✓ 对，就是 X` 和 `不是，是别人`；后者展开人物选择器，列的就是这本书的 canonical 列。点完**原地换成回执**，不新起一轮对话。

写回只影响这本书，并立刻出现在别名表里（带底色），随时能删。**一条学错的别名比没有别名更糟**——答案开始跑偏而用户不知道为什么，所以它必须在表里看得见。

所有文案走 i18n，`en.json` / `zh.json` 同步加。

## 验收

单元测试覆盖解析规则：长别名优先、词边界、一个别名多 canonical 判中档、零命中且跨文字系统判低档、同文字系统零命中**不**判低档、原 token 不丢。

效果测试沿用 `context.rs::live_tests` 的套路：同一本《傲慢与偏见》，中文查询，比较「有无别名表」两臂的 gold 段落排名。这次**必须把生成结果落盘缓存**——上一轮 642 次调用的成果随 TempDir 一起没了，换个参数就得整个重来。
