# 词卷并入单词复习板块 — 实现计划

> 状态：待拍板。词卷源码快照在 `labs/cijuan/`（提交 5f15860），合并完成后整目录删除。
> 词卷自身的产品决策记录在 `labs/cijuan/docs/decisions.md`，本计划不改动其核心机制
> （考点约束、遮词自检、错词 +2/+7、溯源、讲解口径），只改它的宿主与管道。

## 一、调研结论（两侧现状）

### 词卷侧：什么能搬、什么必须换

| 资产 | 文件 | 去向 |
| --- | --- | --- |
| 提示词（考点约束/讲解口径，核心资产） | `llm/prompts.ts` | **原样迁移**（纯 TS，中文口径） |
| 结构化输出 schema | `llm/schemas.ts`（zod） | **原样迁移**，Lantern 需新增 zod 依赖（小、无传递依赖） |
| 拆词/词表解析 | `llm/split.ts` | 原样迁移 |
| 生成编排（分组并发、遮词自检、覆盖校验） | `llm/generate.ts` | 迁移，仅换掉传输层调用 |
| 语法判分（本地比对 + LLM 裁决变体） | `llm/judge.ts` | 迁移，同上 |
| 判分纯函数 | `store/grading.ts` | 原样迁移 |
| 演示样卷 | `llm/mock.ts` | 迁移，仅供测试用（见拍板点 D） |
| **LLM 传输层** | `llm/client.ts` | **丢弃**。浏览器直连（Anthropic 浏览器 SDK + fetch SSE + dev CORS 代理）整层不要，改走 Tauri 后端 |
| **服务商目录/设置/定价** | `llm/providers.ts`、`llm/pricing.ts`、`ui/SettingsModal.tsx`、`store/settings.ts` | **丢弃**。复用 Lantern 现成的 ai_profiles + secrets.db + 故障切换 + 用量统计 |
| **存储层** | `store/db.ts`、`store/quizzes.ts`（Dexie/IndexedDB） | **丢弃**，换 SQLite 表 + Tauri command |
| **错词调度器** | `store/scheduler.ts` | **移植到 Rust**（偏离既定思路，理由见 §二.3） |
| UI 五屏 | `ui/*.tsx` | 按既定思路不迁移，照样张重做 |
| 测试（47 个，vitest） | `*.test.ts` | 移植：纯 TS 部分转 `node --test`（Lantern 惯例），调度器部分转 Rust 单测 |

### Lantern 侧：接入面

- 复习板块 = 侧栏「生词」筛选 → `DictionaryContent.tsx` 大面板（词表 + 回顾板 `ReviewBoard` + 内联 FSRS 翻卡）。**现无任何测验/AI 出题形态**，词卷是新增能力，不与翻卡冲突。
- AI 管道：前端零直连，全部 `invoke()` + 按请求命名的事件通道；后端 reqwest，Anthropic / OpenAI-compat / OAuth 三通道，带多凭据故障切换。非流式调用有现成收集器 `complete_with_failover`。
- 结构化输出：后端无原生 JSON-schema 支持，惯例是「提示词内嵌 JSON 形状 + Rust/前端解析容错」（learning_card、xray 先例）。`anthropic.rs` 的 `output_config` 目前只接 effort。
- `AiPanel` 与阅读器强耦合（bookId/章节/选区 props），不能直接当追问抽屉用；可复用的是底下的积木（`MessageBubble`、`ai-markdown`、`ai_chat` command）。
- 生词复习数据：`vocab_words`（FSRS 字段）+ `vocab_review_log`（追加式），调度在 Rust（`fsrs` crate）。
- 测试：前端 `node --experimental-strip-types --test`，无 vitest、无 zod。

## 二、方案要点（技术归我，已定，偏离既定思路处给理由）

### 1. LLM 通道：TS 编排保留，传输换成一条通用后端 command

新增后端 command（如 `ai_complete_text`）：入参 prompt/system/max_tokens，内部走
`complete_with_failover`（复用现有 profile 路由、故障切换、用量统计），一次性返回全文。
前端 `llm/transport.ts` 替代原 `client.ts`：schema 内嵌提示词（词卷兼容通道的原做法，
也是 Lantern 惯例）→ 后端拿全文 → 前端 zod 校验 + `extractJson` 容错。

**为什么不把提示词和编排搬进 Rust**（learning_card 模式）：`prompts.ts` + `generate.ts`
是最大的可迁移资产（考点约束的全部细节），改写成 Rust 等于重写并丢掉 47 个测试的保护；
编排（分组并发、遮词自检一轮止损）在 TS 里已被测试护住。后端只做哑管道，风险最小。

**代价**：Anthropic 通道从原生结构化输出（`output_config.format`）退化为提示词内嵌
schema。词卷的兼容通道（DeepSeek 等）本来就这么跑且稳定；若实测 Anthropic 通道解析
失败率明显，再给 `anthropic.rs` 补原生 format 支持（独立小改动，不阻塞主线）。

### 2. 数据：SQLite 两张新表，正文走 JSON 列

```sql
-- 071_quiz_papers.sql（编号以实际为准）
CREATE TABLE quiz_papers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','submitted')),
  config_json TEXT NOT NULL,      -- QuizConfig（含 demo 标记）
  words_json TEXT NOT NULL,       -- QuizWord[]（word + origin）
  content_json TEXT NOT NULL,     -- passages + readingQuestions + grammarQuestions
  result_json TEXT,               -- QuizResult，交卷后写入
  ask_threads_json TEXT           -- AskThread[]，随卷保存（沿用词卷的轻量设计）
);
CREATE TABLE quiz_wrong_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,      -- 统一小写存
  wrong_count INTEGER NOT NULL,
  first_wrong_at TEXT NOT NULL,
  last_wrong_at TEXT NOT NULL,
  stage INTEGER NOT NULL,         -- 0 | 1
  next_due_at TEXT,               -- cleared 后为 NULL
  cleared INTEGER NOT NULL DEFAULT 0
);
```

