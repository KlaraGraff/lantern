# 自动判断与 AI 分析清点（跑 1）

只清点，不评判，不改代码。范围：`src/hooks`、`src/components`、`src/pages`、`src-tauri/src/ai`、`src-tauri/src/commands`、`src-tauri/src/sync`、`src-tauri/src/mcp`、`src-tauri/migrations`。

**纳入标准**：非用户为这一次操作亲手点下的 AI 调用；自动选模型/推理强度/供应商/路由；静默重试、降级、回退、截断；根据历史行为调整；分类打分排序过滤的阈值；算出来而不是写死的默认值；自己触发的后台/定时/防抖任务；替用户在两个值之间裁决。用户显式点击的 AI 调用也收录，触发条件标为「用户显式点击」，用于看清全部 AI 面。

**统计**：164 条，分 10 组。原先标为「存疑」的边缘条目已全部收编，口径记在文末「边缘条目口径」一节。

扫描方式：8 个只读子代理分区扫描（sonnet / low），主会话合并去重。重复条目已合并，合并处在组末注明。

---

## 1. 自动触发的 AI 生成（无人按按钮）

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/ai/grounding/index.rs:591 | 导入或装订完成后自动排队 | book_id | 编排整条索引流水线并依次推进四阶段：FTS→定位句→embedding→别名表→别名向量 | 部分，索引进度条 | 能，IndexManagerModal 可重建 | 某阶段悄悄没跑完，后续检索长期降级 | 见各阶段行，累计数千 tokens | 每次导入或重建 |
| src-tauri/src/ai/grounding/index.rs:428 | 每次需要用到索引时 | current_source_sha256 vs ready_source_sha256 | 判定索引是否过期，决定静默重建还是沿用旧索引 | 否，无 UI | 能，force_reindex | 拿过期索引答题，或无谓重跑全流水线 | 本地比对，~0；触发重建则见上行 | 每次 ensure_index |
| src-tauri/src/ai/grounding/aliases.rs:97 | 装订完成后自动触发 | 书名摘要+章节概要 | 生成人物别名表 canonical/alias 映射 | 部分，IndexManagerModal 可查看 | 能，可编辑删除别名 | 别名错则检索用错词扩展查询 | 1 次调用，~2000 tokens，数秒 | 一次性，导入时 |
| src-tauri/src/ai/grounding/context.rs:33 | 索引构建阶段②，每书一次 | 章节全文+目标 chunk | 为每 chunk 生成定位句作检索前缀 | 否，纯内部 | 否，只能重建索引 | 定位句错则该 chunk 难被检索到 | 每 chunk 一次小模型调用，数百 tokens | 每次索引重建，逐 chunk |
| src-tauri/src/ai/grounding/vector.rs:632 | 索引构建阶段③ | 待 embed chunk 含定位句前缀 | 调 embedding API 批量生成向量，32 条/批 | 部分，索引进度条 | 否，只能重建索引 | 向量缺失使语义检索失效 | 每批 32 条 embedding 调用 | 每次索引重建，增量 |
| src-tauri/migrations/060_person_alias_embeddings.sql:31 | 别名嵌入模型或维度变化 | 存量行的 model/dimensions | 判定过期并重算嵌入 | 否 | 否 | 未记录 | AI 嵌入调用，单条短文本 | 每次模型切换后批量重算 |
| src/hooks/useAiChat.ts:929 | 用户发任意一条消息且摘要未就绪 | ai_summaries_auto, bookId | 自动触发整书摘要预处理 | 部分，仅进度条可见 | 是，设置 ai_summaries_auto | 多花 token 与延迟，无内容错误 | 数千 tokens，秒到分钟级 | 每次发消息 |
| src-tauri/src/commands/vocab_gloss_backfill.rs:92 | 应用启动 20 秒后，有疑似卡片 blob 释义 | 多行或超宽的 definition 行 | 调 AI 重生成该词释义并覆盖写入 | 部分，释义悄悄变短，有通知条 | 是，vocab_gloss_backfill 设置，默认开 | 生成失败或为空则保留原行 | utility 档，单词+例句小 prompt | 每次启动，≤40 条，间隔 1.5 秒 |
| src-tauri/src/commands/review_pile_ai.rs:471 | 打开复习页且缓存超 24 小时 | 复习堆 pile_key+词 id+来源理由，不含正文 | AI 重新分组排序拆分，生成 CuratedGroup 覆盖层 | 是，复习页分组标签 | 是，review_pile_curation 开关，关闭后含历史缓存全不可见 | 分组不当只影响展示顺序 | utility 档，几百~2 千 tokens | 默认关闭，开后每天至多一次 |
| src-tauri/src/commands/level_word_class.rs:119 | 阅读统计页加载后自动派发，AI 模式默认开 | 生词+书名作者，不含原文 | 缓存 topical/general 判定，覆盖本地启发式 | 部分，仅文案体现用了 AI | 设置 level_observation_word_class 可切本地 | 判错致等级证据被误分类 | 约 30 词/批，flash 级，~2000 tokens | 每次打开统计页，≤300 词 |
| src-tauri/src/commands/followup_difficulty.rs:171 | 追问攒够 20 条 | 引用段落+问题各截断 600 字符 | 归为 vocabulary/syntax/reference/cultural | 否，仅后台统计 | 是，auto_analysis 开关 | 分类错只影响内部报表 | 单批≤30 条，~2000 tokens | 按阈值触发 |
| src-tauri/src/commands/profile.rs:1238 | 新分类追问数≥20 | 追问/查词/回复节奏预聚合块 | 重写 7 个维度的用户画像卡片 | 是，画像设置页 | 是，开关+单卡可删可撤销 | 画像失真影响讲解口吻 | 两次 AI 调用，utility 档 | 每几十条追问一次 |
| src-tauri/src/commands/auto_analysis.rs:186 | 一本书标记读完时 | 该书阅读统计数据 | 生成阅读回顾分析 | 是，reading_stats 页 | 是，auto_analysis_enabled_reading_review | 回顾内容不准确 | AI 调用 | 每本书读完一次 |
| src/hooks/useBooks.ts:156 | 自动完成或手动 markFinished 触发 | bookId+语言+时区 | 静默调 run_book_finished_analysis | 否，不等待不展示失败 | 否 | 总结缺失，静默吞掉 | AI 调用，网络延迟 | 每次书被标记完成 |
| src-tauri/src/commands/auto_analysis.rs:288 | 任何 job 自动运行前 | job 注册表+settings 开关 | 决定该分析这次是否真的执行 | 否，仅间接体现 | 是，本身即开关系统 | 未审查的 job 误跑，或该跑没跑 | 本地，~0 | 每次自动触发前 |
| src-tauri/src/commands/auto_analysis.rs:223 | 某分析手动跑满 4 次且未开自动 | 该 job 手动运行次数 | 弹「升级为自动」建议 | 是，设置页提示 | 是，可永久拒绝 | 不当推荐打扰用户 | 本地，~0 | 每次手动运行后 |

