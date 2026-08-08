# 真句锚定 — 让 EPUB 也能跳到那一句

配套样张：`docs/impls/user-profile-quotes-mockup.html`
规格来源：`docs/impls/user-profile-mockup.html` 附录甲「真句检索（第三步）」

## 为什么

真句检索（`ai/grounding/quotes.rs`）会从读者已读过的书里捞出几句原句，喂给词义类追问的提示词。附录甲要求这些句子在前端「渲染成可点击跳转」。跳转需要知道句子在书里的确切位置——而检索这一端拿不到：

```rust
/// Only ever `Some` for `render_format == "text"` — EPUB and PDF chunks
/// carry no character offset at all in `book_chunks`
pub chunk_char_start: Option<i64>,          // quotes.rs:138
```

原因写在同一段注释里：`extract::normalize_whitespace` 折叠了块内空白，`chunk::draft` 又用 `"\n"` 把相邻块拼起来，`book_chunks.text` 里的字符位置和源文件里的位置早就不是线性对应了。EPUB 的 chunk 索引里干脆连 `char_start` 都不写。

于是 EPUB——最常见的格式——只能落到 `section_href` 指的章节开头。这不可接受。

### 现状其实比看上去好一点

本书内的 `[S1]` 引文跳转（`Reader.tsx:1080 navigateToSource`）走的是 `view.search({query, index})`。追进 foliate 的 `search.js` 会发现，默认选项落到 `segmenterSearch`：用 `Intl.Segmenter` 逐字素切分、`Intl.Collator` 以 `sensitivity: 'base'` 比较。也就是说**空白差异、大小写、变音符号都已经能吃掉**。

它的剩余弱点只有一个：归一化之后仍然要求**逐字符相等**。差一个字符就整句失配。而 EPUB 渲染出的 DOM 与 Rust 抽出的纯文本，差一个字符太容易了：

| 差异来源 | 例子 |
|---|---|
| 脚注角标 | DOM 里 `<sup>3</sup>` 贡献一个 `"3"`，抽取时被丢掉 |
| 块边界 | `</p><p>` 之间 DOM 无空白，chunk 文本里是 `"\n"`（归一化成空格） |
| 排版字符 | 软连字符 `&shy;`、`&nbsp;`、`—` vs `--`、弯引号 vs 直引号 |
| ruby / 注音 | `<rt>` 的内容进了文本流，没进索引 |

**所以要做的不是换一套定位机制，是在现有精确匹配后面补一级模糊匹配。**

## 为什么不是 CFI

CFI 是 EPUB 官方的定位标准，直觉上最"对"。三条理由否掉它：

**一、索引在 Rust 里做，那边没有 DOM。** 要生成 CFI 就得在 Rust 里重新解析 XHTML，且解析出的节点树必须与 foliate-js 的 `createDocument()` 逐节点一致——差一个空白文本节点，CFI 就指到别处。Rust 生态没有成熟的 CFI 生成器；`fread-ink/epub-cfi-resolver`、`marcuswu/EPUBCFI` 都是 JS，而且都只做解析与解析后定位，不解决「从纯文本反推位置」。

**二、CFI 一换文件就废。** 读者重新下载、换一版 EPUB，全部 CFI 失效。文本引语不会。

**三、这不是 Lantern 的第一次面对这个问题，而上一次的答案恰好相反。** 书签存 `cfi`、划线存 `cfi_range`（`001_init.sql:25,45`）——它们**就该**存 CFI，因为那是读者在页面上亲手划出来的，创建那一刻 DOM 就在眼前，位置精确已知。真句检索正相反：句子是没有 DOM 的情况下从纯文本切出来的，位置从来就不精确。

> **有 DOM 的时候用 CFI，没 DOM 的时候用文本引语。** 两种情况两种工具。

