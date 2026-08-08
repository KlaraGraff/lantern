# 用户画像 · 实施计划(第二步:后端)

> 产品形态以 `docs/impls/user-profile-mockup.html`(v6,已拍板)为准,尤其附录甲。
> 本文只写代码级方案。第三步(注入下游 + 真句检索)另起批次;前端页面在后端测试通过后开工。
> 设计依据调研见 `docs/impls/user-profile-research-notes.md`(过程文件,落地后删除)。

## 范围

本批交付:迁移、数据层、Tauri 命令、总结器(含审核请求)、自动分析注册表条目、后端单元测试、i18n 键(zh/en)。
不含:画像注入追问提示词(第三步)、真句检索(第三步)、前端页面(下一批)。

## 1. 迁移 `056_user_profile.sql`

动工前先 `ls src-tauri/migrations/ | tail` 确认 056 未被占用;被占则顺延,不抢号。

```sql
-- 每维度最多一张卡;slot 即主键。行从不物理删除:水位线挂在行上。
CREATE TABLE IF NOT EXISTS profile_cards (
  slot          TEXT PRIMARY KEY,          -- 维度键,见注册表
  conclusion    TEXT NOT NULL,             -- 进提示词;句子自由
  evidence      TEXT NOT NULL DEFAULT '',  -- 不进提示词
  status        TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','moved','deleted')),
  inserted_text TEXT,                      -- 移动时插入用户段的快照,撤回按整段匹配移除
  watermark     INTEGER,                   -- 最后一次删除的时间戳;聚合时过滤 created_at <= watermark
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 原始台账:只增不改,永不进提示词,未来自学习的原料。
CREATE TABLE IF NOT EXISTS profile_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slot       TEXT,                          -- 可空(整份画像级事件)
  event_type TEXT NOT NULL CHECK(event_type IN ('delete','move','undo','rewrite','effect')),
  user_text  TEXT,                          -- 用户改后的说法(rewrite/move 时)
  created_at INTEGER NOT NULL
);

-- 版本留痕:每次总结一条,效果归因的地基(附录乙第 1 条)。
CREATE TABLE IF NOT EXISTS profile_revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cards_before TEXT NOT NULL,               -- JSON:重建前 active 卡全文
  cards_after  TEXT NOT NULL,
  reason       TEXT NOT NULL,               -- 'batch' | 'manual'
  created_at   INTEGER NOT NULL
);
```

用户段文本走 settings KV(不建表):`profile.user_text`、`profile.draft_text`、`profile.enabled`(默认 true)、`profile.soft_limit`(默认 1200)。**硬线永远 = 软线 × 2,派生值,不落库**——存两个值就守不住「倍数关系固定」。

## 2. 维度注册表(代码常量,新模块 `src-tauri/src/commands/profile.rs` 内)

7 个键,写死;每项含:键、数据源、给总结器的定义句、禁区句。展示名走 i18n(`profile.slot.<key>`,zh/en 各自取词,zh 名:词义讲解 / 句法讲解 / 指代讲解 / 文化背景 / 查词取向 / 举例来源 / 回答节奏)。

| 键 | 数据源 | 定义要点 |
|---|---|---|
| `vocab_explain` | followup difficulty=vocabulary | 词义怎么讲:辨析/词源/搭配/例句 |
| `syntax_explain` | difficulty=syntax | 结构怎么拆:顺序、术语量 |
| `reference_explain` | difficulty=reference | 直接给答案还是讲推理 |
| `cultural_context` | difficulty=cultural | 背景深度、与情节关联 |
| `lookup_pattern` | 查词记录 | 查什么类型的词;只描述,不判水平 |
| `example_source` | 阅读历史 | 举例贴近什么题材语体 |
| `reply_pacing` | 追问长度/轮次 | 先给什么、多详尽 |

**禁区(写进定义,审核兜底)**:不得建议解释语言(归 `explanation_mode`);不得给出或暗示 CEFR 水平、词汇量、难度上限(归 `cefr_level` 与水平对照);不得声称引用具体原文。

总结器输出按维度键收,收不进的丢弃;不得发明新维度。

## 3. 裁决层(纯代码,无 AI)

每次总结前对每个维度算派生状态:同维度取 `profile_events` 时间戳最新的显式动作;undo 抵消 move;水位线取最后一次 delete。输出每维度至多一行注入文本。

**删除态措辞用实测校准版(常量,一字不改)**:
「旧结论已删除;下列样本全部晚于删除时间,数据有效,若足以支撑,应当产出全新结论。」
(含糊的「与裁决方向一致」实测 4/4 轮导致删过的维度永久长不出新卡。)

moved / deleted 维度总结器直接跳过——查询排除,不靠提示词自觉。

## 4. 预聚合(SQL/Rust,总结器不读原始记录全文)

- 窗口 90 天,衰减加权与 `level_observation.rs` 同一套算法(读它,复用,不另起炉灶)。
- 每维度门槛:窗口内有效记录 **≥ 5 条**才生成数据块;不足的维度对模型不可见(定义也不给)。
- 追问四维:计数 + 加权计数 + 每维度 ≤ 5 条按新近加权抽样的原文;水位线过滤。
- `lookup_pattern`:计数、词频段分布、重复查询率 + ≤ 15 个按新近加权抽样的词(词是短 token,放宽条数;领域/词性不入库,让模型从样本词自行归纳)。
- `example_source`:近 90 天阅读时长占比前列的书(书名/作者/语言/占比),题材不入库,模型自行归纳。
- `reply_pacing`:追问平均长度、单轮即止占比。**时段类统计(几点用)一律不算不喂**——实测模型会写进结论,价值低观感差。