## 2. 用户显式触发的 AI 生成

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/ai/grounding/summarize.rs:349 | 用户点生成摘要或自动触发 | 章节 chunk 文本 | 按 6000 token 分批，<200 token 章节走本地摘要 | 是，摘要显示在书籍页 | 能，可编辑，user_edited 锁定 | 摘要不准误导理解 | 每批一次调用，数千 tokens | 一次性，索引就绪后 |
| src-tauri/src/ai/grounding/quotes.rs:79 | 用户显式点击追问 | 查询词+当前书位置 | 全库取候选句，每书 1~2 条配额，≤5 条 | 是，回复中展示引用句 | 否 | 引用到不相关书的句子 | 本地 FTS，~0 | 每次追问 |
| src-tauri/src/commands/ai/word_forms.rs:16 | 用户在 WordFormsManager 点生成 | 最多 10 个词 | AI 返回每词的屈折变形列表供查词匹配 | 是，设置页展示结果 | 是，可编辑删除 | 格式不符协议直接报错，不写劣质数据 | utility 档，~1 千 tokens | 用户显式点击 |
| src-tauri/src/commands/vocab_regloss.rs | 用户点「重新生成释义」 | word+context_sentence | AI 重生成 definition 覆盖旧释义 | 是，释义文本更新 | 否，旧释义不保留 | 生成失败保留原文 | 单词+例句小 prompt | 用户显式点击 |
| src-tauri/src/commands/book_difficulty.rs:556 | 用户显式点击「分析」 | 书内全文词形计数 | 重算五档词频分布 | 是 | 可重复点击重算 | 分布图错则难度判断有偏 | 本地，~0 | 用户触发 |
| src-tauri/src/commands/translation.rs:79 | 用户点击翻译且有上下文 | 选中文本长度 vs 上下文段落长度 | 判断是否把整段作为上下文一起发给 AI | 否 | 否 | 缺上下文或多余开销 | 影响 prompt 体积 | 每次翻译 |
| src-tauri/src/commands/translation.rs:25 | 用户点击翻译 | 参数/已存设置/UI 语言 | 级联选择翻译目标语言 | 是，翻译结果语言 | 是，改设置里的翻译语言 | 用错误语言翻译 | 本地，~0 | 每次翻译 |

## 3. 检索与上下文选择

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/commands/ai/routing.rs:311 | 每条聊天消息，未手动选 chip 时 | 问题文本+当前章节+历史路由+viewport | 决定用选中文本/本节/全书/检索哪种上下文 | 部分，显示 scope chip 但不解释依据 | 能，手动点 scope chip 覆盖 | 上下文错位或越出阅读范围 | 本地，~0 | 每条聊天消息 |
| src-tauri/src/commands/ai/routing.rs:551 | 消息出现「全书/结局」等关键词 | 问题文本，中英关键词表 | 判定全书范围意图，解除阅读进度保护 | 否，不提示为何解锁 | 能，用反向短语覆盖 | 越出阅读范围，或该给全书时没给 | 本地，~0 | 每条聊天消息 |
| src-tauri/src/commands/ai/routing.rs:707 | 聊天历史超出字节预算 | max_total_bytes 上限 | 静默丢弃较早的历史消息 | 是，元数据标注 omitted 数 | 否 | 助手失忆，脱离早期语境 | 本地，~0 | 历史过长时 |
| src-tauri/src/commands/ai/routing.rs:90 | 消息含「这个单词/this word」等 | 问题文本关键词 | 区分单词查询与词表请求，决定是否扫词汇 | 否 | 只能靠措辞影响 | 该列词汇时没列，或误扫描 | 本地，~0 | 每条聊天消息 |
| src-tauri/src/ai/grounding/spoiler.rs:31 | 每次聊天或引用检索请求 | 阅读进度 cfi+设置开关 | 计算阅读范围截止点，过滤未读内容 | 是，设置有开关 | 能，全局或单本 override | 截止点算错则漏答或越界 | 本地，~0 | 每次聊天或检索 |
| src-tauri/src/ai/grounding/retrieve.rs:357 | 每次聊天检索 | 消息 token 预算 | 按预算换算 FTS 候选条数，clamp 12~6000 | 否 | 否 | 召回不足或过量 | 本地，~0 | 每条聊天消息 |
| src-tauri/src/ai/grounding/retrieve.rs:134 | 检索结果超出 token 预算 | 候选 chunk 列表+分数 | 丢弃最低分 chunk 直到符合预算 | 否 | 否 | 关键 chunk 被静默截断 | 本地，~0 | 每次检索 |
| src-tauri/src/ai/grounding/vector.rs:15 | 混合检索，向量+关键词 | lexical rank+semantic rank | 用 RRF k=60 合并两路排序 | 否 | 否 | 相关 chunk 排序靠后 | 本地，~0 | 每次向量检索 |
| src-tauri/src/ai/grounding/vector.rs:905 | 向量检索请求 | query embedding | KNN 取 top_k*4 再按阅读范围过滤到 top_k | 否 | 否 | 未读内容误过滤或漏过滤 | 本地 SQL，~0 | 每次向量检索 |
| src-tauri/src/ai/grounding/chunk.rs:147 | 每次建索引分块 | 段落文本 | 按 350 token 目标、500 上限切分，不跨章 | 否 | 否 | chunk 过大或过碎，影响检索粒度 | 本地，~0 | 每次索引重建 |
| src-tauri/src/ai/grounding/chunk.rs:22 | 每次切分文本 | chunk 原文 | CJK 计数+字节/4 估算 token 数 | 否 | 否 | token 预算偏差影响检索截断 | 本地，~0 | 每次分块检索摘要 |
| src-tauri/src/ai/grounding/context.rs:42 | 单 chunk 连续失败达 5 次 | 模型错误或连续空白 | 放弃本书本轮上下文行生成 | 否 | 能，重建索引可重试 | 该轮剩余 chunk 全无定位句 | 本地，~0 | 每次索引构建 |
| src-tauri/src/ai/grounding/context.rs:52 | 定位句返回空白 | 同 chunk 文本 | 最多重试 2 次直到非空 | 否 | 否 | 部分 chunk 永久无定位句 | 每次重试一次模型调用 | 每个空白 chunk |
| src-tauri/src/ai/grounding/aliases.rs:1090 | 每条聊天消息解析人名引用 | 用户问题文本+别名表 | 判定匹配置信度 None/Low/Medium/High | 部分，低中置信度弹 AliasDisclosure | 能，可确认或纠正 | 用错人称扩展检索，答非所问 | 本地，~0 | 每条聊天消息 |
| src-tauri/src/ai/grounding/aliases.rs:1025 | 精确字符匹配为空时 | 查询拼音音节 | 用拼音相似度猜人名，纠 IME 误输入 | 部分，标记为 pinyin 匹配 | 能，同上可撤销 | 猜错角色导致答案跑偏 | 本地，~0 | 每条消息，精确失败时 |
| src-tauri/src/ai/grounding/aliases.rs:1152 | 向量检索开启且已算查询向量 | 查询 embedding+描述别名表 | 余弦相似度≥0.55 判定描述别名命中 | 部分，作为猜测展示 | 能，可删除描述别名 | 错误联想到无关角色 | 本地 KNN，~0 | 向量检索命中时 |
| src-tauri/migrations/059_person_aliases.sql:18 | alias 解析时 | COUNT(DISTINCT canonical) per alias | 用命中次数当置信度分层，而非问模型 | 否 | 否 | 未记录 | 本地，~0 | 每次别名解析 |
| src/hooks/useAiChat.ts:1173 | 回答生成中检测到人名别名 | 查询文本+人物库+embedding | 前端展示别名判定与置信度门槛 | 是，低中置信度有提示 | 否，仅展示不可改 | 答非所问或张冠李戴 | 随请求，几百 tokens | 每次消息含疑似人名 |
| src-tauri/src/ai/grounding/quotes.rs:58 | 全库 FTS 候选过多 | bm25 排序流 | 单书≤20 条、全局≤500 条封顶 | 否 | 否 | 真实命中被挤出候选池 | 本地，~0 | 每次追问 |
| src-tauri/src/ai/grounding/quotes.rs:176 | 判定一本书是否已读 | current_cfi 是否有值 | 无进度的书整本排除出引用范围 | 否 | 否 | 进度未存导致误排除整本书 | 本地，~0 | 每次追问 |
| src-tauri/src/ai/grounding/language.rs:19 | 索引构建时对提取文本采样 | 前 2000 字符 | 判定书籍语言，置信度<0.5 不判 | 否 | 否，写入 books.language | 影响跨语言别名与摘要语言选择 | 本地 whatlang，~0 | 索引重建，无 dc:language 时 |
| src-tauri/src/ai/grounding/summarize.rs:145 | 摘要生成调用模型前 | ai_summary_profile_id 设置 | 静默选摘要专用 profile 或走 failover 默认路由 | 否 | 能，AI 设置可指定 profile | 用错模型致质量成本偏差 | 视 profile 而定 | 每个摘要批次 |
| src-tauri/src/commands/review_pile_ai.rs:255 | 每次读取 curation | AI 返回的 JSON 分组 | 校验 pileKey/wordId 是否在实时 pile 中，不存在的静默丢弃 | 否，看不到丢了什么 | 否 | 幻觉引用被吞掉，分组消失但不报错 | 本地，~0 | 每次读取 curation |