卷面正文用 JSON 列而非拆表：整卷始终整读整写，无跨卷查询需求（learning_card 的
`result_json` 先例）；错词池拆成实表，因为要按 `next_due_at`、`cleared` 查询。

### 3. 错词调度器移植到 Rust（偏离「store/ 作为纯 TS 资产」的既定思路）

交卷 = 「写判分结果 + 推进错词池状态机」，必须在一个事务里且幂等（词卷原实现就是
Dexie 事务 + 已交卷直接返回）。把这段逻辑留在 TS 意味着前端算好效果再发后端应用，
事务边界和幂等检查被拆到两边。Lantern 的惯例也是调度归 Rust（FSRS 先例）。状态机
只有 90 行，移植成本低；256 行的调度器测试改写为 Rust 单测，覆盖不降。

### 4. 追问抽屉：不复用 AiPanel 本体，复用积木

新建轻量 `QuizAskPanel`：选中卷面文字 → 建 AskThread（quote/quoteFrom/context 沿用
词卷类型）→ 走现有 `ai_chat` 流式通道 → `MessageBubble` + `ai-markdown` 渲染 →
线程随卷存 `ask_threads_json`。不进 Lantern 的聊天历史（词卷的既定轻量设计）。

### 5. 与现有复习体系的边界（v1）

错词池（考没考过）与 FSRS（记忆曲线）是两套目标不同的调度，v1 **互不写入**：
词卷交卷不动 `vocab_words`/`vocab_review_log`，翻卡复习不动 `quiz_wrong_words`。
联动（生词本导词、错词写回 FSRS）见拍板点 B，默认后置为独立 feature spec。

### 6. 杂项

- zod 加入 Lantern 依赖（schemas 的运行时校验必需，且是唯一新增依赖）。
- 词卷 UI 文案全部硬编码中文 → 新 UI 按 Lantern 规范走 i18n（en/zh 双份）。
  卷面内容（讲解、翻译）是 AI 生成的中文内容，不属 UI 文案，不进 i18n。
- 出题设置（难度/题型/遮词自检）进 Lantern `settings` 表（`useSettings` 惯例）。
- `pricing.ts` 不迁移：Lantern 已有用量统计，不再单独估价。

## 三、分步计划与验收

| 步骤 | 内容 | 验收条件 | 拍板 |
| --- | --- | --- | --- |
| 0 | 本方案 | 用户认可方向 + 拍板点 A–D | ✅ 需拍板 |
| 1 | 静态样张：词卷区在 Lantern 视觉体系下的全部关键屏（入口/出卷设置/生成中/做题/评卷/错词池/历史/追问抽屉，含空态、失败态、交卷确认） | 用户逐屏认可（样张一次全给，不分批） | ✅ 需拍板 |
| 2 | Rust 后端：迁移 071、试卷 CRUD、交卷事务（含调度状态机移植 + 幂等 + demo 卷不入池）、错词池查询、`ai_complete_text` | `cargo test` 绿（调度器测试全量移植）；`cargo check` 后提交 | 否 |
| 3 | TS 核心迁移：`llm/`（除 client）+ grading 入 `src/`，transport 换 Tauri 通道，zod 入依赖，纯 TS 测试转 `node --test` | `npm run test:unit` 绿、`npm run build` 绿 | 否 |
| 4 | UI 实现（按已批样张）+ i18n 双语 + 接入复习板块入口 | build 绿 + 提交前独立审查代理过 diff + 用户验产品行为 | ✅ 产品验收 |
| 5 | 收尾：删除 `labs/cijuan/`、本计划归档 `docs/impls/archive/`、（如拍板 C 选导入）一次性导入工具 | 仓库无 cijuan 残留引用（`git grep cijuan` 干净）、CI 绿 | 否 |

步骤 2/3 可并行（数据契约 `types.ts` 先定）。全程不触碰 iOS 会话领域
（`Reader.tsx`、`useReaderInteractions.ts`、`tap-zones`）；共同接触面仅
`DictionaryContent.tsx` 入口一处，实现时再核对工作树。

## 四、拍板点（每条已附推荐）

- **A. 入口形态**——推荐：词卷作为复习板块内的新标签页/入口，做题与评卷全屏
  （沉浸任务，不适合挤在面板里）。样张会同时给「面板内嵌」与「全屏」两种做题形态供比对。
- **B. 与生词本/FSRS 的联动**——推荐：v1 不联动，保持词卷「粘贴当天的词」的原始形态；
  「从生词本导入到期词」「错词写回 FSRS」各立 feature spec 后置。理由：联动改变两套
  调度的语义，值得单独设计，不该搭车。
- **C. 独立版旧数据**——推荐：不迁移（浏览器 IndexedDB 里的历史卷与错词池弃用，
  Lantern 里从零开始）。若错词池数据有留存价值，可加一次性 JSON 导入（半天内）。
- **D. 演示模式**——推荐：`mock.ts` 只留给自动化测试，设置里不再暴露「演示模式」开关
  （Lantern 用户已有配好的 AI 线路，无 key 体验场景消失）。
