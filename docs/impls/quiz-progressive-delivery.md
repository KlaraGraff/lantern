# 词卷渐进发卷（Progressive Paper Delivery）

> 前置：按篇流水线重构已落地（e2f5ce7，`docs/impls/` 相关说明见 `src/quiz/generate.ts` 顶注）。
> 本方案在其上实现「首篇就绪即进卷」：第 1 篇文章过完校验就建卷、跳转做题页，
> 其余文章后台继续生成、完成一篇亮一篇。样张已由用户豁免，方案文档不豁免。

## 一、产品行为（已与用户对齐的拍板）

1. **并行生成不变**。不是串联——串联会把总时长拉到 20–30 分钟。变化只在「什么时候把卷交到用户手上」。
2. **首篇就绪即进卷**：任一篇文章走完它的流水线（写稿→校验→重出）即建卷落库、立刻跳转做题页。首题可做时间从全卷 ~8 分钟缩到单篇 ~5 分钟。
3. **按篇序解锁**：第 N 篇可做的条件是第 1..N 篇都已生成完。第 2 篇先做完也等第 1 篇——篇号稳定，符合做卷习惯。已就绪但被前篇挡住的篇显示「已就绪，待前篇开放」。
4. **未就绪篇的占位**：做题页的文章页签保留全部篇位，未完成的篇显示当前流水线阶段（写稿中/校验中/重出中）——相当于把生成中屏的按篇行嵌进做题页。
5. **失败按篇隔离**（语义变更）：某篇写稿失败只标记该篇为「没生成成」，可单篇重新生成；其余篇不受影响。旧的「一篇失败整卷作废 + abort 共享闸」随之删除——那道闸的存在理由（不给注定作废的卷烧钱）已消失，每一篇现在都独立有价值。全部篇都失败时退回旧行为：不建卷、生成失败屏。
6. **中断可续**：卷子在首篇就绪时就已落库；生成中途退出 App，历史里留下一张「未生成完」的卷，进入后未完成的篇提供「继续生成」。
7. **错词池覆盖结算改为按篇**：每篇完成时，把该篇实际考到的词并入卷面词表（words_json）；没被考到的词照旧剔除。未完成篇的词不进词表——交卷（结算错词池与 FSRS）只在全卷就绪后允许，语义与现状一致。
8. **交卷门**：status 为 generating 期间交卷按钮禁用（带提示文案）；后端同样拒绝（防御）。

**遗留的产品问题（不阻塞本次）**：某篇反复重生成失败时，用户没有「放弃这篇、按短卷交卷」的出口，卷子会一直停在未生成完。当前判断：失败多为瞬时或设置类（可修复后重试），先不做放弃出口；若实测中成为真实卡点再拍板。

## 二、数据模型

### 迁移 072（重建 quiz_papers）

SQLite 不能改 CHECK 约束，按标准 12 步重建：

- `status` CHECK 扩为 `('generating','ready','submitted')`
- 新列 `generation_json TEXT`（NULL = 非渐进卷或已生成完）

`generation_json` 由前端独占读写（与 config/words/content 三列同一契约，见 paper-io.ts 顶注）：

```jsonc
{
  "groups": [
    {
      "words": [{ "word": "subsidy", "origin": "today" }],  // 拆词时定死，篇号=数组下标
      "state": "pending" | "failed" | "done",
      "passageId": "psg-...",        // done 时回填，把篇位映射到 content 里的文章
      "errorCode": "AI_PROFILE_..."  // failed 且能识别出 AI 错误码时
    }
  ]
}
```

- 建卷时写入全部组（首篇标 done，其余 pending/failed）。
- 每篇完成/失败都更新一次。全部 done → status 置 'ready'、generation_json 清 NULL——就绪卷与旧数据形状完全一致，下游零改动。
- 重启后 pending 与 failed 同等对待：都不在跑（内存会话已死），都给「继续生成」。

### 后端命令（src-tauri/src/commands/quiz.rs）

- `create_quiz_paper` 增参 `status: String`（校验 ∈ generating/ready）、`generation_json: Option<String>`。唯一调用方是前端，无兼容包袱（仓库纪律：不留 legacy shim）。
- 新增 `update_quiz_paper_generation(id, content_json, words_json, status, generation_json)`：一条 UPDATE 同时推进四列；status 校验同上；行不存在报 QUIZ_PAPER_NOT_FOUND；当前行已是 submitted 时拒绝（QUIZ_PAPER_ALREADY_SUBMITTED，防御性——正常流程到不了）。
- `submit_quiz_paper_inner` 增门：status == 'generating' → QUIZ_PAPER_NOT_READY。
- `QuizPaperRow`/`PAPER_COLS`/`row_to_paper` 带上 generation_json。
- Rust 单测先行：建 generating 卷、update 推进到 ready 并清列、update 拒绝 submitted 卷、submit 拒绝 generating 卷、迁移后旧行 status 不变。

## 三、生成层（src/quiz/generate.ts）

- `runArticlePipeline` 不再向外抛写稿异常：产出统一为

  ```ts
  interface ArticleOutcome {
    index: number
    words: QuizWord[]            // 该组词（结算与重生成都要）
    ok: boolean                  // 写稿异常或模型没给文章 → false
    errorCode: AiErrorCode | null
    passage / trace / readingQuestions / grammarQuestions  // ok 时有值
  }
  ```