## 4. 读者画像与语言等级推断

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/commands/profile.rs:1414 | 每条追问发给 AI 前 | 全部 active 画像卡片+自填文本 | 拼装 system 提示注入讲解请求 | 部分，看不到注入文本 | 是，profile.enabled 总开关 | 错画像持续污染每次回复 | 本地拼接，~0 | 每条消息 |
| src-tauri/src/commands/profile.rs:64 | 每次画像 batch 运行 | 某维度 90 天窗口证据行数 | 少于 5 条则该维度本轮跳过 | 否 | 否 | 证据不足仍用会得脆弱结论 | 本地，~0 | 每次 batch |
| src-tauri/src/commands/profile.rs:60 | 每次画像 batch 取样 | 各证据 created_at | 30 天半衰期指数衰减定采样权重 | 否 | 否 | 旧证据权重给错，画像偏移 | 本地，~0 | 每次 batch |
| src-tauri/src/commands/profile.rs:416 | 每次画像 batch 构块 | 全部候选证据+权重 | 加权无放回抽样最多 5 条送 prompt | 否 | 否 | 抽样偏差，画像基于不具代表性样本 | 本地，~0 | 每次 batch |
| src-tauri/src/commands/profile.rs:558 | lookup_pattern 维度 batch 时 | 查词记录+词频表 | 算复读率与词频分布，推断查词取向 | 是，画像卡片 | 能，可删该卡片 | 误判查词偏好，举例跑偏 | 本地，~0 | 每次 batch |
| src-tauri/src/commands/profile.rs:669 | reply_pacing 维度 batch 时 | 追问轮次+问题长度 | 推断回答节奏偏好 | 是，画像卡片 | 能，可删该卡片 | 误判对话节奏偏好 | 本地，~0 | 每次 batch |
| src-tauri/src/commands/profile.rs:292 | 每次读写画像卡片状态 | delete/move/undo 事件时间线 | 判定卡片 active/moved/deleted | 是，画像页卡片状态 | 是，本身即裁决层 | 卡片复活或消失 | 本地，~0 | 每次卡片操作或读取 |
| src-tauri/migrations/056_user_profile.sql:18 | 卡片被删除或改写 | watermark 时间戳 | 用 watermark 静默过滤后续聚合，不物理删除 | 否 | 否 | 未记录 | 本地，~0 | 每次画像卡片变更 |
| src-tauri/src/commands/level_observation.rs:451 | 打开阅读统计页 | 90 天查词+曝光，对照声明的 CEFR | 判定 declaredHigh/Low/unclear 或不显示 | 是，统计页底部一行提醒 | 可保留/应用/停止，90 天静默 | 误判让 AI 讲解难度长期错配 | 本地，~0 | 每次打开统计页 |
| src-tauri/src/commands/level_observation.rs:383 | 随上条判定自动执行 | 词频段+书籍曝光集中度 | 判定难词是否为该书专有术语并排除 | 否，仅影响上条结果 | 否，AI 模式下可被 AI 覆盖 | 术语误判污染等级判断证据 | 本地，~0 | 每次统计页判定 |
| src-tauri/src/commands/language_assessments.rs:222 | 用户显式提交语言考试成绩 | 考试类型+总分/阅读分 | 按固定分数区间映射为 CEFR+置信度 | 是，成绩页显示估算等级 | 可删该条成绩 | 区间误配致 CEFR 偏差 | 本地，~0 | 用户提交时 |
| src-tauri/src/commands/language_assessments.rs:97 | 每次估算单场考试等级 | 分数+该考试的阈值表 | 按写死的分数区间落到某个 CEFR 档 | 部分，只看得到结果不看得到区间 | 否，阈值表写死 | 卡在区间边界的分数被判高或判低一档 | 本地查表，~0 | 每次提交或重算成绩 |
| src-tauri/src/commands/level_observation.rs:826 | 每次准备展示等级提醒前 | 该提醒的 keep/apply 记录+当前时间 | 判定是否仍在静默窗口内，决定这次显不显示 | 否，用户只感到提醒没出现 | 是，窗口本身由用户的保留或应用动作设定 | 该提醒的时机被吃掉，或过早重现 | 本地，~0 | 每次打开阅读统计页 |
| src-tauri/src/commands/level_observation.rs:184 | 每次做词类判定前 | ai_available+level_observation_word_class 设置 | 选走 AI 分类器还是本地启发式 | 部分，统计页文案体现用了 AI | 是，level_observation_word_class | AI 不可用时静默退回本地，判定口径变了不提示 | 本地，~0；决定下游是否发 AI 调用 | 每次统计页判定 |
| src-tauri/src/commands/language_assessments.rs:316 | 查询成绩汇总时 | 所有已存考试估算结果 | 按阅读分优先/置信度/新旧加权合并为单一区间 | 是，成绩页汇总行 | 否，权重公式无开关 | 合并权重错致等级建议偏差 | 本地，~0 | 每次读取汇总 |
| src-tauri/src/calibration/mod.rs:152 | 启动后台线程，每日至多一次 | 最近 500 屏节奏+全部查词曝光统计 | 更新 wpm 与查词率，改变熟练度打分缩放系数 0.5~1.5 | 否，仅间接影响熟练度 | 否，样本不足退回中性 1.0 | 校准偏差系统性错判掌握程度 | 本地，~0 | 每日至多一次 |
| src-tauri/migrations/046_local_calibration.sql:10 | 随每日校准任务写入 | 阅读速度/查词率原始数据 | 派生列 reading_speed_wpm/lookup_rate_per_1000，整行覆盖不留历史 | 否 | 否 | 覆盖后无法回退到旧校准值 | 本地，~0 | 每日至多一次 |
| src-tauri/migrations/055_level_word_classifications.sql:12 | 随 AI 词类判定写入 | AI 判定结果 | 派生列 verdict topical/general，永久缓存 | 部分，间接影响统计页 | 否，缓存不过期不覆盖 | 错判定永久缓存，无自动纠错 | 本地写入，~0 | 每次 AI 分类通过 |

