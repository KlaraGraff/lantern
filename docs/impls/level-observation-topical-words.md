# 水平对照 · 题材词筛除（topical-word screening）

> 依附于 `docs/impls/reading-driven-mastery-and-review.md` §6/§7 的水平对照行。
> 本文只覆盖 2026-08 拍板的增强：把「查的词属于哪类」纳入证据。

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
| **本机爆发性（burstiness）启发式** | **采用** | 只用已有数据（`reading_word_exposures` 按 (book, word) 聚合、`lookup_records.book_id`）；零新资产；直接编码「某本书题材带来的术语」这个定义本身 |
| 静态词表（AWL/NGSL 抽象词表） | 否 | 只覆盖学术域，小说题材词（航海、奇幻）不在表上；引入第三方资产与许可；会随语料过时 |
| AI 分类 | 否 | 违反行内既有承诺 `ruleLocal`（「对照只用本机记录，不上传」） |

## 判定规则

一个可评分（词频表能打分）的词判为**题材词**，当且仅当窗口（90 天）内：

1. **频段 ≥ 3**（rank > 3000）。齐夫定律下 rank 3000 的词期望约 2 次/10 万词；
   频段 1–2 的词在任何书里都反复出现，爆发性读不出来，分类器对它们不下结论。
2. **只在一本书里查过**（≥2 本书都查过 → 是读者自己的词汇缺口，直接判通用）。
3. **在屏曝光 ≥ 6 次，且 ≥ 80% 集中在同一本书**。一本书反复使用一个
   rank-3000 开外的词，是这本书的自有词汇，不是通用英语的样本。

默认方向：**证明不了是题材词，就按通用词处理**（即维持今天的行为）。曝光数据
缺失（某格式不记曝光）时整体退化为现状，不会凭空筛掉证据。

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
| `level_observation.rs` | `collect()` 查词行带 `book_id`；新增曝光按 (word, book) 聚合查询；`score()` 内纯函数 `is_topical()` 分类；`RecordSummary.topical_lookups`；`LevelObservation.topical_lookups`（wire: `topicalLookups`，declaredHigh/unclear 为 Some，declaredLow 为 None） |
| `level-observation.ts` | 接口加 `topicalLookups: number \| null` |
| `types.ts` / `ReadingStatsContent.tsx` / `ReadingStats.tsx` | 新标签 `levelTopicalNote`，正文之后、effect 之前渲染一行 muted 说明 |
| `zh.json` / `en.json` | `readingStats.levelObservation.topicalNote` |
| `tests.rs` | 分类器纯函数用例；wire 合同加键；端到端「同一批 band-4 查词，无曝光→出行，单本书高曝光→静默」；多本书查过否决 |

## 已知边界

- 常用词的领域义（"deck"、"bow"）检测不了——没有词义信息，频段 1–2 一律不分类。
- 窗口内只读一本书的读者，其反复出现的难词会被筛掉；这正确——一本书之内
  本来就分不开「书的用语」和「你的缺口」，静默是模块的既定偏向。