- 共享 abort 闸整体删除（含两处 `!abort.aborted` 门与 hook 里的整体 cancel 循环）。
- `generateQuiz` 增可选回调 `onArticle?: (outcome: ArticleOutcome) => void`——每条流水线 settle 即回调（发卷编排靠它逐篇落库）；返回值增 `articles: ArticleOutcome[]`。全部组都失败时仍 reject（保留生成失败屏路径），否则 resolve，quiz 只装 ok 篇、覆盖过滤只对 ok 篇的词做。
- 进度事件 `ArticleStep` 增 `'failed'`（生成中屏与做题页占位共用）。
- 导出 `generateArticle`（单组流水线，供「继续生成/单篇重生成」复用同一段代码）。
- 测试：abort 测试改写为按篇隔离测试（组 1 写稿失败、组 2 照常完成并照常校验）；新增全败 reject 测试、onArticle 回调测试；并发/多组/事件序测试随新事件形状微调。

## 四、发卷会话（新模块 src/pages/quiz/generation-session.ts）

照 explanation-session.ts 的模块级单例样式（跨路由存活、useSyncExternalStore 订阅），职责：

1. **编排**：`startGenerationSession({words, config, profileId})` 调 `generateQuiz`，把进度事件聚合成会话状态（stage/按篇 step/paperId/error）。
2. **单写者**：一张卷的所有 DB 写（create / update_quiz_paper_generation / 解析写回）串在会话内部的 promise 链上，天然避免「解析写回的旧快照覆盖掉后落的新篇」竞态。会话内存里持有权威 Quiz，每次写库前先合并进它。
3. **逐篇落库**：首个 ok 篇 → `create_quiz_paper`（若此刻全组已 done 则直接建 ready 卷——单篇卷自动退化为旧行为）；后续篇 → 按组序插入权威 Quiz（篇序=组序，与解锁规则一致）→ `update_quiz_paper_generation`；失败篇 → 更新 generation_json。
4. **逐篇起解析**：每篇落库后立刻用该篇的 trace 起 `runExplanationSession({onlyPassageIds:[该篇]})`——正好在缓存时效内。因 explanation-session 有同卷 running 互斥，逐篇调用串成链；`persist` 注入为「合并进权威 Quiz 再写」的会话写链。
5. **取消**：仅在建卷前有意义（生成中屏的取消按钮）；置 cancelled 标志 + 逐 id cancelRequest；写链里 create 前自查 cancelled，杜绝「取消瞬间还是建了卷」的竞态。建卷后即跳转，无取消入口。
6. **继续生成/单篇重生成**：`regenerateArticles(quiz, groupIndexes, profileId)`——对每个组跑 `generateArticle`，复用同一条落库/解析链。重启后的冷启动场景由做题页从 generation_json 发起，与热路径同代码。
7. 会话状态带 `revision`（每次写库成功 +1），做题页据此静默重拉。

`useQuizGeneration` 瘦身成会话订阅器（对 Quiz.tsx 的返回形状不变）：paperId 出现 → navigate；错误态/取消照旧。

## 五、做题页（TakeView / useQuizPaper / QuizPaper）

- `Quiz` 类型：`QuizStatus` 增 `'generating'`；增可选 `generation?: { groups: [...] }`（rowToQuiz 从 generation_json 解析）。
- `useQuizPaper`：订阅 generation session（照抄 explanation session 的订阅样式）；revision 变化与 running 翻转 → `load({silent:true})`（沿用 snapshotSeqRef 最新者胜，不打断作答中的 TakeView）。
- TakeView（status==='generating' 且有 generation 时）：
  - 页签按组序全量占位：就绪且前篇全就绪 → 正常页签；就绪但被挡 → 锁定页签，内容区「待前篇开放」面板；生成中 → 页签带阶段徽标，内容区进度面板；失败/中断 → 内容区失败面板 + 「重新生成」按钮（调会话 regenerateArticles）。
  - 交卷按钮禁用 + 提示；题数统计只算已开放篇。
- HistoryTab / useQuizHistory：generating 卷显示「生成中/未生成完」chip（有活会话在跑用前者）；「未交完的卷」横幅口径改为 status !== 'submitted'。
- 文案全部走 i18n 双语，含复数键 `_one/_other` 惯例；不出现任何催促/责备语气（复习文案红线）。

## 六、分步落 main

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | 本方案文档 | — |
| 2 | 迁移 072 + quiz.rs 命令与门 + Rust 单测 | cargo test 绿 |
| 3 | generate.ts 按篇产出/失败隔离 + TS 测试改写 | vitest 绿 |
| 4 | generation-session + useQuizGeneration 瘦身 + Quiz.tsx/GeneratingScreen | tsc/vitest/eslint 绿 |
| 5 | 做题页渐进 UI + useQuizPaper 订阅 + History + i18n | tsc/vitest/eslint 绿 |
| 6 | AI 互审 + 修复 | 审查通过 |

## 七、Figma 设计提示（存档用，样张已豁免）

- 做题页页签行：N 个文章页签 + 语法页签；状态变体——正常 / 锁定（锁形图标+灰字）/ 生成中（小转轮+阶段词）/ 失败（警示色圆点）。
- 未就绪篇内容面板：居中竖排——阶段图标、一句状态文案、（失败态）错误说明与「重新生成」主按钮。基调平静，无进度百分比、无倒计时。
- 历史列表行：未生成完卷的 chip 与「未交卷」chip 同形不同文案。