## 5. 词汇掌握度与复习排程

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/commands/vocab.rs:365 | 用户点评分按钮 | 评分 Again/Hard/Good/Easy+旧 stability/difficulty | FSRS 算下次复习间隔与是否 mastered | 是，复习卡片显示间隔 | 否，只能再评一次覆盖 | 间隔算错，复习时机不对 | 本地，~0 | 每次点评分 |
| src-tauri/src/commands/vocab.rs:404 | schedule_review 内部 | interval 天数+rating | interval≥21 且非 Again 则标 mastered | 是，词表显示 mastered | 否，阈值写死 | 过早或过晚标记已掌握 | 本地，~0 | 每次复习评分 |
| src-tauri/src/mastery/store.rs:104 | 关书或切章时刷新曝光 | reading_word_exposures 未评分行 | 自动把词 promote 到 familiar/mastered | 部分，词详情页一句话解释 | 是，「我其实不认识」改 manual | 误判已掌握，少复习该词 | 本地，~0 | 每次曝光刷新 |
| src-tauri/src/mastery/store.rs:196 | 每次查词 | book_id+lookup 文本 | 自动阶梯降级该词 mastery | 部分，词详情页解释 | 是，manual 覆盖 | 误降级，增加不必要复习 | 本地，~0 | 每次查词 |
| src-tauri/src/mastery/mod.rs:420 | apply_exposures 内部 | 每次曝光的 occurrence 序号+是否查词活跃屏 | 按权重表+章节上限 2.0 累积 credit，familiar=4/mastered=8 才升级 | 否，不显示 credit 数值 | 否，公式写死 | 权重阈值不准，升级过快或过慢 | 本地，~0 | 每次曝光刷新 |
| src-tauri/src/mastery/mod.rs:483 | apply_lookup 内部 | 7 天窗口内查词次数 | 第 1 次降一级，第 2 次回 Learning，第 3 次起标 book_blocker | 部分，词详情页一句话 | 是，manual 覆盖可撤销 | 连续查词却未真正降级，或误降 | 本地，~0 | 每次查词 |
| src-tauri/migrations/039_mastery_scoring.sql:65 | 阅读曝光批次写入 | encounter_count 增量+查词窗口 | 派生 credit 与掌握度升级判定 | 部分，结论可见过程不可见 | 否 | 算法偏差致误判已掌握 | 本地，~0 | 每次阅读批次落库 |
| src-tauri/src/commands/vocab.rs:836 | 每次查词，首次或未确认词 | book_id+word+累计 lookup_count | 建 watchlist 行，查够 3 次自动 promote 到正式词表 | 否，watchlist 对读者不可见 | 否，只能手动收藏立即 promote | 误 promote 或未 promote 影响词表与复习堆 | 本地，~0 | 每次查词 |
| src-tauri/src/commands/vocab.rs:736 | 用户点「收藏」 | 已存在的 watchlist 行 | 立即 promote 为 confirmed，不看查询次数 | 是，词表新增该词 | 该操作本身即用户动作 | 无 | 本地，~0 | 用户显式点击 |
| src-tauri/src/commands/vocab.rs:449 | 任一路径写入 mastery 或复习状态 | 当前词状态 | 同步写到所有拼写相同的姊妹行，跨书传播 | 部分，只看到统一状态，不知传播了几行 | 否，只能整体 manual 覆盖 | 错误状态污染其他书的同一词条 | 本地，~0 | 每次状态变更 |
| src-tauri/src/commands/vocab.rs:1181 | 用户点「我其实不认识」等 | 目标 mastery 值 | 置 mastery_source=manual，清空 reason，阻断自动判断 | 是，状态改变，自动解释消失 | 是，本身即撤销机制 | 无 | 本地，~0 | 用户显式点击 |
| src-tauri/src/commands/review_piles.rs:19 | 打开复习页 | 4 类行为堆：重复查词/promote 后又查/最近章节查词/FSRS 到期 | 决定复习卡片分组种类与排序 | 是，复习页直接展示 | 否，规则写死不可配 | 排序分类错，复习顺序不合理 | 本地，~0 | 每次打开复习页 |
| src/components/passive-vocab.ts:135 | 每次渲染阅读页 | 词的 mastery 等级+屏幕分桶 | 决定词显示完整释义/仅下划线/不显示，按每屏上限截断 | 是，直接体现为文中标注 | 是，passive_vocab_enabled 及 limit 可调 | 该显示的没显示，影响体验不改数据 | 本地，~0 | 每次翻页渲染 |
| src-tauri/src/commands/word_marks.rs:958 | 首次查询某位置的词 | book_id+word+location | 自动创建 lookup_occurrence_mark 高亮 | 是，文中出现高亮标记 | 是，可关闭单条 | 多余高亮，可手动关闭 | 本地，~0 | 每次首次出现位置的查词 |

## 6. 阅读行为遥测与派生指标

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/commands/reading_behavior.rs:39 | 每次批量写入阅读行为 | 单屏 dwell 时长+操作数 | 判定发呆，≥5 分钟零操作，不计词曝光 | 否 | 否 | 真实阅读被误判发呆，证据丢失 | 本地，~0 | 每次 flush |
| src-tauri/src/commands/reading_behavior.rs:49 | 同上 | 最近 500 屏的字数/dwell | 算个人语速中位数，判定读太快=略读并排除 | 否 | 否 | 正常快读被误判略读 | 本地，~0 | 每次 flush |
| src-tauri/src/commands/reading_behavior.rs:217 | 同上 | 屏幕上的查词记录 | 对同屏未查的词做查词活跃屏加权 | 否 | 否 | 权重偏差喂给 mastery 算分 | 本地，~0 | 每次 flush |
| src-tauri/src/commands/reading_behavior.rs:397 | 更新阅读进度时 | 已测屏数+book_difficulty 总词数 | 估算全书屏数，作自动完结判定的分母 | 部分，影响完结提示是否出现 | 否 | 误判读完或漏判 | 本地，~0 | 每次进度更新 |
| src-tauri/src/commands/books/mutate.rs:234 | 每次进度更新 | 覆盖率≥80% 且推进度达阈值 | 自动把书标记为 finished 并广播事件 | 是，书架状态变化 | 是，手动改回未读 | 误标已读或漏标 | 本地，~0 | 每次进度上报 |
| src-tauri/src/commands/reading_stats.rs:20 | 阅读会话分段时 | 会话内时间间隔 | 超 5 分钟视为暂停，切分会话 | 是，反映在会话时长 | 否 | 会话错切错并，时长失真 | 本地，~0 | 每次会话处理 |
| src-tauri/src/commands/reading_stats.rs:18 | 阅读会话统计时 | 会话时长 | 短于 30 秒的会话不计入统计 | 是，影响阅读时长展示 | 否 | 短会话被错误纳入或排除 | 本地，~0 | 每次会话处理 |
| src-tauri/src/commands/book_difficulty.rs:439 | 书籍导入完成时 | 书内全文词形计数 | 算五档词频分布+状态 pending/done/too_short | 是，详情页难度条 | 可重算，不改读者等级设置 | 分布图错则难度判断有偏 | 本地，~0 | 每次导入新书 |
| src-tauri/src/commands/book_difficulty.rs:648 | 打开开卷卡片时 | 90 天查词与曝光记录按频段分组 | 算每频段「读过而未查」通过率，填卡片一行 | 部分，样本达标才显示 | 无独立开关 | 通过率有偏，难度感知错 | 本地，~0 | 每次打开开卷卡片 |
| src-tauri/src/commands/book_difficulty.rs:572 | 用户显式点难度反馈 | easier/matched/harder/hidden | 覆盖显示但不替换计算结果 | 是，标注在难度条旁 | 可清除 | 纯标注，无实质后果 | 本地，~0 | 用户触发 |
| src-tauri/src/commands/book_difficulty_backfill.rs:39 | 应用启动 25 秒后 | 已算完但缺分节数据的旧书 | 重解析书籍生成每章节难度分布 | 否，纯后台补数据 | 否，一次性历史修补 | 分节数据缺失或与整体不符 | 本地，~0，重解析有 CPU 成本 | 每次启动至多 5 本 |
| src-tauri/migrations/041_book_difficulty.sql:21 | 随难度计算写入 | 词频段计数 | 派生列 band1-5/band_unlisted/status，未收录词排除出生僻档 | 是，间接经难度条 | override 设置 | 分档错误影响选书判断 | 本地，~0 | 每次计算写入 |
| src-tauri/migrations/057_book_difficulty_sections.sql:36 | 随难度计算或回填写入 | 分节词频统计 | 派生列 band1-5 | 是，「哪章最难」山脊图 | 否，随重算覆盖 | 章节难度图错误 | 本地，~0 | 每次计算或回填 |
| src/components/book-open-card-view.ts:246 | 打开书籍卡片时 | 该章 band4/5 词汇占比归一值 | 分级为 hi/mid/none 难度提示色 | 是，卡片难度色块 | 否 | 色块误导阅读预期 | 本地，~0 | 每次打开卡片 |
| src-tauri/src/commands/auto_highlights.rs:120 | 打开高亮面板时 | 查词记录+聊天引用记录 | 派生「未手动画的高亮」列表 | 是，面板「自动·查词/引用」 | 是，可「不再显示」单条 | 无关引用被当高亮展示 | 本地，~0 | 每次打开面板 |
| src-tauri/src/commands/auto_highlights.rs:224 | 同上 | dismissed 表+手动高亮 | 过滤已手动标记或已忽略的重复项 | 是，面板不显示这些项 | 是，可撤销「不再显示」 | 该显示的没显示 | 本地，~0 | 每次打开面板 |