Readium 自己在 [readium/annotations#2](https://github.com/readium/annotations/discussions/2) 的讨论里也承认 CFI 在各家阅读器中实现稀疏、不一致。Hypothesis 当年为了给 EPUB 做批注，走的就是文本引语这条路。

## 方案

采用 W3C Web Annotation 的选择器模型：**TextQuoteSelector（exact + prefix + suffix）+ 近似匹配**。

### 依赖

`approx-string-match`（[robertknight/approx-string-match-js](https://github.com/robertknight/approx-string-match-js)）

| | |
|---|---|
| 许可 | MIT |
| 运行时依赖 | 无 |
| 解包体积 | 19.5 KB |
| 算法 | Myers 位并行近似匹配，期望复杂度 `O((maxErrors / 32) × text.length)` |
| 用量背书 | Hypothesis 客户端的锚定核心 |

**打分逻辑自己写，不抄。** Hypothesis 的 `match-quote.ts` 是很好的参考（本方案的权重设计来自它），但 `hypothesis/client` 的许可 GitHub 标为 NOASSERTION，直接搬 200 行会带来不必要的许可纠缠。我们在 MIT 的匹配库上写自己的 ~80 行打分器，注释里注明思路来源。

### 三级降级链

```
① 精确匹配   view.search({query, index})        ← 现有实现，不动
      ↓ 未命中
② 模糊匹配   anchorQuote(doc, {exact, prefix, suffix})
      ↓ 分数低于阈值
③ 章节开头   view.goTo(section_href) + 顶部提示条
```

第 ① 级保留是因为它便宜且必对；第 ② 级只在第 ① 级落空时才跑。第 ③ 级就是样张 B2。

### 打分

在章节纯文本里找编辑距离最小的若干候选，逐个打分：

| 项 | 权重 | 含义 |
|---|---|---|
| quote | 50 | 匹配段与目标句的相似度 |
| prefix | 20 | 匹配段之前的文本与记录的前文的相似度 |
| suffix | 20 | 匹配段之后的文本与记录的后文的相似度 |
| position | 2 | 与期望位置的接近程度，仅用于平局时决胜 |

归一化到 0–1，低于阈值（初值 `0.5`，按实测调）判为未命中，落 ③。

前后文是压制**锚错**的关键——同一章里同一个句子模式出现两次时，靠前后文区分。

## 数据流

```
Rust: quotes.rs
  sentences_containing() → (prefix, exact, suffix)     ← 三者都从同一个 chunk.text 里切
      ↓
  QuoteCandidate { book_id, book_title, section_index, section_href,
                   text, prefix, suffix, chunk_char_start }
      ↓
Rust: chat.rs
  ├─ 提示词数据块（只含 book_title + text，前后文不给模型看）
  └─ AiChatResult.quotes: Vec<QuotedSource>            ← 与现有 sources 并列
      ↓
前端: useAiChat.ts → MessageBubble
  [Q1] → lantern-quote:Q1 → CitationChip（写书名）
      ↓ 点击
前端: quoteAnchoring.ts
  同书 → anchorQuote() → CFI → flashNavigationTarget()
  异书 → 记跨书返回 → 打开那本书 → anchorQuote() → 同上
```

**关键点：不用改表、不用重建索引。** prefix/suffix 已经在 `book_chunks.text` 里——句子本来就是 `sentence_split(chunk_text)` 切出来的（`quotes.rs:471`），前后句就在手边。

**前后文不进提示词。** 模型只需要句子本身和它出自哪本书；前后文是给锚定用的，进提示词只会白烧 token 并稀释重点。

## 改动清单

### 第一阶段 · Rust

| 文件 | 改动 |
|---|---|
| `ai/grounding/quotes.rs` | `sentences_containing` 返回 `SentenceHit { text, prefix, suffix }`；`QuoteCandidate` 加 `prefix` / `suffix` 两个字段 |
| `commands/ai/chat.rs` | `ai_chat` 增参 `focus_word: Option<String>`；有值时调 `quotes::find_quotes`，句子写进 `system_content.variable` 的数据块，同时产出 `Vec<QuotedSource>` |
| `commands/ai/chat.rs` | `AiChatResult` 加 `quotes: Vec<QuotedSource>` |
| `commands/profile.rs` | （已在工作区）`injection_block` 接进 `build_chat_system_content` 的 `stable` 半段，位置在 `ANSWER_DISCIPLINE` / `MARKUP_GUIDE` **之前** |

前后文各取多少：先定 **32 字符**，取到句子边界为止，不足则取到 chunk 边界。太短区分度不够，太长会把 diff 成本抬上去。

### 第二阶段 · 前端锚定

| 文件 | 改动 |
|---|---|
| `package.json` | 加 `approx-string-match` |
| `public/foliate-js/lantern-modules.js` | 桥接导出 `textWalker`（现已导出 `FootnoteHandler`、`epubcfi`） |
| `src/pages/reader/matchQuote.ts` | 新增。近似搜索 + 四项打分，纯函数，好测 |
| `src/pages/reader/quoteAnchoring.ts` | 新增。`anchorQuote(doc, selector)`：`textWalker` 拿 `strs` + `makeRange` → 拼串 → `matchQuote` → 偏移映射回 Range |
| `src/pages/Reader.tsx` | `navigateToSource` 在精确搜索落空后接第 ② 级；`[S1]` 与 `[Q1]` 共用 |

`textWalker(doc, func)` 给的正是需要的接口：`strs`（各文本节点字符串数组）与 `makeRange(startIndex, startOffset, endIndex, endOffset)`（`text-walker.js:30`）。拼成一整串跑匹配，全局偏移再映射回 `(节点下标, 节点内偏移)`，`view.getCFI(index, range)` 出 CFI。

**顺带修好 `[S1]`。** 本书内引文跳转今天是同一套精确匹配、同样的脆弱点。第 ② 级接在 `navigateToSource` 里，两个功能一起变准。

### 第三阶段 · 前端界面

| 文件 | 改动 |
|---|---|
| `src/components/citation-markers.ts` | 增加 `lantern-quote:` 方案与 `[Q1]` 重写，与 `[S1]` 并行不混用 |
| `src/components/ai-markdown/CitationChip.ts` | 增加书名变体（样张 A1 的 `.chip.book`） |
| `src/components/MessageBubble.tsx` | 「例句」行，与「来源」行分开两行 |
| `src/pages/reader/crossBookJump.ts` | 新增。单条跨书返回记录，模块级存储 |
| `src/pages/Reader.tsx` | 跨书跳转、顶部提示条（B2）、文件不可用提示（B4） |
| `src/i18n/{zh,en}.json` | 新键，zh/en 独立取词 |
| `src/hooks/useAiChat.ts` | 透传 `focusWord`；接住 `quotes` 元数据 |
| `ExplainPopover.tsx` / `TranslationPopover.tsx` / `Reader.tsx` | 把被查的词沿 `onAskFollowUp` 送到后端 |

**跨书返回为什么要单独存。** 现有跳转历史栈按书重置：

```ts
// useJumpHistory.ts:114 — 换书就清空
useEffect(() => { stackRef.current = []; ... }, [bookId]);
```

上一本书的 CFI 在这本书里解析不了，清空是对的。跨书返回需要另存一条 `{ bookId, location, bookTitle }`，落地后渲染成胶囊，胶囊上写**书名**而不是章节名。淡出规则（翻 3 页）、点击返回、不弹确认，全部沿用现有实现。

## 失败行为

| 情况 | 行为 |
|---|---|
| 模糊匹配分数不足 | 落章节开头 + 顶部提示条；链接**不变灰、不禁用** |
| 目标书文件缺失 / iCloud 占位 | 停在原地出短提示，不跳走、不清当前阅读位置 |
| 目标书已删除 | 检索层已过滤，走不到这里 |
| PDF | 翻到那一节，不做句级高亮（PDF 的文本层没有稳定的节点结构） |
| 检索有结果但模型没引 | 界面上什么都不显示，**不提示「已检索 N 句未采用」** |

## 性能

匹配**限定在单个章节**内跑——`section_href` 已知，不需要全书扫描。Hypothesis 已知的卡顿问题（[hypothesis/client#3919](https://github.com/hypothesis/client/issues/3919)）出在整篇长文档上搜短引语；我们的引语是完整句子（长 → `maxErrors` 相对小 → 候选少），搜索域是一章（几万字符量级）。预期几十毫秒，且只在点击那一刻发生，不在渲染路径上。

`maxErrors` 取 `min(256, quote.length / 2)`，与 Hypothesis 同。

## 不做什么

- **不生成、不存储 CFI。** 见上。
- **不改 `book_chunks` 表、不重建索引。** prefix/suffix 从 chunk 文本现切。
- **不做全书搜索兜底。** 匹配失败就落章节，不去别的章节碰运气——锚错比锚不上更糟。
- **不把锚定结果缓存。** 点击是低频操作，缓存的失效逻辑比它省下的时间贵。
- **不动 `[S1]` 的现有精确匹配。** 只在它落空后接一级。

## 一个要记在账上的长期限制

文本引语**不是标识符**。它能回答「这句话在书里哪儿」，不能当主键用。如果将来要把「书里的某一句」存下来当锚（比如复习卡片指向某句原文、跨设备同步某句的批注），文本引语不够，那时需要真正的位置。现在不需要，但这是唯一会让这个决定需要重来的场景。

## 验收

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cargo test --lib commands::profile::
cargo test --lib ai::grounding::quotes::
cargo clippy --lib --tests -- -D warnings
npx tsc --noEmit          # 只应剩 SettingsModal.tsx 的既有报错
npm run test:unit
```

新增测试：

- Rust：`injection_block` 的注入顺序与空态；`sentences_containing` 的前后文切分（句首、句尾、chunk 边界）
- TS：`matchQuote` 的打分（精确命中 / 一处错字 / 两处相同句靠前后文区分 / 分数不足）
- TS：`profile-injection.test.ts` —— 七个维度名与 `src/i18n/{zh,en}.json` 对齐
