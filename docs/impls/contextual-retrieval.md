# Contextual Retrieval — 给每个 chunk 一句身份

## 为什么

`ensure_embeddings` 现在把 chunk 的裸文本送去 embedding：

```rust
"SELECT c.id, c.text FROM book_chunks c ..."   // vector.rs:328
```

对叙事文本，这产生大量无法被检索到的块。典型例子（《傲慢与偏见》第三十四章，达西求婚之后）：

> She stared, coloured, doubted, and was silent. This he considered sufficient encouragement.

整段没有专有名词、没有事件名。它的向量描述的是「某个女性震惊沉默」，而用户问的是「达西求婚时伊丽莎白什么反应」。两者对不上；同一本书里字面上带「求婚」和人名的段落（宾利向简）反而排在前面。**失败是静默的**——AI 不报错，它自信地讲了另一场戏。

Anthropic 公布的数据（top-20 检索失败率）：

| 做法 | 失败率 | 相对改善 |
|---|---|---|
| 裸 chunk（现状） | 5.7% | — |
| + 上下文前缀 | 3.7% | −35% |
| + 上下文前缀 + contextual BM25 | 2.9% | −49% |

`book_chunks.section_title` 已经存在但从未进入 embedding 输入。不过对小说它几乎没用——检索本来就按 `book_id` 限定在一本书内（`vector.rs:520`），而小说章节标题多半是「第三十四章」，在同一本书内不具区分度。**所以要做就做完整版：让模型读上下文，为每个 chunk 写一句身份。**

## 三条设计原则

**一、原文永不改变。** 身份句只进入 embedding 的输入和（可选的）FTS 索引。`book_chunks.text` 不变，检索命中后喂给模型讲解的仍是书里的原句。因此身份句写错的最坏后果是排序变差，**不可能把不存在的内容塞进引文**。这个性质决定了它可以默认开启。

**二、逐块生成，不批处理。** 让模型一次读一章、输出 N 行身份句，失败模式是静默错位：少输出一行或顺序错一位，之后每个 chunk 都戴上别人的身份，而 500 句通顺的句子看不出任何异常。逐块调用则输入输出一一对应，没有需要对齐的东西。

代价接近于零，因为每次调用的前缀（本章原文）完全相同，命中服务商的前缀缓存：

| | 用量（50 章 / 500 块的小说） | DeepSeek V4-Flash |
|---|---|---|
| 每章首次调用（缓存未命中） | 50 × 3,500 ≈ 17.5 万 | $0.025 |
| 同章后续调用（缓存命中） | 450 × 3,500 ≈ 158 万 | $0.004 |
| 输出 | 500 × 35 ≈ 1.8 万 | $0.005 |
| | | **≈ $0.034 / 本** |

批处理约 $0.033——缓存把它唯一的优势吃掉了。最坏情况（服务商完全不缓存）是 $0.245，约 1.7 元一本，一次性。

**三、分三段存储，不要把身份句即时拼进 embedding 调用。** 身份句由聊天模型产生、与 embedding 模型无关；向量由 embedding 模型产生、与聊天模型无关。存成独立列，换 embedding 模型时身份句免费复用；即时生成则每换一次模型就要重新掏一次钱、重新等一次。

## 阶段划分

一次用户动作（「建索引」），内部三段，各自可续跑：

```
① 切片 + FTS      纯本地，无网络       ensure_index          现状不变
② 写身份句         聊天路由（失败转移）  ensure_context_lines  新增
③ 算向量           embedding 路由       ensure_embeddings     改输入
```

**① 绝不能等网络。** 没有配置 AI 的用户导入书之后照样要能全文搜索。②③ 是叠加在其上的增强，任一失败或未配置，书都必须仍可检索。

## 数据模型

新增 `src-tauri/migrations/050_contextual_retrieval.sql`：

```sql
-- 身份句：模型为这个 chunk 写的一行「它是从哪来的、在讲什么」。
-- 与 book_chunks 的其余列一样是设备本地派生数据，不进同步容器。
ALTER TABLE book_chunks ADD COLUMN context_line TEXT;
ALTER TABLE book_chunks ADD COLUMN context_model TEXT;
ALTER TABLE book_chunks ADD COLUMN context_at INTEGER;

-- 让向量的失效判断能看见身份句的变化。空串表示「embed 时没有身份句」。
ALTER TABLE book_chunk_embeddings ADD COLUMN context_sha256 TEXT NOT NULL DEFAULT '';
```

### 为什么需要 `context_sha256`

`ensure_embeddings` 现在的续跑判断是：

```sql
LEFT JOIN book_chunk_embeddings e
  ON e.chunk_id = c.id AND e.model = ?2 AND e.source_sha256 = ?3 AND e.dimensions = ?4
```

