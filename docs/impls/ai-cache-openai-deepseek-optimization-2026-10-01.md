# OpenAI / DeepSeek 对话缓存优化与实测（2026-10-01）

## 结论

DeepSeek v4 的连续对话已测得明显收益：旧布局六轮均未命中，新布局第二至第六轮复用了 95.5%–97.3% 的输入 token；计入冷启动首轮，总复用比例为 80.54%。另一组独立实验为 80.05%。这两个数字仅代表受控长上下文样本。

OpenAI 请求布局已保持稳定前缀，但使用 Codex 内置 `gpt-6-luna` 的原生通道，没有验证到连续对话的稳定收益。增长历史实验新旧均为 0%；固定长章节实验新旧均只有 1/6 请求命中，总复用比例均约 14.25%。因此本次不能宣称 OpenAI 已实现高命中，也不能归因成已经确认的服务端故障。

## 改动与理由

原布局是「固定书籍指令 + 本轮章节/阅读区域/来源规则 → 历史 → 当前问题」。本轮上下文发生变化，会在历史之前打断公共前缀。新布局把本轮变化的内容放到当前问题之前，得到「固定书籍指令 → 历史 → 本轮上下文 → 当前问题」。

- 书名、作者和可稳定复用的原书章节保持在固定部分；当前章节名称移入变量部分。章节名称继续使用 JSON 转义。
- 现代 OpenAI：固定与动态应用指令都采用 `developer`，即应用提供的高优先级指令。Responses 将它们作为输入消息；保留空 `instructions` 以满足原生 Codex 请求格式。Chat Completions 使用同样的两段优先级。
- DeepSeek v4：两段均为 `system`。图片先与当前用户消息合并，再插入动态指令，避免拆散多模态问题。
- 仅对白名单中的型号且存在非空动态内容时启用新布局。旧 DeepSeek、未知兼容模型、`gpt-oss` 保留合并布局。旧 DeepSeek 的公开模板会把系统消息汇集到开头，套用晚插入布局不能扩大历史公共前缀。
- 来源标识、可读范围、防剧透、当前页证据和回答纪律继续随实际阅读状态变化。不会为命中率冻结它们，也不会填充额外 token。

历史增长存在一个自然边界：上轮动态上下文不会被伪装成永久历史；后续请求能复用的是前面一致的历史。实际发送记录确认，最终长历史样本的相邻优化请求共享 15、17、19、21、23 条消息，首个公共前缀超过 30,000 字符。前缀存在不等于远端必然命中。

## 真实对照结果

复用比例定义为 `sum(cached input tokens) / sum(all input tokens)`，包括首轮冷启动。它不是“有命中的请求数量占比”。各组每个布局六轮，每轮改变当前章节、页码、目的地，并增加用户/助手历史。

| 实验 | 模型与通道 | 旧布局 cached / input | 新布局 cached / input |
| --- | --- | ---: | ---: |
| 第一组长历史 | DeepSeek v4 Flash，官方 Chat Completions | 0 / 33,732（0%） | 27,008 / 33,738（80.05%） |
| 最终代码长历史 | DeepSeek v4 Flash，官方 Chat Completions | 0 / 33,846（0%） | 27,264 / 33,852（80.54%） |
| 最终代码长历史 | Codex 原生 gpt-6-luna，Responses | 0 / 33,693（0%） | 0 / 33,717（0%） |
| 低频长历史，请求间隔 6 秒 | Codex 原生 gpt-6-luna，Responses | 0 / 33,672（0%） | 0 / 33,696（0%） |
| 固定长章节，间隔 6 秒 | Codex 原生 gpt-6-luna，Responses | 4,864 / 34,113（14.26%） | 4,864 / 34,143（14.25%） |

固定长章节组把同一份原书语料作为稳定章节证据，新旧布局使用相同内容。该组两种布局都只在第五轮命中，单次复用约 85%，不能据此报告为六轮约 85% 的命中率。

