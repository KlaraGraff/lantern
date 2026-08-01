# 推理强度、语速控件、TTS 模型列表与免费书源

四处改动的实施计划。已与用户对齐（2026-08-01）。

## 1. 对话模型的推理强度

### 存储

`ai_profiles` 新增两列（migration `029`）：

- `reasoning_effort TEXT` — 空/NULL 表示「默认（不发送）」。
- `reasoning_effort_all_features INTEGER NOT NULL DEFAULT 0` — 关闭时只作用于对话流式路径。

新表 `ai_reasoning_effort_hints`，记录从报错里学到的档位：

```sql
CREATE TABLE ai_reasoning_effort_hints (
  base_url TEXT NOT NULL,
  model    TEXT NOT NULL,
  options  TEXT NOT NULL,     -- JSON 数组
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (base_url, model)
);
```

键是 base_url + 模型：同一网关下不同模型支持的档位不同，只按 URL 记会把 A 模型学到的档位错喂给 B 模型。

### 预设档位

`none / low / medium / high / x-high / max` + 自定义输入。空态文案是「默认（不发送）」，与显式 `none` 区分：

控件是 `ComboField`：输入框永远可直接输入，右侧下拉按来源分组 —— 「该服务端回报」在上、「内置预设」在下，外加一个「默认 · 不发送该参数」的置顶项。下拉下方一行说明这些档位是哪个模型、哪天从报错里学到的，并给一个「清除」入口（`ai_forget_reasoning_effort_options`）。分组是关键：把学到的和内置的混进一个平铺列表，用户就分不清哪些是服务端认可的。

| 状态 | 请求体 |
|---|---|
| 空（默认） | 不带该字段，用服务商默认 |
| `none` | 显式发送，要求不思考 |

**兜底重试必须是「不发送」，不能替换成 `none`** —— 不认 `x-high` 的网关多半也不认 `none`。

### 各通道的线格式

| 通道 | 字段 |
|---|---|
| OpenAI 兼容 chat/completions | 顶层 `reasoning_effort: "<value>"` |
| OpenAI Responses（OAuth） | `reasoning: { effort: "<value>" }` |
| Anthropic | `output_config: { effort: "<value>" }`，取值归一化 `x-high` → `xhigh`；`none` 映射成 `thinking: {type:"disabled"}` |

### 作用范围

`stream_with_failover` / `complete_with_failover` 增加 `purpose: AiRequestPurpose`（`Chat` | `Utility`）。
携带 effort 的条件：`purpose == Chat || profile.reasoning_effort_all_features`。

- `commands/ai.rs` 的对话流式入口传 `Chat`；
- `commands/translation.rs`（划词翻译）与所有 `complete_with_failover`（词汇卡、解读等）传 `Utility`。

### 兜底重试

在每次「一个凭据的一次尝试」里，若发送了 effort 且失败：

1. 先按窄条件判断：`AiErrorKind::Request`（400/422）且错误文本含 `effort` / `reasoning`；
2. 匹配不上但 effort 非空时仍放行一次宽回退；
3. 从错误文本解析 `Supported values are: 'a', 'b'` 之类，写入 hints 表；
4. 把该 profile 的 `reasoning_effort` 置 NULL；
5. 不带该参数重试一次；
6. 发事件 `ai-reasoning-effort-cleared`，前端弹提示。

约束：只在 `emitted == false` 时重试；每次请求最多一次；不能在凭据 failover 循环里被乘一遍。

## 2. 语速

**根因**：`ui/Slider.tsx` 没传 `step`，浏览器默认 `step=1`，而语速区间是 0.5–1.5 —— 整条滑轨只有两个可达值。

- `Slider` 增加 `step?: number`。
- 语速区间改为 **0.5–2**（0 是无效语速），滑条 `step=0.05`。
- 预置按钮：`0.5 / 0.75 / 1 / 1.25 / 1.5 / 2` + 自定义输入框。
- 全局语速标题改为「系统语音语速」，仅作用于 `SpeechSynthesisUtterance`。
- 自定义 TTS 单独一个语速字段 `tts_speed`（0.25–4），随请求发 `speed`；发音缓存 key 带上 speed。
- 词典发音维持原速。

## 3. TTS 模型列表

- 把 router.rs 里的端点拼接 / 大小上限 / 超时 / 解析抽成共用 helper（`ai::models`）。
- 新命令 `speech_list_models`：读 `tts_base_url` + 密钥库里的 key，打 `/v1/models`。
- **不过滤**，与对话卡一致。
- UI 与对话卡对齐：同一个 `ComboField`，输入框 + 下拉 + 刷新按钮，拉到的模型归在「从该服务获取」一组。

### 音色

没有对应的 `/voices` 端点可拉 —— OpenAI 兼容规范里只有 `/v1/models`。所以音色的可选项有两个来源：内置的 OpenAI 音色，以及从合成被拒的报错体里学到的（复用 `parse_supported_values`，存 `speech_voice_hints`，migration `030`）。与推理强度同一套 `ComboField` 分组 + 来源说明 + 清除。

## 4. 免费书源

- 存 settings 表的一段 JSON（`book_sources`），跟着 iCloud 同步；不单开数据表。
- 首次运行播种内置清单（合法源 + 影子图书馆，分组标注），之后可增删改。
- 删掉的不会在升级后自己长回来（`book_sources_seeded` 标记）。
- 「恢复默认」：还原内置那批（补回删掉的、改回被编辑的），用户自加条目不动 —— 靠内置条目的稳定 id 区分。
- 点击一律 `openUrl` 交给系统浏览器。
- 入口：设置侧栏一个分区 + 首页导入区旁边。