`source_sha256` 是**整本书源文件**的哈希。身份句变了而源文件没变，向量会被判定为「已完成」，于是用户打开这个开关之后什么也不会发生。加一列身份句的哈希（无身份句时为空串）并加进 JOIN，开/关、重新生成、换聊天模型这三种情况就都能正确触发重算。

### 失效矩阵

| 变化 | ① 切片 | ② 身份句 | ③ 向量 |
|---|---|---|---|
| 换 embedding 模型 / 维度 | 保留 | **保留** | 重算 |
| 开关 contextual retrieval | 保留 | 保留 | 重算 |
| 重新生成身份句 | 保留 | 重写 | 重算 |
| 书源文件变化（重新导入） | 重建 | 重写 | 重算 |

第二行是这个设计的全部意义所在：你接下来要把 embedding 从 `text-embedding-3-small` 换到 Jina v5，这一栏保证那次迁移不会重复付费。

## 后端

### 阶段 ② — `grounding/context.rs`（新文件）

```rust
pub async fn ensure_context_lines<R: Runtime>(
    app: &AppHandle<R>, db: &Db, book_id: &str,
) -> AppResult<()>
```

- **待办查询**：`SELECT id, section_index, chunk_index, text FROM book_chunks WHERE book_id = ?1 AND context_line IS NULL ORDER BY chunk_index`。进度 = 已完成 / 总数，天然可续跑，与 `ensure_embeddings` 同形。
- **按 `section_index` 分组顺序处理**，同一章的调用连续发出，前缀缓存才会命中。
- **每块一次调用**。prompt 结构（前缀必须逐字节稳定）：
  - system：固定指令——「你会读到一章原文和其中一段。用一句话说明这段在书里的位置和讲的是谁、什么事。只输出这一句，不要复述原文，不要加引号。」
  - user 第一部分：`《书名》· 第 N 章 <章节标题>` + 本章全文 ← **缓存前缀**
  - user 第二部分：`需要说明的段落：` + chunk 原文 ← 每次变化
- **章节过长的处理**：本章超过 `CONTEXT_WINDOW_TOKENS`（建议 8,000）时，前缀改用「本章前 4,000 token + 目标块前后各 2,000 token」的窗口。窗口在同一章内仍然稳定，缓存不失效。
- **输出清洗**：截断到 200 字符；剥掉引号和「这段讲的是」之类前缀；空输出或纯空白则写入 `''`（空串，而非 NULL）以标记「试过了、没结果」，避免每次运行都重试同一块。
- **路由**：走 `ai::router` 的按序失败转移，与聊天同一条路。用户把本地模型排第一就用本地，排 DeepSeek 就用 DeepSeek——这是路由的既有行为，此处不实现任何选择逻辑。
- **计费打标**：`usage::record(..., origin = "auto", feature = "grounding_context")`。这样它出现在自动分析控制台里，与其他后台花钱的任务同一个位置、同一个开关体系。
- **中断与重试**：任一块失败即整体停止并返回错误，已写入的行保留。下次调用从 `context_line IS NULL` 继续。不做单块重试——路由自己已经有失败转移和冷却。

### 阶段 ③ — 改 `ensure_embeddings`

```rust
// 待办查询
"SELECT c.id, c.text, COALESCE(c.context_line, '') FROM book_chunks c
 LEFT JOIN book_chunk_embeddings e
   ON e.chunk_id = c.id AND e.model = ?2 AND e.source_sha256 = ?3
      AND e.dimensions = ?4 AND e.context_sha256 = ?5
 WHERE c.book_id = ?1 AND e.chunk_id IS NULL ORDER BY c.chunk_index"
```

送给 embedding 的输入：`context_line` 非空时为 `format!("{context_line} —— {text}")`，否则为 `text`。写回时一并存入该块的 `context_sha256`。

`has_complete_embeddings` 同步加上这一项，否则「已完成」的判断会与续跑查询不一致。

### 触发点

`commands/ai/book_index.rs:210` 与 `commands/ai/chat.rs:893` 是现有的两个 `ensure_embeddings` 调用点。两处都改成先 `ensure_context_lines`（当开关打开且路由可用时），再 `ensure_embeddings`。②失败不阻止③——没有身份句的书退化成今天的行为，仍然可检索。

## 设置项

`settings` 表新增 `ai_context_lines_enabled`（`"true"` / `"false"`，默认 `"true"`）。

界面位置：`EmbeddingSettings.tsx`，放在既有的「向量检索」开关**之下**，作为它的子项——未开启向量检索时禁用并置灰，因为身份句只影响向量输入。

需要说清的一件事：**这个开关在 embedding 设置里，干活却走聊天路由。** 文案必须点破，否则用户会以为它用的是上面配置的 embedding 模型。建议副标题直接写明「使用你的聊天模型（按优先级顺序）为每段书写一句检索用的说明」。