## 7. 模型路由、重试、降级与冷却

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/ai/router.rs:579 | 每次 AI 请求，purpose=Utility | purpose+reasoning_effort_all_features | 强制推理强度设为 none，忽略用户设置 | 否 | 是，开 reasoning_effort_all_features | 简短请求变慢或思考过量 | 本地，~0 | 每条 utility 请求 |
| src-tauri/src/ai/router.rs:790 | 收到 400/422 类请求错误 | 上次失败的错误文本 | 静默重试一次，去掉 reasoning effort 参数 | 部分，自选值被清空时 Toast | 否，自动完成 | 多一次网络往返，请求变慢 | 一次完整 AI 重试请求 | 每次 effort 被拒时 |
| src-tauri/src/ai/router.rs:1182 | 请求失败且未开始输出 | AiErrorKind+是否已 emit | 决定是否换下一个 credential 或 model | 部分，AiRouteFallbackNotice | 可设 Manual 重试 | 换到错的或计费的模型 | 一次完整 AI 请求延迟 | 每次请求失败 |
| src-tauri/src/ai/router.rs:1186 | 请求失败分类完成后 | AiErrorKind+retry_after | 设 profile/credential 冷却 5 分/1 时/1 分/30 秒 | 否，仅 fallback 通知里 | 手动重试可绕过 | 好用的 key 被晾着不用 | 本地，~0 | 每次请求失败 |
| src-tauri/src/ai/router.rs:236 | 收到 Provider 错误 | 错误消息文本 | 分类为 11 种 kind 之一，决定重试策略 | 否 | 否 | 分类错则误重试或误放弃 | 本地，~0 | 每次 AI 请求出错 |
| src-tauri/src/ai/router.rs:989 | 每次路由前 | 各 profile 的 cooldown_until | 过滤掉冷却中或无可用 key 的模型 | 部分，AI_KEYS_COOLING_DOWN 提示 | 否，自动过滤 | 配置了却打不到该模型 | 本地，~0 | 每次 AI 请求 |
| src-tauri/src/ai/router.rs:1124 | 响应带 retry-after 头 | retry-after 数值 | 覆盖默认冷却时长，1 秒~1 天 | 否 | 否 | 冷却时间猜错 | 本地，~0 | 每次限流或配额错误 |
| src-tauri/src/ai/router.rs:2044 | 每次流式请求 | provider 是否 anthropic | 仅 Anthropic 发 max_tokens，其余不设上限 | 否 | 否 | 非 Anthropic 模型输出过长或过短 | 本地，~0 | 每次 AI 请求 |
| src-tauri/src/ai/router.rs:450 | 全新安装且 ai_profiles 为空 | 无 | 自动插入 DeepSeek 默认 AI 档案 | 是，设置页可见可编辑 | 是，可删改 | 以为配好了实则没填 key | 本地，~0 | 仅首次启动一次 |
| src-tauri/src/ai/oauth.rs:353 | access_token 60 秒内过期 | 已存 refresh_token | 静默换新 access_token 并保存 | 否 | 否，自动执行 | 刷新失败要求重新登录 | 一次 OAuth 网络请求 | 每次 OAuth 请求前按需 |
| src-tauri/src/ai/oauth.rs:384 | 供应商未返回 expires_in | 无 | 默认按 3600 秒算过期时间 | 否 | 否 | token 提前失效或延后刷新 | 本地，~0 | 每次 OAuth 刷新 |
| src-tauri/src/ai/request_counts.rs:47 | 记录一次 AI 请求 | origin 是否为 auto | 所有后台调用归入 autoAnalysis 一档 | 是，设置页请求计数区 | 否 | 误判某功能耗多少配额 | 本地，~0 | 每次 AI 请求 |
| src-tauri/src/commands/translation.rs:134 | 用户点击翻译，AI 调用 | AiRequestPurpose::Utility | 决定是否携带推理强度参数 | 否 | 是，AI 设置的推理强度覆盖范围 | 档位不匹配，质量或延迟受影响 | 视 profile 而定 | 每次翻译 |
| src-tauri/src/commands/translation.rs:123 | 用户点击翻译，AI 调用 | retry 参数 | 选失败重试策略 Automatic vs Manual cooldown | 否 | 否 | 该重试时没重试，或反之 | 本地，~0 | 每次翻译请求 |
| src-tauri/src/ai/sse.rs:3 | 流式响应单个 SSE 事件累积超 1MB | pending 缓冲字节数 | 判为协议错误并中断整条流，不截断续读 | 是，回答中断报错 | 否，上限写死 | 长回答被判成协议错误，整轮白跑 | 本地，~0；已花的 tokens 作废 | 每次流式请求逐 chunk 检查 |
| src-tauri/src/ai/router.rs:1437 | 拉取供应商模型列表 | 响应体字节数 | 超 1MB 判错，保护探测端点 | 是，模型列表加载失败 | 否，上限写死 | 模型多的自建网关列不出模型 | 本地，~0 | 每次刷新模型列表 |
| src/components/AiRouteFallbackNotice.tsx:51 | 路由从免费模型切到计费模型 | 事件的 cost 字段 | 决定是否弹费用变化 Toast，自定义端点从不提示 | 是，Toast 6 秒 | 否，仅通知 | 用户不知道正在花钱 | 本地，~0 | 每次免费→付费切换 |
| src/components/ReasoningEffortNotice.tsx:22 | 路由静默清除用户设的推理强度 | effort-cleared 事件 | 弹 Toast 告知设置已被清空 | 是，Toast 6 秒 | 否，需重新设置 | 以为设置还在生效 | 本地，~0 | 每次自选 effort 被拒 |
| src/hooks/useAiChat.ts:751 | ai_prepare_book 调用失败 | 后端异常 | 静默吞错误，进度置 error 态 | 是，进度条显示 error | 否，无重试按钮 | 摘要永久不生成且不知原因 | 本地，~0 | 摘要预处理失败时 |
| src/hooks/useAiChat.ts:696 | bookId 切换 | initializedBookRef 对比 | 自动停止旧书的流式请求并重置状态 | 否 | 否 | 正在生成的回答被静默中断 | 本地，~0 | 每次切换书籍 |

