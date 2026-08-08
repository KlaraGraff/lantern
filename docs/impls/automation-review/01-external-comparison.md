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

> **经实测修正（2026-08-08）。** 上面第 2 条「我们的别名表准确率是零测量」已不再成立——现在测过了。见
> [`03-test-results.md`](03-test-results.md) 条目 1，原始证据
> `evidence/item-1-aliases-raw.md`。
>
> 生产库唯一一张有内容的别名表（*Embracing Hope*，25 条）逐条对全书 198 chunks 判定：
> **正确率 80%**（20/25），**并且存在一例可触发的人物合并**——`Vesely` 与 `Vesely-Frankl` 两条
> 都指向 Alexander Vesely-Frankl，但书里 chunk 76 出现的是**另一个人 Franz Vesely-Frankl**；
> 按 `resolve()` 的最长优先扫描，读者问 Franz 会拿到 Alexander 的材料。另有 `Joel`/`Joel Young`
> → `Young` 两条指向书中不存在的人（真名是译者 Joelle Young），且规范名被切成裸姓 `Young`，
> 与普通形容词 young 撞形。
>
> 所以本节原文写的「inventory 里记着『建错会误链例句里的人物』……建立在我们不知道它错多少的前提上」
> 这句要改：我们现在知道它错多少了，而且**误链是已经存在的事实，不是潜在风险**。
> 「Kindle 给人工修正兜底，我们没有」这半句不变——`add_person_alias` 存在于后端，
> 但没有 UI 入口。

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

> **经实测修正（2026-08-08）。** 上面「差在哪」整段是错的，不需要跑测，核对代码即可推翻。
>
> Kindle 那两件事我们都已经做了，而且做得更多。逐个核到渲染处：
>
> - **提示行**：`src/components/MessageBubble.tsx:298-317`。闸门生效过的那条回答下面挂
>   `ai.spoilerGuard.notice`（「已按你的阅读进度回答（前 {{progress}}%）」），
>   未触发全书意图时退化成一个带 hover 说明的角标。
> - **单条重试为全书**：同处 `:308`，`ai.spoilerGuard.retryWholeBook`。Kindle 没有这一层。
> - **每本书的开关**：`src/components/AiPanel.tsx:384-389`，`ai.spoilerGuard.bookOn`/`bookOff`。
> - **全局开关**：`src/components/settings/AiSettings.tsx:896-902`。
>
> 原文说「我们的截止点用户既看不见、也不知道它在裁什么」——看得见，而且能当场翻掉。
>
> 这条判定当初是照着 inventory 的风险栏写的，没有回去核前端。差距不存在，
> 「文案加一个开关」这项工作也不存在。

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

> **经实测修正（2026-08-08）。** 「差在哪」里并列的两项后果，实测下来一项推翻、一项证实——
> 而且证实的那项比原文说的更严重。见
> [`03-test-results.md`](03-test-results.md) 条目 5，原始证据
> `evidence/item-5-difficulty-bands-raw.md`（用真实 `tokenize`/`count_words`/`lookup_with` 驱动六本书）。
>
> **推翻的一项：「band3 跟任何人的 band3 都对不上」暗示的区分力缺失。** 区分力是有的。
> 难词占比（band4+5+unlisted / 不同词数）在六本书上是
> Alice 31.94% < 小王子 33.45% < 汤姆·索亚 55.08% < 傲慢与偏见 56.10% <
> 物种起源 63.75% < 白鲸 75.72%，**跨度 2.37 倍，公认梯度上单调不降**。
> 对不上别人的 band 编号是真的，但这套档位自己能排出难度。
>
> **证实且加重的一项：借不了 Nation 的 98% 阈值。** 这半句成立，原因比「没锚到词表」更具体。
> 五档累计覆盖率在这六本书之间只有 **94.92%–98.12% 三个百分点**，而且**完全不排序**：
> 最简单的小王子 98.12%，最难的白鲸 95.94%，中间的汤姆·索亚 94.92% 反而最低。
> Nation 的 98% 判断读的正是覆盖率这个数，而它在这套分档下不携带难度信息。
> 根因是表只有 49,999 词、第五档边界在排名 20,000，难度差被赶进了表外的 unlisted
> （白鲸 18.50% vs 小王子 5.80%），而覆盖率只算表内。

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