## 5. 总结器流程(每批整批重建)

1. 触发:`Batch`——上次 revision 之后新分类追问 ≥ 20 条;「立即总结」手动不受限。
2. 组提示词:规则段(实测版措辞,见 v6 样张导语与附录甲)+ 有数据维度的定义 + 派生状态行 + 数据块。上一批结论**不进输入**(无连环压缩)。
3. `AiRequestPurpose::Utility` 请求,输出 JSON `{"cards":[{"slot","conclusion","evidence"}]}`;解析失败重试一次,再失败本批放弃(卡保持原样,记日志)。
4. 字符验收:每卡 ≤ 140、合计 ≤ 1000。超 → 带更严限制整批重生成一次;再超 → 逐卡验收,超长卡拒收新版沿用上一批结论。不截断、不进第三轮。
5. **审核请求(同批第二道 Utility 请求)**:逐卡 keep/reject + 规则编号(R1 语言 / R2 水平 / R3 引用 / R4 无指令价值 / R5 证据脱节)。**引不出合法编号 → 代码判 keep**;reject → 该维度沿用上一批结论。审核请求解析失败 → 全部 keep(审核是兜网,坏不了主流程)。
6. 落库:整批替换 active 卡(moved/deleted 不动),写 `profile_revisions`,move/delete 之外的自动改写记 `profile_events(rewrite)`。
7. 结论语言跟随应用界面语言(locale 传入提示词)。

两道请求的 feature 标签都是 `user_profile`。

## 6. 自动分析注册表

`auto_analysis.rs` `JOBS` 新增一行:id **`user_profile`**,`AutoAnalysisTrigger::Batch`。
**id 必须严格等于 `ai_usage_records.feature` 的标签**——不一致 = 控制台永远显示零花费(有前科,`followup_difficulty.rs` 的 `JOB_ID` 常量是现成范例,照做并加同款测试)。
i18n 四段式:`settings.autoAnalysis.job.user_profile.title / .what / .sends / .offButManual`,zh/en 各自取词,措辞是观察不是诊断;`.sends` 如实写「预聚合统计与少量原文样本」。

## 7. Tauri 命令(`commands/profile.rs`,注册进 lib.rs)

- `profile_get()` → 用户段、全部卡(含 moved 供虚化卡)、字符计数、批次进度(n/20)、开关状态。
- `profile_save_text(text)` → 硬线(软线×2)后端强制;超硬线返回错误,**不截断**;落 `profile.user_text`。
- `profile_save_draft(text)` → 无限制。
- `profile_move_card(slot)` → status=moved、存 `inserted_text`、向 user_text 追加「维度名:结论」、记 events(move)。
- `profile_undo_move(slot)` → status=active;user_text 中能整段匹配 `inserted_text` 则移除,否则不动用户文字;记 events(undo)。
- `profile_delete_card(slot)` → status=deleted、watermark=now、记 events(delete)。
- `profile_delete_all()` → 清 cards/events/revisions 与 `profile.user_text`(唯一动原始画像数据的路径)。
- `profile_summarize_now()` → 手动总结。
- `profile_optimize_text(direction)` → Utility;基础指令 + 方向(包「用户偏好」数据标记,拼在基础指令后、原文前)+ 原文;每次从原文重来;只返回结果,绝不直写。

## 8. 测试清单(`commands/profile/tests.rs` 或同文件 `#[cfg(test)]`)

- 裁决:最新动作胜出;undo 抵消 move;watermark 取最后一次 delete。
- 水位线:聚合排除 `created_at <= watermark`;删除后新数据可重新撑起。
- 门槛:< 5 条的维度不产数据块。
- 验收:超 140 单卡拒收回退上一批;合计超 1000 触发一次重生成。
- 审核:非法/缺失规则编号 → keep;合法 reject → 回退上一批结论。
- 未知维度键丢弃;moved/deleted 维度不被重建。
- 注册表:`user_profile` 在 JOBS 中且 id == feature 标签常量(仿 followup_difficulty 的同款测试)。
- 硬线:save_text 超限报错且原文完好。

## 纪律

- 不 `git add` / 不 `git commit`;改动留在工作区交主会话审查。
- 不动 `followup_difficulty.rs`(上游只读)、`harness/`、`scripts/*.mjs`、`src-tauri/src/mcp/control.rs`。
- 所有用户可见字符串走 i18n;不留英文硬编码。
- 凭据纪律照旧:画像内容不是凭据,进 `lantern.db` 没问题;任何密钥仍归 `secrets.db`。
- 完工后 `cargo check` + `cargo test`(src-tauri)全绿再交。

## 下一批(本文不做)

前端画像页(mockup 状态⓪-⑥)、设置软线条目、自动分析控制台行接线;第三步:注入卡片追问提示词(`user_text` → active 卡 → 冲突以用户为准)与真句检索(附录甲「真句检索」行)。