## 8. 导入、格式、语音与设备环境的自动判定

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/commands/books/import.rs:264 | 每次导入 MOBI/AZW | 文件扩展名+本机是否装 Calibre | 静默转 EPUB 走 AI 可用管线，否则留原生只读 | 部分，书架上看不出差异 | 否 | 转换失败或搁置原生模式 | 本地，~0 | 每次导入 |
| src-tauri/src/commands/books/import.rs:255 | 导入 MOBI 家族格式 | 转换后端探测结果 | 决定 preparation_state 初始为 pending 还是 ready | 部分，书架显示准备中 | 否 | 书卡在准备中或过早可用 | 本地，~0 | 每次 MOBI 系列导入 |
| src-tauri/src/commands/books/convert_prepare.rs:127 | 每次判断转换后端 | 探测 PATH 与常见安装路径 | 是否存在可用 ebook-convert，决定走转换分支 | 否 | 否 | 误判无后端则保留原生格式 | 本地，几十 ms | 每次导入或转换判定 |
| src-tauri/src/commands/books/format.rs:163 | txt 导入且无 BOM | 文件字节 | chardetng 猜测文本编码 | 否 | 否，仅报 ENCODING_UNCERTAIN | 猜错则乱码或导入失败 | 本地，~0 | 每次导入无 BOM 的 txt |
| src-tauri/src/commands/books/pdf.rs:20 | 导入 PDF 且元数据缺失 | PDF Info 字典或文件名 | 标题回退文件名，作者回退 Unknown Author | 是，书名作者显示 | 是，编辑元数据 | 书名难看但不影响使用 | 本地，~0 | 每次导入 PDF |
| src-tauri/src/commands/books/text_headings.rs:430 | 导入 txt/md 时逐行解析 | 每行文本 | 判定标题与层级，章/卷/PART，生成目录 | 是，TOC 结构 | 否，无重跑入口 | 目录缺失或层级错乱 | 本地，~0 | 每次导入纯文本 |
| src/components/book-open-card-view.ts:20 | 导入 PDF 时 | page_count/total_chars | 判定是否扫描版 PDF，决定难度分析可用 | 是，会提示无法分析 | 否 | 正常 PDF 误判为扫描版，功能被跳过 | 本地，~0 | 每次导入 PDF |
| src-tauri/src/commands/ocr/resolver.rs:24 | 每次打开 PDF 书或渲染 | 该书全部 OCR 资产+源文件哈希 | 自动选 latest_verified_ocr 或回退原始 source | 否 | 否 | 显示未校验或过期 OCR 文本 | 本地，~0 | 每次打开 PDF |
| src-tauri/src/commands/ocr/manager.rs:413 | OCR 任务入队时，macOS | CPU 核数+可用内存 | 探测资源算出并发 OCR worker 数 | 否 | 否 | 资源耗尽或过慢 | 本地，~0 | 每次 OCR 任务提交 |
| src-tauri/src/commands/ocr/manager.rs:414 | OCR 任务入队时，非 macOS | 无，跳过探测 | 并发数硬编码为 1 | 否 | 否 | Windows 上 OCR 全程单线程，慢很多且不说明 | 本地，~0 | 每次 OCR 任务提交 |
| src-tauri/src/commands/ocr/package.rs:684 | OCR 包下载 | DOWNLOAD_ATTEMPTS 常量 | 可重试错误静默重试下载 | 部分，进度条可见 | 否 | 多次失败后报错 | 本地网络，视文件大小 | 每次 OCR 包下载 |
| src-tauri/src/commands/dictionary.rs:8 | AI 词典未配置或不可用 | 查询词 | 自动回退有道 suggest 接口做释义 | 是，释义面板显示 | 否，无切换开关 | 多义词只给概括释义 | 网络请求，~几百 ms | 每次查词且 AI 未配置 |
| src-tauri/src/commands/speech.rs:6 | 播放发音音频 | 单词或句子文本 | 三源顺序尝试词典→Edge→系统语音，逐个静默降级 | 部分，只能听出音色差异 | 否 | 声音变差但仍可听 | 网络+本地，~1-2 秒 | 每次朗读发音 |
| src/hooks/useSpeech.ts:94 | 每个朗读 chunk 播放 | SpeechRoute 计划+各源响应 | 词典源 2 秒截止，超时即切下一源直到系统语音 | 部分，无切换提示 | 否 | 更差音质但不中断 | 本地判断+网络请求 | 每次朗读 chunk |
| src-tauri/src/commands/speech.rs:439 | 自定义 TTS 未配置 UK 语音 | UK/US 语音设置 | 英式语音自动回退到美式 | 部分，口音设置里能看出 | 是，填写 UK 语音设置 | 听到错误口音 | 本地，~0 | 每次自定义源播 UK |
| src-tauri/src/commands/speech.rs:500 | 自定义 TTS 请求被拒 4xx | 错误响应体前 4096 字符 | 解析并学习该端点支持的语音名，写入 speech_voice_hints | 否，语音选择器间接受益 | 是，speech_forget_voice_options | 学到错误的语音名列表 | 本地解析，~0 | 每次请求被拒 |
| src/components/speech/language.ts:2 | 每次朗读一段文本 | EPUB 语言标签+汉字/拉丁字符比例 | 判定语种 en/zh，决定合成路线还是系统语音 | 否 | 否 | 选错朗读路线，音质或语言不对 | 本地，~0 | 每次朗读请求 |
| src-tauri/src/commands/books/query.rs:431 | 书架列表查询无显式 limit | 无 | 分页大小取默认 20 | 是，列表加载批次 | 否 | 加载体验变化，不影响正确性 | 本地，~0 | 每次未传 limit 的查询 |
| src-tauri/migrations/052_epub_source_metadata.sql:6 | 每次 EPUB 导入 | dc:title/dc:creator 或文件名回退 | 派生列 original_title/original_author 存快照 | 否，配套功能未实现 | 该功能尚不存在 | 无，功能未启用 | 本地，~0 | 每次导入 EPUB |
| src-tauri/src/mcp/control.rs:542 | MCP 动作未指定目标窗口 | 存活会话列表+focused 标志 | 自动选窗口，唯一 focused 优先，其次唯一会话 | 否，仅报错文本 | 否 | 选错窗口会对错的书执行动作 | 本地，~0 | 每次未指定 target 的调用 |
| src-tauri/src/mcp/control.rs:314 | MCP 请求入队 | 调用方传入的 timeout | clamp 到 1~120000 毫秒，静默改写用户传的值 | 否 | 否，上限写死 | 长任务被按 2 分钟超时掐掉 | 本地，~0 | 每次 MCP 入队 |
| src-tauri/src/mcp/control.rs:695 | 请求超过 expires_at 未被认领 | pending/claimed 状态+当前时间 | 静默标记 expired，调用方收到超时 | 部分，调用方能看到失败 | 否 | 未记录 | 本地，~0 | 每次 list_pending/get |
| src-tauri/src/mcp/approval.rs:454 | 同 action+arguments 的批准请求重复到达 | 已存在未消费的挂起请求 | 自动复用已有请求而非新建 | 部分，弹窗只出现一次 | 否 | 未记录 | 本地，~0 | 每次工具调用触发确认 |

