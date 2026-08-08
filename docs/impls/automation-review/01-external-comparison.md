# 阶段 2 · 外部对照

对照对象限定在 Lantern 的**核心机制**，不是整个产品。八条机制，每条给：仓库/产品链接、star 与最近提交、它怎么解决同一个问题、我们好在哪、差在哪、是否重复造轮子。

Star 数与最近提交时间取自 GitHub API，抓取时间 **2026-08-08**。只列名字给不出对照结论的条目已删除。

---

## A. 整书检索：FTS5 + 定位句 + 向量 + RRF

**我们的实现**：`src-tauri/src/ai/grounding/`，约 11 600 行。`sqlite-vec` 钉在 `=0.1.6`，RRF 合并是手写的 30 行（`vector.rs:884`，`RRF_K = 60`）。

| 对照 | star / 最近提交 | 它怎么解决 |
|---|---|---|
| [Anthropic Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | 工程博客，非仓库 | 每个 chunk 先用 LLM 生成一段专属上下文，再去做嵌入和 BM25 索引。报告的检索失败率 5.7% → 2.9%，加 rerank 后 → 1.9% |
| [run-llama/llama_index](https://github.com/run-llama/llama_index) | ⭐51 457 / 2026-08-07 | 通用 RAG 框架，hybrid retrieval + RRF 是内置组件 |
| [neuml/txtai](https://github.com/neuml/txtai) | ⭐12 813 / 2026-08-04 | 同上，嵌入式定位，仍是 Python |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec) | ⭐7 989 / 2026-05-18 | 我们已经在用 |

**好在哪**：我们的「定位句」跟 Anthropic 那篇是同一个想法，而这个想法是被量化验证过的——我们没有走野路子。全流程在本地 SQLite 内，不需要额外进程或服务端。

**差在哪**：Anthropic 那条链路上最后一段收益最大的是 **rerank**（2.9% → 1.9%），我们没有这一层。llama_index/txtai 都是 Python，进不了 Tauri 的单机 Rust 二进制，用不上。

**是否重复造轮子**：**否**。RRF 那 30 行不值得为它引一个框架。

**要记的一笔**：`sqlite-vec` 我们钉死在 0.1.6，上游最近提交是 2026-05-18，已经三个月没动。这是个单点依赖，值得知道它的活跃度。

---

## B. 人物别名表

**我们的实现**：`src-tauri/src/ai/grounding/aliases.rs`，2 819 行。导入后台跑，AI 从全文生成别名→规范名映射，再给别名做嵌入。

| 对照 | star / 最近提交 | 它怎么解决 |
|---|---|---|
| [booknlp/booknlp](https://github.com/booknlp/booknlp) | ⭐927 / **2024-07-31** | 专为长篇小说做的 pipeline：人名识别、**代词指代消解**、角色聚类、引语说话人归属。学术出身（David Bamman） |
| [dbamman/litbank](https://github.com/dbamman/litbank) | ⭐381 / 2022-12-08 | 不是方案，是数据集：100 部小说的实体与 coreference 标注 |
| [Kindle X-Ray](https://en.wikipedia.org/wiki/X-Ray_(Amazon_Kindle)) | 商业产品 | People 标签页列全书人物、出现频次、出现页与摘录。Amazon 用「公开来源 + 机器学习 + 人工审核」生成，作者可在 KDP 后台手工增删改 |

**好在哪**：BookNLP 是离线批处理 Python，要下模型权重，装不进桌面应用；我们跑在用户机器上，且跟阅读进度、例句链接是打通的。Kindle X-Ray 只覆盖 Amazon 商店的书，用户自己导入的 EPUB 它管不着，我们对任意 EPUB 都能建。

**差在哪**：两条，都实在。

1. BookNLP 做**真正的代词消解**（「他」指谁），我们只做字符串别名映射 + 嵌入。代词这一层我们完全没有。
2. BookNLP 在 LitBank 上是有评测数字的；**我们的别名表准确率是零测量**。inventory 里记着「建错会误链例句里的人物」「只能重新导入重建」——两条都建立在我们不知道它错多少的前提上。Kindle 的做法是给人工修正兜底，一个「改这个人物名」的入口，我们没有。

**是否重复造轮子**：**否**（部署形态不同，且 BookNLP 事实上停更两年）。但**评测缺口是真的**，而 LitBank 就是现成的评测语料。

---

## C. 阅读范围截止点

**我们的实现**：`src-tauri/src/ai/grounding/spoiler.rs`，117 行。按当前 CFI 位置裁剪送进 AI 的上下文。

这一条需要重新认识：**我们以为是独门的东西，从 2025 年 12 月起是行业标配。**

| 对照 | 状态 | 它怎么解决 |
|---|---|---|
| [Kindle "Ask this Book"](https://blog.the-ebook-reader.com/2025/12/16/new-ask-this-book-ai-feature-added-to-kindle-ios-app/) | 2025-12-11 上线，iOS 美区，2026 年铺到 Android 与墨水屏 | 默认只回答到你读到的位置，顶部常驻一行「Answers are from your reading so far」，**并给了开关切到全书** |
| [BookPal](https://www.getbookpal.com/) | iOS，$9.99/月或 $59.99/年 | "Your AI never reads ahead of you"，外加 TV 式「前情提要」、拍照定位当前页 |
| [No Spoiler AI](https://nospoilerai.com/) | 商业产品 | 同一卖点 |

**好在哪**：我们的截止点是真实 CFI 位置，不是用户自报「我读到第几章」；对任意导入的 EPUB 都成立，不限于某个商店。

**差在哪**：Kindle 做了两件我们没做的事——**一行明示**（告诉你答案被裁剪过）和**一个开关**（让你自己决定要不要全书）。按 inventory，我们的截止点用户既看不见、也不知道它在裁什么。这个差距是文案加一个开关，不是工程量。

**是否重复造轮子**：**否**，实现路径不同。但要接受一个事实：**它已经不是差异化卖点，是及格线。**

---

## D. 词频分档难度评估

**我们的实现**：`book_difficulty.rs`，全文词形计数切成 band1–5 + band_unlisted，落 `041_book_difficulty.sql` / `057_book_difficulty_sections.sql`。

| 对照 | 状态 | 它怎么解决 |
|---|---|---|
| [Lextutor VocabProfile](https://www.lextutor.ca/vp/comp/) + Nation BNC/COCA 词表 | 应用语言学标准工具，2013 年整合进 Lextutor | 把文本按 k1/k2/k3… 频段切，算每档覆盖率。Nation 的 95% / 98% 覆盖率是这一行的公认理解阈值 |
| [LuteOrg/lute-v3](https://github.com/LuteOrg/lute-v3) | ⭐1 518 / 2026-07-24 | 开源 LingQ 同类：逐词已知状态（1–5 级 + known + ignored），难度是**相对于这个用户**的 |
| [LingQ](https://www.lingq.com/) | 商业产品 | 用「新词占已知词的百分比」当难度，公认舒适区 10–20% 未知词 |
| [textstat/textstat](https://github.com/textstat/textstat) | ⭐1 376 / 2026-02-18 | 只有 Flesch 一类句长/音节可读性公式，**跟词汇分档不是一回事，不适用** |

**好在哪**：本地零成本、零联网，导入即算，还做了分章节的难度山脊图——Lextutor 是网页贴文本的一次性工具，做不到这个。

**差在哪**：我们的五档**没有锚到任何公认词表**。结果是我们的「band3」跟任何人的 band3 都对不上，也没法借 Nation 的 98% 阈值去回答用户真正的问题——「这本书我现在能不能读」。LingQ/Lute 的角度我们也没有：它们的难度是相对用户的，我们的 band 分布是书的绝对属性，用户等级是另一条线事后拼上去的。

**是否重复造轮子**：**思路不是，实现是**。做法是应用语言学几十年的标准做法，词表本身是可以直接拿的公开资源。

---

## E. 掌握度累积 + 复习排程

**我们的实现**：调度器用 `rs-fsrs 1.2.1`（`Cargo.toml:` fsrs = { package = "rs-fsrs" }），**不是自研**。上层的 credit 累积（familiar=4 / mastered=8 / `CHAPTER_CREDIT_CAP=2.0`）是自研的。

| 对照 | star / 最近提交 | 说明 |
|---|---|---|
| [ankitects/anki](https://github.com/ankitects/anki) | ⭐29 607 / 2026-08-08 | FSRS 已是 Anki 内置默认调度器 |
| [open-spaced-repetition/fsrs4anki](https://github.com/open-spaced-repetition/fsrs4anki) | ⭐4 037 / 2026-07-28 | FSRS 参考实现与优化器 |
| [open-spaced-repetition/fsrs-rs](https://github.com/open-spaced-repetition/fsrs-rs) | ⭐406 / 2026-08-06 | **官方 Rust 主线**，带参数训练/优化 |
| [open-spaced-repetition/rs-fsrs](https://github.com/open-spaced-repetition/rs-fsrs) | ⭐48 / 2026-07-20 | **我们用的这个**，轻量调度器移植，不含优化器 |

**好在哪**：我们的 credit 来自**阅读中的被动曝光**（读到了、没查词 = 正面证据），Anki/FSRS 的输入是主动答题。这条路更接近 Duolingo 的 HLR 思路（见阶段 3 第 6 条），比 Anki 更贴合「读书顺带记词」的场景。

**差在哪**：两条。

1. 我们选的是生态里最小的那个包——rs-fsrs 48 星，官方主线 fsrs-rs 是 406 星。两个都在 open-spaced-repetition 组织下，差别是 fsrs-rs 带**参数优化器**：能用用户自己的复习日志重新拟合 FSRS 参数。我们现在用的是默认参数，且换不了。这需要确认当初是不是有意选择。
2. **「阅读曝光 → 记忆强度」这个映射是我们自己拍的数字，没有任何校准依据。** familiar=4、mastered=8、cap=2.0 从哪来的，没有出处。FSRS 那一半是有论文有数据的，我们喂给它的那一半不是。这是全表里证据最薄的一环。

**是否重复造轮子**：调度器**否**（用了库）。曝光→强度这一层，找不到成熟对照，见文末。

---

## F. 读者画像推断并注入 system prompt

**我们的实现**：`profile.rs`，7 个维度，30 天半衰期衰减，加权无放回抽样最多 5 条证据，`MIN_RECORDS=5` 门槛，`profile.rs:1414` 把 active 卡片拼进每条追问的 system prompt。

| 对照 | star / 最近提交 | 它怎么解决 |
|---|---|---|
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | ⭐62 813 / 2026-08-07 | 从对话抽取事实、去重、衰减，检索后注入 prompt |
| [letta-ai/letta](https://github.com/letta-ai/letta)（原 MemGPT） | ⭐24 152 / 2026-08-01 | 分层记忆，模型自己决定写入与召回 |

**好在哪**：mem0/Letta 的证据源是**对话文本**；我们的是**行为信号**（查词模式、追问难度、回复节奏），这两家都不做。我们还有 30 天半衰期 + 加权抽样 + 证据数门槛，比「抽到就写」保守得多。

**差在哪**：这两家都把「系统记住了什么」做成**用户可见可编辑的条目列表**。我们的画像卡片确实可见可删——但 `profile.rs:1414` 真正注入 system prompt 的那段拼接文本，用户看不到。卡片可见 ≠ 注入内容可见。它们同样没解决「画像本身推错了」，但至少注入了什么是可审计的。

**是否重复造轮子**：**否**（信号源不同）。但「注入内容不可见」这一条，成熟方案已经给出答案了：让它可见。

---

## G. 模型路由 / 静默降级 / 冷却

**我们的实现**：`src-tauri/src/ai/`，7 730 行。11 种错误分类、按 profile/凭证冷却、凭证与模型间静默 failover、400/422 时剥掉 reasoning effort 重试。底层只有 `reqwest`，没有用任何路由库。

| 对照 | star / 最近提交 | 它怎么解决 |
|---|---|---|
| [BerriAI/litellm](https://github.com/BerriAI/litellm) | ⭐55 874 / 2026-08-08 | Router 内置 fallbacks、cooldown、重试预算、按错误类型分流——就是我们手写的那一层。Python 代理进程 |
| [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | ⭐12 669 / 2026-05-25 | 同类，TypeScript / 边缘部署 |
| [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) | ⭐5 314 / **2024-08-10** | 按问题难度选强弱模型，跟我们的「按推理强度档位选模型」是同一问题——**但已停更两年** |

**好在哪**：全在进程内，不需要额外进程，密钥不出本机。LiteLLM 和 Portkey 都假设有个服务端在跑，这对桌面单机应用是硬约束，不是偏好问题。

**差在哪**：LiteLLM 的失败与降级是**有可观测面的**——日志、回调、成本记账都是一等公民。我们这一层按 inventory 是**全静默**的：11 种错误分类、冷却窗口、跨凭证切换，用户一概看不到，也就无从知道「为什么今天回答质量不一样」。

**是否重复造轮子**：**否**，部署形态是硬约束。但可观测面是白送的对照答案。

---

## H. 同步冲突的 LWW 裁决

**我们的实现**：`src-tauri/src/sync/merge.rs`，`(updated_at, updated_by_device)` 元组比较，同一模式在文件里重复出现 10 次以上。

| 对照 | star / 最近提交 | 它怎么解决 |
|---|---|---|
| [vlcn-io/cr-sqlite](https://github.com/vlcn-io/cr-sqlite) | ⭐3 753 / 2026-08-04 | **把 SQLite 表直接变成 CRDT**：行级 LWW + 因果一致，以扩展形式加载。技术栈跟我们几乎完全重合 |
| [automerge/automerge](https://github.com/automerge/automerge) | ⭐6 476 / 2026-08-06 | 文档 CRDT，适合富文本共编，不适合关系表 |
| [yjs/yjs](https://github.com/yjs/yjs) | ⭐22 319 / 2026-08-06 | 同上 |
| [electric-sql/electric](https://github.com/electric-sql/electric) | ⭐10 303 / 2026-08-05 | 要服务端 |
| [powersync-ja/powersync-service](https://github.com/powersync-ja/powersync-service) | ⭐371 / 2026-08-07 | 要服务端 |

**好在哪**：走 iCloud 文件容器，零服务端零账号。ElectricSQL/PowerSync 的形态直接不符。cr-sqlite 也不强制服务端，但要求你按它的方式建表。

**差在哪**：手写的元组比较散在 merge.rs 十几处，**已经出现不一致**——inventory 抓到 `merge.rs:1392`（book.summary.upsert）用的是严格 `<` 且没有 device 平局项，跟其他所有地方的写法不同，同毫秒写入结果不确定。cr-sqlite 把这类判断统一在一处。

**是否重复造轮子**：**这是八条里最像的一处**，而且已经有了不一致的 bug 面。不建议现在替换（迁移成本高，且我们不做兼容层），但**新表应当只走一个统一的 merge helper**，而不是再抄一遍元组比较。

---

## 找不到成熟对照的

两块，明说：**没有现成方案。**

1. **AI 清洗过的书名/作者要不要给用户核对。** Kindle X-Ray 有人工审核和作者编辑入口，但那是出版侧不是读者侧；Calibre 系的元数据插件是「从网上抓正确值」，不是「AI 清洗脏文件名再让读者确认」。样张里那套（来源徽章 + 核对条 + 退回原始信息）没有可抄的对象。

2. **把阅读中的被动曝光当作记忆证据，接进 FSRS 式的强度模型。** LingQ 和 Lute 有「读过 = 已知」的粗糙版本（逐词状态手动或自动升级），但都没有把曝光量化成记忆强度输入。Duolingo 的 HLR 从答题日志回归半衰期，输入仍是主动答题。这一环没有对照，也就意味着 familiar=4 / mastered=8 / cap=2.0 这组数字，既没人验证过，也没人替我们验证。