i18n 键（`en.json` / `zh.json`）：

- `settings.ai.contextLines` — 标题
- `settings.ai.contextLinesHint` — 一句话说明它做什么
- `settings.ai.contextLinesDetail` — 展开说明：走聊天路由、一次性、约几毛钱一本、写错也不会影响引文
- `settings.ai.contextLinesUnavailable` — 未开启向量检索时的禁用理由

## 前后端契约

前端的进度态与部分失败态（样张状态 4、5）需要后端暴露两个命令。前端已按此契约实现，**命令缺席时优雅降级**——hook 返回 `null`，那一行退回普通的开关状态，不报错、不阻塞面板渲染。后端补齐时按此签名对齐即可，无需前端改动。

```ts
// invoke("context_line_progress") -> ContextLineProgress | null
interface ContextLineProgress {
  book_id: string;
  book_title: string;
  done: number;    // 已有身份句的块数（context_line IS NOT NULL）
  total: number;   // 本书总块数
  failed: number;  // 结束时仍没有身份句的块数（context_line = ''）
  running: boolean;
}

// invoke("resume_context_lines", { bookId }) -> void
// 从断点继续，不是从头重来。等价于再调一次 ensure_context_lines。
```

`done` / `failed` 都从 `book_chunks` 直接数，不需要额外的进度表：`context_line IS NOT NULL` 是完成，`= ''` 是试过没结果。这也是为什么阶段②失败时要写空串而不是留 NULL。

## 裁定：不做 contextual BM25

Anthropic 那 −49% 里，从 −35% 到 −49% 的部分来自把同一句身份也写进 BM25 索引。技术上可行：在阶段②之后 DELETE + INSERT 重写 `book_chunks_fts` 中该 chunk 的行即可。

**不做。这是产品裁定，不是排期问题。**

Anthropic 的语料是大量独立文档，BM25 靠跨文档词频判断一个词有多特别。我们的检索限定在**一本书内**——一章里每个 chunk 都被塞进同样的章节关键词之后，这些词在该书内到处都是，区分度不升反降。移植过来的收益是未经验证的，而代价是一条今天工作正常的检索路径可能变差。

用户已明确不接受这个风险。**词汇检索的行为保持现状。** `book_chunks_fts.seg_text` 继续在阶段①从 `chunk.text` 生成，身份句不进 FTS。

后来者请勿把此节当作待办捡起。若将来要重开，前提是先有本地 A/B 数据证明它在单本书语料上确实为正，而不是引用 Anthropic 的数字。

## 测试

后端（`cargo test`）：

- `context_line` 为 NULL 时，embedding 输入等于 `text`（回归保护：默认行为不变）
- `context_line` 非空时，输入等于 `"{line} —— {text}"`
- 同一 chunk 在 `context_sha256` 变化后被重新纳入待办集合
- 换 embedding 模型不清空 `context_line`（失效矩阵第二行）
- 输出清洗：超长截断、引号剥离、空输出写入空串而非 NULL
- 空串 `context_line` 不会被待办查询反复捡起（`IS NULL` 而非 `= ''`）
- 分组顺序：待办列表按 `section_index` 连续，缓存前缀不被打断

前端（`npm run test:unit`）：

- 向量检索关闭时，身份句开关禁用
- 设置读写往返

## 分期

**第一期**：migration、阶段②、阶段③改造、设置项、i18n、测试。FTS 不动。

**第二期**：「重新生成本书身份句」的手动入口；进度条上区分三段的展示。（contextual BM25 已裁定不做，见上节。）

## Figma 设计提示

> 为一个桌面端阅读器的设置面板设计一个新的开关行，插入在既有的「向量检索」开关下方，作为其子项。
>
> 结构：标题 + 一行灰色说明 + 右侧开关。说明文字需要传达三件事——它使用用户配置的聊天模型而不是上方的 embedding 模型、它是一次性的、成本很低。有一个可展开的详情，展开后是两三句话，解释这项功能在做什么以及为什么它不会影响 AI 引用的原文。
>
> 需要覆盖的状态：
> 1. 默认（向量检索已开启，此项开启）
> 2. 此项关闭
> 3. 禁用（向量检索未开启）——整行降低对比度，说明文字替换为禁用理由
> 4. 正在处理某本书——行内出现细进度指示与「第 137 / 500 段」这类计数
> 5. 处理失败——不使用红色警告样式，因为这是可降级的增强而非错误；用中性色，附一个重试入口
>
> 视觉上沿用面板既有的行式布局：73px 行高、`justify-between`、1px 分隔线。作为子项应有清晰的从属感（缩进或左侧引导线），但不要做成嵌套卡片。
