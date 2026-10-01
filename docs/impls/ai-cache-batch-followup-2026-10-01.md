# AI 缓存优化补测（2026-10-01）

## 结论与范围

本轮补测所有已识别的批量模型调用形态，使用 Codex 订阅端点的 `gpt-6-luna` 与现有 DeepSeek 凭据对应的 `deepseek-v4-flash` 请求名，响应模型名为 `deepseek-flash`。主矩阵型号名是请求/响应标识，[DeepSeek 当前文档](https://api-docs.deepseek.com/quick_start/pricing-details-cny/)将旧 v4 Flash 请求名说明为别名路由，不把它当成固定不变的底层物理版本。没有任何 Claude 网络调用，没有改账号、凭据、用户库或项目配置，没有发布版本。

已确认三项有价值的最小修复：

1. Codex 订阅 Responses 请求增加同值的 `session-id` 与 `prompt_cache_key`。从固定输入开头计算 SHA-256；不包含当前可变上下文。只截取开头 1,024 字符用于路由分组，并非截断模型输入或限制缓存容量。
2. Claude 在无历史 assistant、最后两条消息都是 user 时，在前一条固定章节消息上补缓存边界；原有系统与末条边界保留，总计最多三个。已有 assistant 历史优先使用原边界。
3. 索引定位句：估算不超过 8,000 token 的整章已经发送时，停止重复发送附近窗口；超过阈值的长章节继续发送固定开头和目标附近窗口。目标 passage 仍保留，以明确当前要描述哪段。

**会话标识不累积上下文。** 每次仍发送当前业务需要的完整请求，保持 `store:false`，没有使用 `previous_response_id`，没有拼入其他批次或旧回答。标识仅帮助请求路由到可能有缓存的位置，服务端仍需验证完整提示词前缀。固定长度探测四轮输入各 5,675 token，没有逐次增长；增长历史实验增加的是原业务历史，而非此次修复附加的内容。

不能承诺所有场景高命中。不同批次替换原文，且共同指令很短时，原文的大部分没有可复用前缀。缓存比例低并不等于没有优化空间，但不能通过加入无用文本或伪造历史把指标做高。

## 原报告的覆盖边界

先前 DeepSeek 80.5%（含冷启动）的数字来自固定长历史及每轮变化的当前上下文，不包括索引定位句、词汇扫描和全部批量任务。先前 Codex 长历史零命中、固定章节约 14.25% 同样不能代表所有批量调用。本轮专门补足这些形态。

原报告低频长历史表中的两个输入总数抄录有误，已按原始统计修正为 33,831 和 33,855；缓存读取仍为零，原结论不变。

## OpenAI：数据存在，路由有效但不是万能修复

先前保存的 57 条 OpenAI 原始响应全部包含 `usage.input_tokens_details.cached_tokens`，其中五条大于零。这里的零不是客户端未提供或未解析读取数据。`cache_write_tokens` 为零不能直接解释成没有写缓存，也不能用来推导实际账单节省。

固定长前缀、每轮更换当前问题的受控对照：

| 请求形式 | 请求数 | 暖后读取 |
| --- | ---: | --- |
| 原布局 | 4 | 0/3 |
| 仅缓存键 | 4 | 0/3 |
| 缓存键 + session-id | 4 | 3/3，各 4,864 token |

真实生产 adapter 的增长历史对照：原布局 4,864/33,837（14.37%）；加入 affinity 后 24,320/33,831（71.89%，含冷启动），暖后五轮均读取 4,864。此阶段使用的是合成业务历史和短的防指令覆盖答案检查，不能替代真实章节批量测试。其代码阶段先于最后的路由 hash 长度限制；后续批量测试使用最终长度限制实现。

GitHub 经验与证据：

- [Codex 官方客户端](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)明确说明订阅后端从 Responses session-id 取得 cache affinity；[请求头实现](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs)使用 `session-id`。本项目原先未传此头。
- [Issue 35300](https://github.com/openai/codex/issues/35300)中多人报告独立请求、分叉会话和变化后缀的缓存缺失。它是排查线索，不能证明本项目所有零命中的原因。我们自己的 gpt-6-luna 探测返回 HTTP 400：`prompt_cache_breakpoint is not supported on this model`，所以没有在产品请求里加入该参数。
- [Issue 32479](https://github.com/openai/codex/issues/32479)讨论客户端 cache-write 统计丢失和服务端零值的区别；本项目本轮读取统计来自原始响应与 adapter 两层，不靠界面总量推测。
- [OpenAI 官方缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching)强调相同前缀和最小长度。公共 API 的能力不能未经实测套到 Codex 订阅后端。

## 批量调用清单与测试含义

| 路径 | 补测内容 | 样本与边界 |
| --- | --- | --- |
| 索引定位句 | 同章不同片段、换章、去重前后、并发 | 本地索引真实《傲慢与偏见》XVIII，26 块，估算 7,378 token；6 个目标 |
| 摘要 | 分批 map、同源 reduce 重试、全书概述 | 真实《白鲸》章节批次 + 小型合成 reduce 样本 |
| 别名抽取 | 同书重试、换书、换章 | 真实消息 builder，小型合成资料 |
| 词汇扫描 | 多个不同批次、接近 4,500 token 预算 | 真实《白鲸》本地索引 1,158 块/73 批，取前三批；另有短样本 |
| 词形生成 | 不同词组、同输入重试 | builder 实际形态，3 词样本；未跑 500 词整队列 |
| 词汇分类 | 不同批次、换上下文 | topical/general，3 行样本；未测全部 30 行边界 |
| 后续难度分类 | 不同批次 | vocabulary/syntax/reference/cultural，3 行样本 |
| 用户画像 | 多槽、证据变化、重试、收紧、review | 小型合成记录，不读取真实私人学习档案 |
| 练习批量流程 | 写题、遮罩检查、答案检查、重生成、讲解延续/冷重建、聚合语法判题 | 前端真实 prompt builder 与 completeText 载荷；历史回复为合成，不代表整套 UI 自动化 |
| 向量批次 | embedding 输入、分批与持久化本地检查 | 已配置本地服务 127.0.0.1:1234 连接失败，未获得真实 embedding 响应；未启动或修改服务 |

所有聊天样本均经过真实生产 provider adapter。索引与扫描 fixture 来自隔离临时数据库中的真实 EPUB 本地索引；其他小样本验证实际构造形式。没有把 fixture 导出、mock、HTTP 200 或非空文本当作完整业务质量证明。结构型输出核对 JSON 类型、条数、索引/分类或来源引用；自由文本仅检查完成与非空，未全量人工评审事实准确性。向量 endpoint 独立于聊天缓存，不能用聊天缓存率代表它。

## 结果

已覆盖 **88 个不同聊天请求样本**，包含重试共 103 个矩阵请求尝试。取每个样本最后一次结果：87 个完成，86 个通过严格结构/来源核对或自由文本非空检查。两个剩余限制均在 DeepSeek 大词汇扫描：一个完整 JSON 含来源不匹配条目（生产 parser 会逐条拒绝不匹配候选）；另一个在服务端默认输出额度处截断。不能把这两项算作成功。

测试条件：主矩阵、布局对照及并发对照固定 `reasoning_effort=low`；DeepSeek 主矩阵显式输出限额为 8,192，大扫描失败后为 16,384。它们用于受控缓存测量，并不等同于完整生产 router 的参数。后续已核查实际生产规则：非 Anthropic 不发送输出限额，Utility/BackgroundUtility 默认使用 `none`（当前 DeepSeek 配置未开启所有功能思考）。因此又按 `none`、不发送输出限额复测真实大扫描三批和定位句两批/模型：定位句两模型均完成；扫描两批完成，一批仍被服务端默认额度截断。初始有思考、有限额的扫描失败不能直接归因于生产代码。该复测未修改配置。

### 索引定位句：去重确实减少输入

同一真实章节、同样六个目标、固定章节消息逐字相同，Codex 输入由 53,280 降至 40,503 token，**减少 23.98%**；消息数没有增加。

| 实验 | 请求结果 | 缓存读取 |
| --- | --- | --- |
| 原定位句布局，native 六个目标 | 6/6 完成 | 0/53,280 |
| 去重布局，native 六个目标 | 6/6 完成 | 23,552/40,503 = 58.15%，前两次零、后四次各 5,888 |
| 去重布局，DeepSeek 六个目标 | 5/6 完成，第一条断流 | 完成的五条各 6,400；32,000/34,069 = 93.93%；不伪造失败请求的冷启动输入量 |
| 独立隔离前缀对照：原布局 | 4/4 完成 | 0/34,585 |
| 独立隔离前缀对照：去重 | 4/4 完成 | 17,664/27,083 = 65.22%，含冷启动；暖后 3/3 各 5,888，约 86%–88% |
| 独立隔离前缀对照：去重再合并相邻 user | 4/4 完成 | 同为 17,664，65.28%；无额外收益，未合入代码 |

最初去重序列和合并消息探测同时发生，可能共享底层缓存，不能只凭该序列断言因果。随后独立对照在章节 user 文本前加不同的隔离标识，每组保持固定，并计算各自稳定的会话/缓存键；三个组并行、组内串行，四个真实目标保持相同。这些标识只用于隔离实验，产品没有加入额外文字。对照支持这组去重布局改善了命中，但服务端具体缓存策略仍不可见，不能宣称解释了所有零命中机制。

### 并发：缓存准备完成前后差别很大

对真实去重请求增加隔离标识，在四个请求并发的冷批次之后重放同样四个请求：

| 模型 | 冷批次 | 暖批次 |
| --- | --- | --- |
| native gpt-6-luna | 仅 1/4 有完整 usage，读取为零；另外两条断开、一条未见完成事件 | 4/4 完成，23,552/27,075 = 86.99% |
| DeepSeek | 4/4 完成，512/27,337 = 1.87%，只有短的公共指令缓存 | 4/4 完成，26,496/27,337 = 96.92% |

暖并发结果包含同一批次的精确重放，不能当作全部不同批次的稳态平均值。本次只测四并发，没有把结果推广到索引配置的最大并发。也没有修改业务调度为预热后并发；因此新书第一次同时发出的批次仍可能集中冷启动。网络超时、断流和无完整 usage 的请求不会进入“成功请求读取率”分母。

### 全部批量形态结果

以下表格合并每个样本的最后一次复核；真实大扫描的 DeepSeek 行取生产 Utility 参数，其余为受控 low 参数。不同场景不能混成一种稳定命中率。摘要的大原文不同批次、扫描原文不同批次、短词形和分类共同前缀很短，仍然为零或较低；不添加无用上下文来抬高比例。摘要同输入重试能复用原文，与不同原文批次是两个情况。

| 场景 | 模型 | 样本 | 完成/格式或非空 | 读取/输入 token（仅完成请求） | 读取率 |
| --- | --- | ---: | --- | ---: | ---: |
| aliases | deepseek | 4 | 4/4 | 384/1,244 | 30.87% |
| aliases | openai | 4 | 4/4 | 0/1,112 | 0.0% |
| context_real_book | deepseek | 7 | 7/7 | 34,176/54,008 | 63.28% |
| context_real_book | openai | 7 | 7/7 | 0/53,490 | 0.0% |
| followup_difficulty | deepseek | 3 | 3/3 | 0/714 | 0.0% |
| followup_difficulty | openai | 3 | 3/3 | 0/645 | 0.0% |
| level_word_class | deepseek | 3 | 3/3 | 0/780 | 0.0% |
| level_word_class | openai | 3 | 3/3 | 0/699 | 0.0% |
| profile_summarize | deepseek | 5 | 5/5 | 256/1,425 | 17.96% |
| profile_summarize | openai | 5 | 5/5 | 0/1,294 | 0.0% |
| quiz_answer_check_trace_prefix | deepseek | 1 | 1/1 | 0/1,827 | 0.0% |
| quiz_answer_check_trace_prefix | openai | 1 | 1/1 | 0/1,934 | 0.0% |
| quiz_explanation_cold_rebuild | deepseek | 1 | 1/1 | 2,048/2,207 | 92.8% |
| quiz_explanation_cold_rebuild | openai | 1 | 1/1 | 0/2,435 | 0.0% |
| quiz_explanation_trace | deepseek | 1 | 1/1 | 2,560/2,734 | 93.64% |
| quiz_explanation_trace | openai | 1 | 1/1 | 0/2,948 | 0.0% |
| quiz_grammar_judge_aggregated | deepseek | 1 | 1/1 | 0/372 | 0.0% |
| quiz_grammar_judge_aggregated | openai | 1 | 1/1 | 0/358 | 0.0% |
| quiz_masked_check | deepseek | 1 | 1/1 | 0/389 | 0.0% |
| quiz_masked_check | openai | 1 | 1/1 | 0/382 | 0.0% |
| quiz_regenerate | deepseek | 1 | 1/1 | 1,024/1,211 | 84.56% |
| quiz_regenerate | openai | 1 | 1/1 | 0/1,299 | 0.0% |
| quiz_stage1_write | deepseek | 3 | 3/3 | 1,024/3,679 | 27.83% |
| quiz_stage1_write | openai | 3 | 3/3 | 0/3,983 | 0.0% |
| summarize | deepseek | 2 | 2/2 | 0/163 | 0.0% |
| summarize | openai | 2 | 2/2 | 0/124 | 0.0% |
| summarize_real_book | deepseek | 3 | 3/3 | 5,376/14,153 | 37.98% |
| summarize_real_book | openai | 3 | 3/3 | 4,864/13,644 | 35.65% |
| vocabulary | deepseek | 2 | 2/2 | 0/480 | 0.0% |
| vocabulary | openai | 2 | 2/2 | 0/430 | 0.0% |
| vocabulary_real_book | deepseek | 3 | 2/1 | 0/10,144 | 0.0% |
| vocabulary_real_book | openai | 3 | 3/3 | 0/14,750 | 0.0% |
| word_forms | deepseek | 3 | 3/3 | 0/413 | 0.0% |
| word_forms | openai | 3 | 3/3 | 0/355 | 0.0% |

所有有 usage 的 adapter 记录均与 relay 保存的原始服务端 usage 精确匹配。最终 122/122 匹配。原始 relay 共 177 次请求尝试：105 OpenAI、72 DeepSeek、0 Claude，包括参数拒绝、失败及附加对照。没有推算成模型费用或账单节省。


## Claude 风险边界

OpenAI 路由代码只影响订阅 Responses。Claude 的消息角色和正文没有因它改变；固定章节缓存边界补齐有本地断点和禁用缓存回归验证。共同的短章节去重会让升级后首次请求失去旧布局缓存。还存在一个有条件的真实退化风险：如果去重前的完整请求达到某 Claude 型号的最小缓存长度，而去重后低于阈值，精确重试的缓存读取可能消失；输入减少不等于每种模型的命中率或费用必然改善。[Claude 官方文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)明确要求最小长度，且不同型号阈值不同。因此不保留重复文字来垫长度，也不承诺 Claude 缓存率绝不会降低。跨片段复用仍依赖固定章节本身足够长；新增固定章节断点不会取消旧断点。长章节布局保持原样。没有付费 Claude 实测，只确认请求构造及这些边界，不能给出服务器真实命中率。

## 验证与复现证据

最终 AI 本地测试：536 passed，3 ignored（显式在线测试），0 failed；其中 Claude 14 项本地测试通过。临时导出测试与付费探测 harness 在验证后移出项目，保留证据副本。

最终 `cargo clippy --lib -- -D warnings` 通过，`git diff --check` 通过；仅提交三处 AI 源码、此报告及原报告数值更正。未改前端，无需前端构建；当前安装版本需后续包含本次提交的构建才能获得修复。

外部证据目录：`/Users/lijianwei/.codex/visualizations/2026/10/01/01a0f562-303d-70c1-85a1-26a61dcae835/lantern-cache-batch-followup`。原始响应、业务 fixture、阶段日志、代码快照 hash 和统计脚本保留其中。统计只用服务端读取 token/输入 token，重试失败另记，不推测账单节省。凭据仅在 relay 内存中读取；证据不含认证值。
