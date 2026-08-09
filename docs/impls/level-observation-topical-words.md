# 水平对照 · 题材词筛除（topical-word screening）

> 依附于 `docs/impls/archive/reading-driven-mastery-and-review.md` §6/§7 的水平对照行。
> 本文只覆盖 2026-08 拍板的增强：把「查的词属于哪类」纳入证据。
> 2026-08-08 修订：AI 甄别改为默认模式（用户拍板），本机启发式降级为
> 回退与可选项。原「AI 违反 ruleLocal」的否决被推翻——承诺文案随模式走，
> 各说各的真话。

## 问题

现状只按词频段统计查词记录。一本题材专门的书（航海、烹饪、奇幻）会带来一批
反复出现的术语；读者把它们查掉，记录上和「通用词汇有缺口」留下同样的痕迹。
后果是两类误判：

- 申报 C1 的读者读一本术语密集的书，band 4 查词堆积 → 误报 declaredHigh；
- 一本书把自己的难词重复了十几遍，读者靠上下文读过去 → 这些「读过没查」的词
  被当成 declaredLow 的证据，其实只说明这本书自我重复。

## 方案选型

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **AI 分类（默认）** | **采用** | 启发式只看「复现」，AI 看「词义」：既救回被一本书带偏的通用词（如忧郁小说里的 melancholy），也抓住曝光不足的真术语。发出的只有词本身和书名/作者；判定结果永久缓存在本机。真实配置验收测试（DeepSeek deepseek-v4-flash，20 词标注样本）20/20 通过后才定为默认 |
| **本机爆发性（burstiness）启发式** | **采用（回退 + 可选）** | 只用已有数据；零新资产；无 AI 配置、用户选「只用本机记录」、或词尚未拿到 AI 判定时全部走它 |
| 静态词表（AWL/NGSL 抽象词表） | 否 | 只覆盖学术域，小说题材词（航海、奇幻）不在表上；引入第三方资产与许可；会随语料过时；AI 模式下它能判的 AI 全都能判 |
| ~~AI 分类：否~~ | 已推翻 | 原否决理由是违反 `ruleLocal` 承诺。2026-08-08 用户裁定：把承诺改掉、让用户自己选。细则文案按实际运行的模式渲染（`ruleAi` / `ruleLocal`），设置里可切换 |

## 判定规则

一个可评分（词频表能打分）的词判为**题材词**，当且仅当窗口（90 天）内：

1. **频段 ≥ 3**（rank > 3000）。齐夫定律下 rank 3000 的词期望约 2 次/10 万词；
   频段 1–2 的词在任何书里都反复出现，爆发性读不出来，分类器对它们不下结论。
2. **只在一本书里查过**（≥2 本书都查过 → 是读者自己的词汇缺口，直接判通用）。
3. **在屏曝光 ≥ 6 次，且 ≥ 80% 集中在同一本书**。一本书反复使用一个
   rank-3000 开外的词，是这本书的自有词汇，不是通用英语的样本。

默认方向：**证明不了是题材词，就按通用词处理**（即维持今天的行为）。曝光数据
缺失（某格式不记曝光）时整体退化为现状，不会凭空筛掉证据。

## AI 甄别模式（默认）

设置键 `level_observation_word_class`：`'ai'`（默认）| `'local'`。无已配置的
AI 服务时强制走 local，细则文案也如实标 local。

- **硬门槛不问 AI**：频段 1–2、以及 ≥2 本书都查过的词，两种模式下都直接
  判通用——这两条是定义性的，AI 没有更多信息可加。
- **缓存**：`level_word_classifications`（migration 055，主键
  (normalized_word, book_id)，verdict ∈ topical/general）。一词对一书判一次，
  永不过期、永不覆写（`INSERT OR IGNORE`）。
