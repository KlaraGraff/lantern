# 11 — 查词卡读得到生词本

对应 issue [#11](https://github.com/KlaraGraff/lantern/issues/11)。上下文平权的**内侧半边**：[MCP 改造](archive/mcp-scope-goal.md)把阅读数据交给了外部客户端，但内置 AI 自己一直没拿到生词本和学习状态。29 工具版上线后，Claude Code 连上 MCP 能说「这个词你上周查过」，而应用内那个本该「最懂你」的 AI 在这条轴上比一个普通聊天窗口知道得还少。

本计划只做**一刀**：查词时把**这个词自身的记录**注入 prompt。整章生词状态注入、设置开关不在范围内（理由见 issue 正文的「范围」一节）。

## 代码调研的四个结论

实现路径和 issue 里写的落点有出入，四条都来自读代码，按影响排序。

| 发现 | 后果 |
| --- | --- |
| `ai_lookup` 的参数里**没有 `book_id`**（`src-tauri/src/commands/ai.rs:1521`，前端 `LookupPopover.tsx:92` 也没传） | 按**跨书**查。语义上这反而是对的：掌握状态是人的属性，不是书的属性——同一个词在 A 书标了已掌握，在 B 书遇到时它依然是已掌握。避免了给命令加参数、改前端调用 |
| `translation_prefix` 带一条机器契约：**第一行必须恰好是 `LOOKUP_TRANSLATION_MARKER`**（`ai.rs:655`） | 注入块**不能**做成前缀。任何「开头先说明……」的指令都会和这条契约打架，而这条是前端解析用的，坏了就是翻译栏空白。改为像 `book_reference_block`（`ai.rs:1819`）那样**追加在系统提示词末尾** |
| `lookup_records` 的唯一键是 `(book_id, cfi, normalized_text)`（`migrations/014_lookup_history.sql`） | 同一个词在不同位置查是**不同的行**。必须跨行 `SUM(lookup_count)`，读单行的 `lookup_count` 只能看到「在这个位置查了几次」 |
| 查词气泡**没有缓存旁路**——`get_cached_lookup` 只有学习卡在用（`LearningCardController.tsx:231`），`LookupPopover` 每次都真发请求，结束后 `save_lookup_record` | 「同一个词查第五次」确实每次都会走到这段新代码，不会被缓存挡掉。功能有真实触发面 |

## 实现

### 1. 取数：一个纯函数 + 两条 SQL

新增 `lookup_memory_block`，放在 `book_reference_block` 旁边（`src-tauri/src/commands/ai.rs`）：

```rust
pub(crate) fn lookup_memory_block(
    conn: &rusqlite::Connection,
    word: &str,
    now_ms: i64,
) -> Option<String>
```

`now_ms` 走参数而不是内部取时钟，纯粹为了单测能断言「12 天前」。调用方传 `chrono::Utc::now().timestamp_millis()`（仓库既有写法，见 `db.rs:835`）。

词形归一化用 `crate::sync::events::normalize_learning_term` —— `lookup_history.rs:119` 里那个私有 `normalize` 是同一份实现，取的是既有的规范形式，不新造一套。

**查询历史**（一条语句拿齐三个值）：

```sql
SELECT SUM(lookup_count),
       MAX(last_looked_up_at),
       (SELECT definition FROM lookup_records
         WHERE normalized_text = ?1 AND definition <> ''
         ORDER BY last_looked_up_at DESC LIMIT 1)
FROM lookup_records
WHERE normalized_text = ?1
```

无记录时 `SUM` 为 `NULL`，直接当作没查过。

**生词本状态**：

```sql
SELECT mastery, review_count
FROM vocab_words
WHERE word = ?1 COLLATE NOCASE
ORDER BY CASE mastery WHEN 'mastered' THEN 0 WHEN 'learning' THEN 1 ELSE 2 END,
         updated_at DESC
LIMIT 1
```

排序不是随手写的：一个词可能在多本书里各有一行、状态不同（一本里手动标了已掌握，另一本查词时自动落了一行 `new`）。**取最靠前的状态**——用户已经证明认识这个词，另一本书里的自动新建行不该把它降回生词。

两条都没有命中时返回 `None`，不追加任何东西，行为与今天完全一致。

### 2. 接线

在 `ai_lookup` 已有的那个 `db.reader()` 块里顺带查掉（和读 settings 共用一次连接获取），再在 `book_reference_block` 追加处的旁边追加：

```rust
if let Some(memory) = memory_block {
    system_prompt.push_str("\n\n");
    system_prompt.push_str(&memory);
}
```

`lookup_system_prompt` 本身**一行不改**，它的 4 个既有单测（`ai.rs:3519` 起）不受影响。

### 3. 注入什么

数据一行 JSON（沿用 `book_reference_block` 的格式），后面跟使用规则：

```
The following is the user's own record for this word in Lantern:
{"looked_up_times":4,"days_since_last_lookup":12,"previous_definition":"…","mastery":"learning","reviews":3}

Answer as a repeat encounter, not a first one — and keep the answer shorter, not longer:
- Do not re-teach what `previous_definition` already covered. If this passage uses that same sense, confirm it in a few words and spend the rest on what this occurrence adds.
- If this passage uses a different sense, lead with the contrast against `previous_definition`.
- If `mastery` is "mastered", treat the word as known: skip the basic gloss even when the configured CEFR level would call for simpler language. The recorded state beats the level estimate.
- Refer to the earlier lookup only when it carries information (a sense contrast). Never state counts or dates, never open with an acknowledgement, and never praise the user for reviewing.
```

第三条就是 issue 里定死的那条规则：**具体记录压过粗粒度估计**。等级是 B1、这个 C1 词已标为已掌握，就别再按 B1 解释它。

`previous_definition` 用既有的 `truncate_utf8` 截断到 200 字节——查词卡的释义本来就短，超长的是异常数据，不该把它整段搬进下一次请求。

## 成本

| 项 | 数 |
| --- | --- |
| 数据行 | ~30 token |
| 规则段 | ~80 token |
| 合计（仅在有记录时追加） | **~110 token / 次** |

比 issue 里估的「几十 token」高一档，因为规则段才是大头，数据本身很小。仍然与生词本总量无关——上千词也是这个数。

数据库侧：两条语句都在 `db.reader()` 上，与命令里已有的 settings 读取同一个连接。`lookup_records.normalized_text` 上**没有**独立索引（唯一索引以 `book_id` 打头，用不上），所以这是一次全表扫描；几千行量级下是微秒级，且历史本身有保留期裁剪。**加索引的触发条件**：单机 `lookup_records` 上到十万行量级，或查词首字延迟出现可测量的回归——在那之前不加。

`max_tokens` 维持现状（`definition` 128 / `context` 192 / `full` 256）。规则明写「更短不是更长」就是为了守住这个上限；如果实测出现截断，先调规则措辞，不要先抬上限。

## 测试

`lookup_memory_block` 是纯函数（连接 + 词 + 时钟），在 `ai.rs` 既有的 `#[cfg(test)]` 里建内存库直接测：

- 无任何记录 → `None`，系统提示词与今天逐字相同
- 只有查询历史 / 只有生词本行 / 两者都有 → 各自出现且只出现对应字段
- 同词跨两本书、`mastered` 与 `new` 并存 → 取 `mastered`
- 同词在同一本书的三个位置各一行 → `looked_up_times` 是三行之和，不是任一行的 `lookup_count`
- 词带标点（`"Resign,"`）→ 归一化后仍命中记录
- 超长 `previous_definition` → 按 UTF-8 边界截断，不产生半个字符

再加一条 `ai_lookup` 层面的断言：追加了记忆块之后，`LOOKUP_TRANSLATION_MARKER` 那条「第一行必须是……」的指令**仍然在系统提示词的最前面**。这是上面第二条调研结论的回归保护。

## 不做

- **书内对话注入整章生词状态**——要算「当前章节 ∩ 生词本」、要定 token 预算、还会和检索排序互相影响。等这一刀用一阵子再判断。
- **设置开关**——注入的是用户自己在本应用里记下的数据，喂给本应用自己的 AI，讲的还是刚点的那个词。不是新的数据外流边界，不该为它先立开关。
- **UI 改动**——没有，所以本计划没有 Figma 提示词。用户看到的差别全在回答内容里。