最终 DeepSeek 优化组逐轮记录：

| 轮次 | input | cached | 复用比例 |
| --- | ---: | ---: | ---: |
| 1 | 5,582 | 0 | 0% |
| 2 | 5,606 | 5,376 | 95.90% |
| 3 | 5,630 | 5,376 | 95.49% |
| 4 | 5,654 | 5,504 | 97.35% |
| 5 | 5,678 | 5,504 | 96.94% |
| 6 | 5,702 | 5,504 | 96.53% |

配置请求型号为 `deepseek-v4-flash`，服务端返回型号为 `deepseek-flash`。OpenAI 请求与响应型号均为 `gpt-6-luna`。

## OpenAI 额外探测与边界

- 原生通道拒绝了显式 `prompt_cache_options`，HTTP 400：`prompt_cache_options is not supported on this model`。该参数没有进入产品代码。
- 单独加入稳定 `prompt_cache_key` 的三个重复请求都未命中；没有把无已测收益的键加进产品。
- 指令角色探测的六个相同请求中有三个命中 4,864 token，单次约 85.7%。这些重复请求不能代替增长历史实验，结果未混入上表。
- 第一组长历史 OpenAI 新旧布局也均为 0%。第一组采用晚插入 `system`，最终代码采用两段 `developer`，分别保留证据。
- API 文档描述的能力与 Codex 原生接口接受的参数存在差别。本轮没有 OpenAI API-key 原生 Responses 的实测，也没有测试每一个 GPT/o 系列型号或旧 DeepSeek 型号。没有估算账单节省，缓存写入/读取计价不应只凭复用比例推算。

## 验证方式

临时 Rust 测试编译原项目代码，直接调用生产 `openai_responses::stream_chat` 与 `openai_compat::stream_chat`。本地转发仅从已有凭据中读取认证并发送到真实服务，未修改生产请求正文；Tauri mock 仅接收输出事件。测试使用隔离语料，不写读者数据库、书籍、API 配置或凭据。

共完成 72 个生产适配器请求及 9 个辅助探测请求，另有一次参数拒绝探测。72 个适配器请求都正确保留固定输出格式、使用本轮上下文，并抵抗用户要求输出冲突格式；最终三组服务端原始 usage 与适配器结果逐项一致。该断言验证指令与上下文仍然生效，不等于完整的阅读回答质量评测。

- AI 相关 Rust 测试：531 passed，3 ignored，0 failed。
- Rust clippy：通过，无告警。
- Rust 格式与 diff 检查：通过。
- 临时测试入口已移出仓库，本地认证转发已关闭；导出证据扫描未发现凭据值。

没有版本升级、打包或发布。需要从包含本次提交的构建运行，已安装的 v2.18.13 不会自动获得代码变化。

## 证据

完整原始 usage、实际请求正文、隔离语料、各阶段结果、源文件 SHA-256 与临时测试入口存放在：

`/Users/lijianwei/.codex/visualizations/2026/10/01/01a0f562-303d-70c1-85a1-26a61dcae835/lantern-cache-optimization/`

`stats.json` 提供聚合数；`wire.jsonl` 提供 81 个已完成真实请求的原始记录；`phase2`、`phase3-paced`、`phase4-chapter` 对应最终代码的三组对照。证据基于本次改动前的 main `8b7743a06453ac882f9dfe929c2e5b5a153bc7cf` 加本文描述的工作区改动。

## 官方资料

- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)：公共前缀、模型门槛、查找边界、路由和参数区别；文档不能替代当前通道的实际 usage。
- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)：前缀缓存与 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)：当前模型在对话中使用 system 的示例。
- [旧 DeepSeek-V3 官方 tokenizer 模板](https://huggingface.co/deepseek-ai/DeepSeek-V3/blob/main/tokenizer_config.json)：系统消息归集行为的边界依据。