- **异步批处理**（照抄 `followup_difficulty.rs` 的纪律）：打开统计页先用
  已缓存判定算今天的行并立刻返回；未判定的词作为候选，页面返回后
  detached 任务分批送审（30 词/次，单次访问上限 300 词，`BATCH_RUNNING`
  单飞）。失败静默，词回退启发式，下次再试。
- **上行内容**：仅词 + 所在书的「书名 — 作者」。无原文、无次数、无读者信息。
  计费记入 `ai_usage_records.feature = 'level_word_class'`。
- **收据**：`LevelObservation.wordClassSource`（wire）报实际运行的模式，
  前端据此选 `ruleAi` / `ruleLocal` 细则句。
- **验收**：`#[ignore]` 测试 `the_real_provider_classifies_a_labeled_sample_accurately`
  读本机真实配置（只读），Moby-Dick + A Brief History of Time 各 10 词
  标注样本，门槛 17/20。2026-08-08 实测 DeepSeek deepseek-v4-flash：20/20。

## 进入判断的方式

- 题材词从所有频段计数中剔除（lookups、looked-up words、passed words），
  查词行数单独累计为 `topical_lookups`。
- 阈值全部不动。剔除只会让任何结论更难达成——与模块「宁静默不猜测」的
  既有方向一致。
- span 只按留下的（通用）查词计算：被判断的就是这份通用记录。
- 收据原则：declaredHigh / unclear 的句子报出的 total 不再等于读者自己能数出
  的全部查词数，所以剔除量必须交代。新 i18n 键
  `readingStats.levelObservation.topicalNote`（zh/en），仅当剔除数 > 0 时渲染。

## 改动清单

| 层 | 改动 |
| --- | --- |
| `level_observation.rs` | `collect()` 查词行带 `book_id`；新增曝光按 (word, book) 聚合查询；`score()` 内纯函数 `is_topical()` 分类；`RecordSummary.topical_lookups`；`LevelObservation.topical_lookups`（wire: `topicalLookups`，declaredHigh/unclear 为 Some，declaredLow 为 None）；AI 模式下 `classify()` 以缓存判定覆盖启发式、未判定词提名候选；`wordClassSource` 上 wire |
| `level_word_class.rs`（新） | 候选批处理：书名解析、prompt、响应解析、`INSERT OR IGNORE` 入缓存、`spawn_classification` detached 入口、真实配置验收测试 |
| `migrations/055` | `level_word_classifications` 表 |
| `level-observation.ts` | 接口加 `topicalLookups: number \| null`、`wordClassSource: "ai" \| "local"`；`levelObservationRuleKeys(kind, source)` 按模式选承诺句 |
| `types.ts` / `ReadingStatsContent.tsx` / `ReadingStats.tsx` | 新标签 `levelTopicalNote`，正文之后、effect 之前渲染一行 muted 说明 |
| `LearningSettings.tsx` | 翻译语言行之后新增「水平对照的词汇甄别」Select 行（ai/local） |
| `zh.json` / `en.json` | `readingStats.levelObservation.topicalNote`、`ruleAi`；`settings.learner.levelWordClass*` |
| `tests.rs` | 分类器纯函数用例；wire 合同加键；端到端「同一批 band-4 查词，无曝光→出行，单本书高曝光→静默」；多本书查过否决；AI 判定双向覆盖启发式、未判定回退并提名、local 模式不读缓存不提名 |

## 已知边界

- 常用词的领域义（"deck"、"bow"）检测不了——没有词义信息，频段 1–2 一律不分类。
- 窗口内只读一本书的读者，其反复出现的难词会被筛掉；这正确——一本书之内
  本来就分不开「书的用语」和「你的缺口」，静默是模块的既定偏向。
- 「只在一本书里查过」这条否决（规则 2）确实很少触发——同一个生僻词在两本书
  里都被查到的概率本来就低。保留它不是因为它常用，而是因为它触发即正确、
  代价为零；启发式里真正干活的是曝光集中度（规则 3），AI 模式下则是词义
  判断本身。