> **经实测修正（2026-08-08）。** 「差在哪」的第 1 条已经过期，本节表格里标「我们用的这个」
> 的那一行也不再是事实。不需要跑测，是这份文档写完当天就被改掉了。
>
> `Cargo.toml:79` 现在是官方主线 `fsrs = "6.6.1"`，不是 `rs-fsrs 1.2.1`。原文说
> 「我们现在用的是默认参数，且换不了」——`ComputeParametersInput` 已经在依赖里，
> 用 `vocab_review_log` 重新拟合这位读者的参数是可做的了（还没做，但不再被依赖挡着）。
> 换包时保持 `DESIRED_RETENTION = 0.9` 与 rs-fsrs 的隐含默认一致，既有卡片的排程没有被动过。
> 一个新增的代价：官方 crate 只做长期排程，没有 learning steps，所以不足一天的那一步
> 现在由 `commands/vocab.rs` 的 `RELEARN_STEP_MS` 自己供给。
>
> 第 2 条（familiar=4 / mastered=8 / cap=2.0 无校准依据）**不受影响，仍然成立**，
> 而且它本来就是这一节里证据最薄的一环。

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

> **经实测修正（2026-08-08）。** 结论站得住，两处细节要改，根因要重写。见
> [`03-test-results.md`](03-test-results.md) 条目 3，
> 原始证据 `evidence/item-3-lww-raw.md`（37 处谓词全量普查 + 用真实 `merge::apply_event` 驱动的收敛测试）。
>
> **站得住的：** 「唯一不一致」成立——37 处谓词里 tuple 6、longhand 18（与 tuple 等价）、
> other 8，**upsert 里的裸比较恰好 1 处**。「同毫秒写入结果不确定」也复现了：
> 两台设备同毫秒写同一本书的摘要，A→B 与 B→A **3/3 得到不同的最终行**，先到者通吃，
> 与设备 ID 无关；tuple 的对照表（`custom_fonts`）全部收敛，说明发散不是测法造成的。
>
> **要改的细节：** 行号是 **`merge.rs:1461`**（语句体 1452-1461），不是 1392。
> 另有 4 处只比 `updated_at` 的谓词，但都是 `DELETE … WHERE updated_at <= ?` 的墓碑删除，
> 形状与 upsert 不同，且实测都收敛（其中 `book_settings`/`settings` 的收敛是 SET 侧墓碑闸门
> 的巧合，不是设计出来的）。
>
> **根因要重写。** 原文说它「用的是严格 `<` 且没有 device 平局项」，读起来像谓词写漏了。
> 实际是 **`book_summaries` 整张表没有 `updated_by_device` 列**——`migrations/023_ai_grounding.sql`
> 里没有，`events.rs` 的 `BookSummaryPayload` 里也没有。不是忘了比，是没有列可比。
> 改谓词修不了它：得先加列、让写入端填、再让事件负载带上它。这把「统一 merge helper」
> 从一次重构变成了一次带迁移的改动。
>
> **再修一次（2026-08-09）：「恰好 1 处」这句要撤回。** 上面那次 37 处普查只扫了
> `merge.rs`——因为原文给的坐标是 `merge.rs:1461`，我拿行号当了范围。
> `book_summaries` 的 upsert 其实有**两份**：事件回放路径 `merge.rs:1461`，
> 全量快照路径 `snapshot/apply.rs:1107`，**两处都是裸 `<`**。
> 我的收敛实测只驱动了事件路径，快照路径一次都没跑过——它的裸谓词是看代码形状推出来的，
> 不是测出来的。所以准确的说法是「**我测到的那一处是裸的，另有一处同样裸、我没测**」，
> 判定下调为样本不足。方法教训：**上游给行号时，要扫的是那个行为，不是那个文件。**
> 修复已同时覆盖两条路径（`063_book_summary_device.sql` + 两处谓词 + 负载/快照行带列）。

---

## 找不到成熟对照的

两块，明说：**没有现成方案。**

1. **AI 清洗过的书名/作者要不要给用户核对。** Kindle X-Ray 有人工审核和作者编辑入口，但那是出版侧不是读者侧；Calibre 系的元数据插件是「从网上抓正确值」，不是「AI 清洗脏文件名再让读者确认」。样张里那套（来源徽章 + 核对条 + 退回原始信息）没有可抄的对象。

2. **把阅读中的被动曝光当作记忆证据，接进 FSRS 式的强度模型。** LingQ 和 Lute 有「读过 = 已知」的粗糙版本（逐词状态手动或自动升级），但都没有把曝光量化成记忆强度输入。Duolingo 的 HLR 从答题日志回归半衰期，输入仍是主动答题。这一环没有对照，也就意味着 familiar=4 / mastered=8 / cap=2.0 这组数字，既没人验证过，也没人替我们验证。
