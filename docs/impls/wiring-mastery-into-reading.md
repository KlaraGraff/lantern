# 把掌握度引擎接进阅读流程

`src-tauri/src/mastery/mod.rs` 是一个没有调用者的纯函数。数据在
（037 的 `reading_screen_dwells` / `reading_word_exposures`，038 的
`mastery_source` / `mastery_reason` / `mastery_events`），算法在，中间那段
SQL 不在。这份文档只覆盖那一段，外加正文标注跟掌握度挂钩。

设计依据：`docs/impls/reading-driven-mastery-and-review.md` §2、§3。

---

## 一、缺的是什么

| 已有 | 缺 |
|---|---|
| 每屏 dwell / operation / lookup 计数写入 | 「这一屏读得太快」的排除（§2.4 第 1 条）从来没应用过 |
| 每 (书, 章, 词) 的曝光累计 | 没有任何东西把曝光换成学分 |
| `apply_exposures` / `apply_lookup` | 没有调用者 |
| `vocab_words.mastery` + `mastery_events` | 只有手动路径写它们 |
| 被动标注（ruby / margin，密度 25/50/100%） | 跟掌握度无关，纯装饰 |

## 二、水位线：为什么需要迁移 039

`reading_word_exposures` 是**累计**表——`encounter_count` 只增不减。评分跑一次
就得知道「这一行我已经算到第几次曝光了」，否则每跑一次都会把同一批曝光重算一遍，
词会一路飘到 mastered。

所以加两列水位：

```sql
ALTER TABLE reading_word_exposures ADD COLUMN scored_encounter_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reading_word_exposures ADD COLUMN scored_lookup_active_count INTEGER NOT NULL DEFAULT 0;
```

一次评分处理的就是 `encounter_count - scored_encounter_count` 这个差额，
`chapter_occurrence` 从 `scored_encounter_count + 1` 数起——这正是 §2.2 递减权重
要的「第几次」，而且跨多次评分仍然连续。

`encounters_on_lookup_active_screen` 同样是累计值，我们无法知道差额里**具体哪几次**
是「查词活跃屏」。把 1.5x 加成分给差额里**最靠前**的几次（权重最高的那几次）。
边界一律偏向读者，这是 §2.4 已经定下的规矩；而且章节上限 2.0 兜着，加成再靠前也
翻不了天。

### `WordState` 的另外三个字段存哪

`credit` / `last_lookup_at_ms` / `lookups_in_window` 是中间算术，不是结论。
它们进一张**设备本地**表，理由跟 037 的曝光表、038 的 `mastery_events` 一样：
这些数字是从**这台设备的阅读行为**推出来的。

```sql
CREATE TABLE mastery_progress (
  vocab_word_id TEXT PRIMARY KEY REFERENCES vocab_words(id) ON DELETE CASCADE,
  credit REAL NOT NULL DEFAULT 0,
  last_lookup_at INTEGER,
  lookups_in_window INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
```

档位和那句「为什么」照旧同步（038 已经说清为什么它们不能只在本机）；
推出档位的那笔账不同步。

## 三、「读得太快」排除放在写入端

`reading_word_exposures` 是聚合表，聚合之后没有任何办法知道某一次曝光来自哪一屏、
那一屏多快。而写入端手里正好有 `word_count` 和 `dwell_ms`。

所以跟「闲置屏」完全一样，这条排除也在 `record_reading_behavior_batch_inner` 里应用：
太快的屏，dwell 行照记（§5.1 的速度信号还要用），词不折进曝光表。

基线取该读者最近 `MEDIAN_PACE_SAMPLE` 屏的中位数，不是全历史——中位数只需要一张
稳定的画像，不需要把三年前的阅读也算进来，而且这让它的成本与库容无关。
没有可用样本时不跑这条排除（`median_words_per_minute` 返回 `None`），
不是当成 0。

评分侧因此传 `reader_median_wpm: None`：两条排除都已在上游生效，
下游再跑一遍只会用错的粒度重复排除。

## 四、上行：什么时候跑评分

跟在 `record_reading_behavior_batch_inner` 后面，同一个事务里。理由：

- 它只碰有差额的行，而且要 join 到 `vocab_words`——只有存进生词表的词才有档位可动。
  一次批量就是一到几屏，代价是常数级的。
- 读者在正文里看到标注褪去，跟他读到那一页应该是同一时刻的事。
  攒到关书再算，标注就永远慢一步。

**没有对应生词行的曝光，水位照样推进。**掌握度是关于读者存下来的词的，
没存的词没有地方放档位。留着不推进，等这个词哪天被查、被存进生词表时，
历史曝光会一次性灌进来把它直接顶到 familiar——而它刚刚才被查过。

匹配用 Rust 的 `normalize()`（`lookup_history.rs`：两端去掉非字母数字、转小写），
不是 SQL 的 `LOWER(TRIM())`——两者对 `"quiet,"` 的结果不一样。
一本书的生词量是几百，Rust 侧建 map 完全够。

## 五、下行：查词降级

`save_lookup_record` 里，查完之后：若 (book_id, normalize(lookup_text)) 命中一条
`vocab_words`，就跑 `apply_lookup`，写回档位、`mastery_source='auto'`、
`mastery_reason`，以及 `mastery_events` 一行。

顺序很重要：**先降级，后评分**。同一屏里读者查了这个词，就不该同时因为「在这屏见过它」
拿学分。查词把 credit 清零，正是 §2.3 要的。

## 六、正文标注三阶段（§3）

| 阶段 | 档位 | 正文里 |
|---|---|---|
| 刚查过 | `new` / `learning` | 释义直接挂在旁边（现有 ruby / margin） |
| 熟一点 | `familiar` | 释义收起，只留一个很小的记号，点一下才看 |
| 真的熟了 | `mastered` | 什么都没有，正文干净 |

「第一阶段挂多久」由档位决定，不设固定天数——引擎推着它走，正文自己就是进度条。

密度设置从「标全部候选的 25/50/100%」改成**一屏最多标几个**的上限，满了按
「最该标的」取前几个（现有的 `passiveVocabLearningPriority` 就是这个排序，
只需要把 familiar 排在 learning/new 之后、mastered 直接出局）。

阶段二的那个小记号是新的视觉设计，**先出单文件样张再实现**。

## 七、提交划分

1. 迁移 039 + 评分通道 + 写入端的「太快」排除（上行）
2. 查词降级（下行）
3. 样张 → 正文标注三阶段 + 密度改上限（前端）