## 9. 同步冲突的静默裁决

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src-tauri/src/sync/merge.rs:610 | 收到别的设备的进度同步事件 | 本地 vs 远端 updated_at+device | LWW 元组比较，输家静默丢弃不留痕 | 否 | 无 UI | 输给较新写入者，旧值消失 | 本地，~0 | 每次同步回放 |
| src-tauri/src/sync/merge.rs:638 | book.metadata.set 事件到达 | 本地/远端 ts+device 元组 | 用 <= 而非 < 打破同毫秒多字段编辑平局 | 否 | 无 UI | 未记录 | 本地，~0 | 每次元数据编辑同步 |
| src-tauri/src/sync/merge.rs:850 | vocab.definition.set 事件到达 | 旧释义文本+现有语境解释 | 判断旧释义是否旧格式卡片，决定是否搬进 context_explanation | 否 | 无 UI | 判错会丢一段解释文字 | 本地，~0 | 每次改词条释义 |
| src-tauri/src/sync/merge.rs:1059 | 规则 id 迁移时两 id 都收到同 location 例外 | 两条例外行的 updated_at+device | 折叠为一行，取较新者，创建时间取较早 | 否 | 无 UI | 未记录 | 本地，~0 | 每次规则身份修复 |
| src-tauri/src/sync/merge.rs:1088 | 规则更新触发身份修复 barrier | 例外行 tuple vs barrier tuple | 早于 barrier 的例外强制重置为未排除 | 否 | 无 UI | 覆盖用户尚未同步的排除设置 | 本地，~0 | 规则重命名或合并时 |
| src-tauri/src/sync/merge.rs:1392 | book.summary.upsert 到达 | 远端 updated_at vs 本地 | 严格 < 比较，无 device 作平局项 | 否 | 无 UI | 同毫秒写入结果不确定 | 本地，~0 | 每次生成或同步摘要 |
| src-tauri/src/sync/merge.rs:255 | 收到删除事件 | 待删实体 id | 显式级联删除子记录，非 SQLite 外键 | 否 | 无 UI | 遗漏级联分支会留孤儿行 | 本地，~0 | 每次删除同步 |
| src-tauri/src/sync/merge.rs:214 | 插入或合并墓碑记录 | 已有墓碑 ts vs 新 ts | 取 MAX(ts) 而非覆盖，静默 | 否 | 无 UI | 未记录 | 本地，~0 | 每次删除类事件 |
| src-tauri/src/sync/merge.rs:313 | 全局 settings 键的删除事件 | 事件 id 是否在同步白名单 | 不在白名单直接静默丢弃整条删除 | 否 | 无 UI | 非同步设置永不受影响，按设计 | 本地，~0 | 每次 setting.delete |
| src-tauri/src/sync/replay.rs:580 | 应用某设备快照失败 | 快照数据或事务错误 | 静默跳过该设备本次快照，回滚，下 tick 重试 | 否，仅日志 | 否 | 数据长期落后而用户无感知 | 本地，~0 | 每次同步 tick |
| src-tauri/src/sync/replay.rs:672 | 某事件应用失败 | 事件数据或事务错误 | 该事件及同设备后续事件本 tick 全部推迟 | 否，仅日志 | 否 | 落后设备的数据长期不可见 | 本地，~0 | 每次同步 tick |
| src-tauri/migrations/011_lww_tiebreak_and_outbox.sql:5 | 迁移到带 updated_by_device 的库 | 旧行无该列 | 回填哨兵 'migration'，排在真实设备 UUID 之前 | 否 | 无 UI | 迁移前数据在同毫秒平局中总是输 | 本地，~0，一次性 | 一次性迁移 |

## 10. 界面自动行为

| 位置 | 触发条件 | 输入 | 输出的决策 | 用户看得见吗 | 能覆盖/撤销吗 | 判错时的后果 | 单次成本 | 触发频率 |
|---|---|---|---|---|---|---|---|---|
| src/pages/reader/useFoliateView.ts:917 | 首次打开无存档位置的书 | skip_front_matter，默认 true | 自动跳过封面目录直达正文 | 否，无明显提示 | 是，设置 skip_front_matter | 错过封面引言而不自知 | 本地，~0 | 每次首次打开新书 |
| src/pages/reader/useFoliateView.ts:934 | 存档 CFI 导致初始化超时 45 秒 | 旧的或跨设备同步的 CFI | 静默丢弃存档位置，从头打开并覆盖 CFI | 否，不提示进度丢失 | 否 | 阅读进度悄悄回退到开头 | 本地，多等 45 秒 | 遇损坏 CFI 时 |
| src/components/chapter-end-hint.ts:95 | 章末且有查词记录 | lookupCount+enabled | 自动在章末插入回顾提示条 | 是，章末一行文字 | 是，行内「不再显示」 | 打扰阅读节奏 | 本地，~0 | 每次翻到有查词的章末 |
| src/components/chapter-end-hint.ts:202 | 检测到触屏 | matchMedia pointer:coarse | 决定「不再显示」按钮放收起行还是展开面板 | 是，按钮位置不同 | 否 | 触屏用户找不到关闭入口 | 本地，~0 | 每次渲染该提示 |
| src/components/settings/theme-preference.ts:34 | 主题设为跟随系统 | prefers-color-scheme | 自动决定深色浅色 class | 是，界面配色 | 是，可设 light/dark | 误判系统主题致对比度差 | 本地，~0 | 每次应用主题或系统变化 |
| src/hooks/useIsNarrow.ts:38 | 窗口宽度跨 48rem 断点 | matchMedia | 决定侧边栏挂在哪个容器 | 是，布局切换 | 否 | 布局跳变或拖拽状态丢失 | 本地，~0 | 每次窗口宽度变化 |
| src/hooks/useCoarsePointer.ts:28 | 指针类型变化 | matchMedia pointer:coarse | 切换触屏或鼠标交互呈现 | 部分，影响控件形态 | 否 | 呈现与实际输入设备不符 | 本地，~0 | 每次指针环境变化 |
| src/components/UpdateToast.tsx:111 | App 启动 | auto_check_updates，默认开 | 自动静默检查更新 | 部分，仅有更新时弹 toast | 是，设置 auto_check_updates | 用户不知情联网检查 | 网络请求，秒级 | 每次启动 |
| src/components/UpdateToast.tsx:123 | 检查结果为已是最新 | 无 | 3 秒后自动隐藏 toast | 是，短暂显示后消失 | 否 | 无实质后果 | 本地，~0 | 每次检查到已最新 |
| src/components/settings/reading-defaults.ts:87 | 用户点「恢复默认」 | createDefaultReaderSettings() | 用计算出的默认值覆盖若干阅读设置 | 是，设置面板刷新 | 该操作本身即撤销点 | 默认值与预期不符 | 本地，~0 | 点击恢复默认时 |
| src/components/settings/settings-rehydration.ts:52 | 别的窗口改了同一设置 key | stored/applied/pending 比较 | 用外部新值静默覆盖本面板未提交的显示值 | 否，不提示被同步覆盖 | 否 | 误以为看到的是自己刚改的值 | 本地，~0 | 每次设置变化事件 |
| src/components/settings/reading-rehydration.ts:94 | 数字输入框有焦点且未提交 | focusedKey/values/applied | 判定是否暂缓外部 rehydrate 以保护半输入值 | 否 | 否 | 输入被覆盖或错误保留旧值 | 本地，~0 | 外部变化且正在打字 |
| src/components/error-boundary.ts:147 | 错误详情超 2000 字符 | error.stack/componentStack | 静默截断并追加 [truncated] | 是，技术详情区可见 | 否 | 排查时关键堆栈丢失 | 本地，~0 | 出现长堆栈错误时 |
| src/components/error-boundary.ts:91 | 同一 reset key 下第二次抛错 | attempts 计数 | 判定重试已耗尽并移除 retry 选项 | 是，按钮消失文案变化 | 否 | 错过可恢复场景 | 本地，~0 | 同一界面连续两次报错 |
| src/components/onboarding/AutoAnalysisIntro.tsx:42 | 后端返回自动任务列表为空 | auto_analysis_console 结果 | 自动跳过该引导页并视为已展示 | 否，用户看不到该页 | 否 | 以为看过实际未看到的说明 | 本地，~0 | 首次启动引导流程 |

---

## 边缘条目口径

原先标为「存疑」的条目**已全部收编进上面的表**。这一节不再是待决清单，而是记住它们边缘在哪 —— 下一轮排优先级时，这些的「判错后果」多半比正常条目轻，但不该因为边缘就看不见。

### 边界在「判断 vs. 纯工程常量」
写死的上限，超出即报错或截断。它们不推理，但确实在替用户决定「到此为止」。

- `src-tauri/src/ai/sse.rs:3` — 1MB SSE 缓冲上限（已入第 7 组）
- `src-tauri/src/ai/router.rs:1437` — 模型列表响应 1MB 上限（已入第 7 组）
- `src-tauri/src/mcp/control.rs:314` — timeout clamp 1~120000ms（已入第 8 组）
- `src-tauri/src/commands/books/query.rs:431` — DEFAULT_PAGE_SIZE=20（已入第 8 组）
- `src-tauri/src/ai/grounding/vector.rs` — `EMBEDDING_BATCH_SIZE=32` 与 `RRF_K=60` 没有单独成行，因为它们就是 `vector.rs:632` 和 `vector.rs:15` 两行的内容本身，不是被漏掉

### 边界在「判断 vs. 固定映射表」
没有 AI、没有历史学习，纯查表或纯规则，但输出的是替用户下的结论。

- `src-tauri/src/commands/language_assessments.rs:97` — CEFR 分数区间表（已入第 4 组）
- `src-tauri/src/commands/vocab.rs:404` — interval≥21 天判定已掌握，处在 FSRS 算法与硬阈值交界（已入第 5 组）
- `src-tauri/src/commands/review_piles.rs:19` — 复习堆排序分类的确定性规则（已入第 5 组）
- `src/components/book-open-card-view.ts:246` — 归一分数映射成显示色阶（已入第 6 组）

### 边界在「判断 vs. 流程控制 / 记忆」
更像「记住某件事」而非「推断某件事」，但都是无用户操作下的自动写入或自动读取。

- `src-tauri/src/commands/level_observation.rs:826` — 静默窗口判定（已入第 4 组）
- `src-tauri/src/commands/word_marks.rs:958` — 记住查过的位置并自动高亮（已入第 5 组）
- `src-tauri/src/commands/speech.rs:500` — 从 4xx 响应里学习端点支持的语音名（已入第 8 组）
- `src-tauri/src/commands/auto_analysis.rs:288` — 统管所有 job 的总闸（已入第 1 组）
- `src-tauri/src/commands/profile.rs:1414` — injection_block，也可视为纯数据管道（已入第 4 组）
- `src/components/onboarding/AutoAnalysisIntro.tsx:42` — 空列表自跳过并标记为已展示（已入第 10 组）
- `src/components/settings/reading-defaults.ts:87` — 触发是用户按的，自动的只是默认值计算（已入第 10 组）
- `src/components/UpdateToast.tsx:123` — 3 秒自动隐藏（已入第 10 组）

### 边界在「已存在 vs. 尚未启用 / 平台差异」
- `src-tauri/migrations/052_epub_source_metadata.sql:6` — `original_title`/`original_author` 是为「撤销 AI 清理标题作者」预留的，但代码库里找不到该 AI 清理的实现。**要么是计划中的功能，要么是残留列，值得你确认一下**（已入第 8 组，标为功能未启用）
- `src-tauri/src/commands/ocr/manager.rs:413` / `:414` — 已拆成两行：macOS 真探测资源，其他平台硬编码并发 1

### 归属存疑（算哪一条，不是算不算）
- `src-tauri/src/ai/grounding/index.rs:591` / `:428` — 自动索引流水线的编排与过期判定，已从「容器」提升为两条独立行（第 1 组）
- `src-tauri/src/commands/level_observation.rs:184` — word_class_mode 分类器选择，已从并入状态提升为独立行（第 4 组）
- `src-tauri/src/ai/grounding/summarize.rs:145` — profile 选择走的是读设置项而非实时判断（已入第 3 组）
- `src-tauri/src/calibration/mod.rs:152` — 只产出一个缩放因子供 mastery 引擎用，可以并进曝光积分条目；保留独立行，因为它是「按历史行为自动调整」最典型的样本（已入第 4 组）
- `src/hooks/useAiChat.ts:1173` — 推断跑在后端，这行只是前端消费与展示门槛，与第 3 组的 `aliases.rs:1090` 是同一件事的两端（已入第 3 组）

---

## 本轮扫描的已知缺口

以下文件在分区范围内但未读完，可能还有条目：

- `src-tauri/src/commands/` — `annotations.rs`、`bookmarks.rs`、`notes.rs`、`explanations.rs`；`reading_stats.rs` 只扫了常量未读全文
- `src-tauri/migrations/038_mastery.sql` — 未细读，可能还有独立的 LWW 或阈值判断
- `src/hooks/` — `useAutoHighlights.ts`、`useProfile.ts`、`useExplanations.ts`、`useContextLineProgress.ts`、`useOpenCardData.ts`、`useReadingSessionTracker.ts`
- `src/components/` — `profile/`、`ProfileContent.tsx`、`ReadingStatsContent.tsx`、`ExplanationsContent.tsx`、`BookOpenCard.tsx`、`BookOpenGateProvider.tsx`、`sidebar-badges.ts`、`book-finished-hint.ts`、`focus-word.ts`
- `src/components/settings/` — `AutoAnalysisSettings.tsx`、`auto-analysis.ts`、`context-lines.ts`
- `src-tauri/src/sync/merge.rs` — 同一 LWW 模式出现 10+ 处，本次只挑了有特殊分支的代表行，第 9 组条目数是被压缩过的
- `src-tauri/src/commands/ai/routing.rs` — 关键词分类器（has_whole_book_intent、is_vocabulary_request 等）合并成了 2~3 行代表条目，未逐函数展开
