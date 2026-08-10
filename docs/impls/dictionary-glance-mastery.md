# 词典 glance 计入熟练度

单击一个词时菜单顶部弹出的免费词典释义（`dictionary_lookup_word`，有道），今天对熟练度算法完全隐形：不扣分、不进查词历史、甚至不把这一屏标成 lookup-active。对一个主要靠单击查词的读者来说，他最常用的交互对整套评估没有任何输入。

这份方案把它接进去，权重低于 AI 单词卡。

## 1. 判定一次「glance」

一次合格的 glance 需要同时满足：

1. 单击一个**词**（`kind === "word"`），菜单打开，词典**真的返回了词条**——骨架屏不算，「查不到」的空态卡片也不算，计时从真实词条到达那一刻起算；
2. 菜单在词条到达后继续开着 **1.5 秒**；
3. 从打开到关闭，读者**没有点过任何一个菜单动作**（记笔记 / 解释 / 朗读 / 问 AI / 收藏 / 标记 / 复制 / 查看语境解释，键盘快捷键同理）。

第 3 条只有等菜单关闭才知道，所以账是在**菜单关闭那一刻**结的：1.5 秒的计时器只负责把这次点击标成「够资格」，关闭时再检查资格是否还在。菜单一直不关的情况（翻页、关书、切书）由 reader 的既有 force-flush 点兜底。

「点了别的动作就不算」这条是刻意收窄：单击是记笔记、标记、复制的必经之路，把这些都算成查词会让信号变脏。宁可少算。

**唯一的例外是「展开全部 / 收起」**：把词条展开是在读这条释义，正是 glance 本身，不是掉头去做别的事。实现上词典卡的这个按钮带 `data-glance-safe`，菜单里其余带 `role="menuitem"` 的控件（含卡片里那颗发音按钮）一律算作动作。

只有**单击**开出来的菜单（`trigger === "word-menu"`）才可能算 glance。拖选出一个词也会得到同一张卡片，但那个手势不再说明「我停在这个词上」——同样是宁可少算。

**去重**：同一个词在同一个 CFI 位置、60 秒内重复点开只算一次（手滑连点）。换位置、或超过 60 秒后再点，算新的一次。

## 2. 加权查词链

现有的降档阶梯是数次数的（第 1 次降一档、第 2 次回 learning、第 3 次起标拦路词）。改成累加权重：

| 动作 | 权重 |
| --- | --- |
| AI 单词卡「解释」 | 1.0 |
| 词典 glance | 0.5 |

7 天窗口内累计权重：

| 累计 | 结果 |
| --- | --- |
| ≥ 1.0 | 降一档（`lookup_demotion`） |
| ≥ 2.0 | 打回 learning（`repeat_lookup_demotion`） |
| ≥ 3.0 | 标记为这本书的拦路词（`is_book_blocker`） |

这是纯粹的推广，不是行为改动：只用 AI 卡的读者，1.0 / 2.0 / 3.0 恰好等于原来的第 1 / 2 / 3 次，一个数都没动。所有既有测试应当原样通过。

**每档只在「跨过」的那一次收费**，不是「站在档上就收」。原来每次查词都恰好重 1.0，永远踩在整档上，两种说法没区别；有了半档的 glance 就有区别了：一张卡（1.0）之后再一次 glance 累到 1.5，如果按「≥1.0 就降一档」，这一步会再降一档——一卡一词典的代价等于两张卡，正好抹掉加权本身要表达的东西。所以判定是 `之前 < 档位 ≤ 现在`。

按这条规则，只 glance 的读者是第 2 次降一档（1.0）、第 4 次回 learning（2.0）、第 6 次成拦路词（3.0）；夹在中间的第 1、3、5 次只扣 credit，不动档位。

**credit**：统一成 `credit *= (1 - 权重)`。AI 卡权重 1.0 即清零（和今天一致），glance 砍半。credit 是「读者认识这个词」的证据，glance 是半句反驳。同一个词在多本书里的多行各自按自己的 credit 打折——卡片乘 0 的时候这个区别不存在，砍半就存在了。

**为什么不存 REAL 权重列**：窗口内的两个计数（卡片次数、glance 次数）本来就要存——词详情页那句解释要把两种查法分开说。权重是它们的函数（`cards + 0.5 * glances`），再存一列 REAL 就是可以漂移的冗余状态。

## 3. 进观察区

今天词是靠「第一次 AI 查词」进 `vocab_words` 的（`observe_lookup_for_vocab`，建行时 `list_status = 'watchlist'`）。没进去的词根本不在熟练度体系里，所以只 glance 从不开卡的词，改了阶梯也接不上。

规则：同一个词在同一本书里攒够 **4 次**合格 glance，收进观察区。

- **终身累计**，不设窗口。这个计数问的是「这个词是不是反复绊住你」，不是「你最近一周是不是卡住了」；而且它唯一的后果是收词进观察区，收错代价极小、漏收才是损失。
- 建行落 **learning**，不是 new。`new` 的语义是「从没被评估过」，一个被看了四回的词显然不是。这也和 AI 卡那条路径的结果对齐（第一次查词 → 建行 new → 立刻降档 → 落 learning）。实现上同样走「建行 new + `set_auto_mastery` 迁到 learning」，这样时间线和解释句子都由既有机制产出。
- 4 次只是**入场门槛**。词一旦在列表里，之后每一次合格 glance 都立刻按 0.5 计入权重链，不再需要凑数。
- 词已经在列表里（不论是 watchlist 还是 confirmed）时，glance 不改 `list_status`——升 confirmed 仍然是 `lookup_records` 那条既有规则的事。

## 4. 不进查词历史

glance 不写 `lookup_records`。那张表的每一行都对应一张能点开重看的卡片，glance 没有卡片，塞进去会让历史列表和导出里出现一半点不开的行。

glance 记在一张本机小表 `dictionary_glances` 里，聚合成 (book, word) 一行，不发同步事件——和 `reading_word_exposures` / `mastery_progress` / `mastery_events` 同样是设备本地的派生数据。

## 5. 屏幕 lookup-active

一次合格 glance 同时调 `recordReadingOperation("lookup", normalizedWord)`，和 AI 卡完全一样：

- 这一屏标成 lookup-active，屏上**其他**词拿 1.5× 加成；
- 被 glance 的词自己进 `lookedUpWords`，不吃自己的加成。

1.5× 那条规则的依据是「读者在逐词处理这一屏」，glance 证明的正是同一件事，和查词的轻重无关，所以给满。

这一条其实独立于扣分，是个单独的漏修。

## 6. 数据结构

迁移 069：

```sql
-- 窗口内的 glance 次数，和既有的 lookups_in_window（卡片次数）并列。
-- 权重由两者算出，不单独存。
ALTER TABLE mastery_progress
  ADD COLUMN glances_in_window INTEGER NOT NULL DEFAULT 0 CHECK(glances_in_window >= 0);

-- 终身 glance 台账，(book, word) 一行。设备本地，不同步。
CREATE TABLE dictionary_glances (
    book_id          TEXT NOT NULL,
    normalized_word  TEXT NOT NULL,
    glance_count     INTEGER NOT NULL DEFAULT 0 CHECK(glance_count >= 0),
    first_glanced_at INTEGER NOT NULL,
    last_glanced_at  INTEGER NOT NULL,
    last_cfi         TEXT,          -- 60 秒去重要比对的位置
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (book_id, normalized_word)
);
```

## 7. 文案

`vocab_words.mastery_reason` 的 detail JSON 增加 `glance_count`。句子按「这次降档背后是哪几种查法」分三种写：

- 只有卡片：沿用今天的句子，一字不改
- 只有词典：「你在《X》里查了 {n} 次词典，所以退回了一档。」
- 两种都有：「你在《X》里查了 {c} 次卡片、{g} 次词典，所以退回了一档。」

新增 reason code `glance_entry`：「你在《X》里查了 {n} 次词典，已经把它收进观察区。」

变体选择放在 `mastery-explanation.ts` 里（纯函数，可单测），不放在组件里。

## 8. 复习堆与校准系数

这两处原本列为「本轮不做」，随后一起补上了。它们和第 2 节的半档权重不是同一个问题，权重也不同——理由见下。

**拦路词复习堆**（`review_piles::repeat_lookups_piles`）现在把 `lookup_records` 和 `dictionary_glances` 用一个 `UNION ALL` 子查询合起来按 (book, word) 聚合，门槛是权重 **2.0**：两张卡、或一卡两词典、或四次词典。这对只开卡的读者是恒等变换——原来的「查了不止一次」就是 2.0——所以既有的堆一个成员都没变。2.0 也不是新造的数：它正是阶梯上「打回 learning」那一档，堆的一句话来由因此还是一句话。SQL 里写成 `SUM(cards) * 2 + SUM(glances) >= 4`，同一个不等式，整数算术，`HAVING` 里不出现浮点。

堆的时间戳取两个来源的 `MAX`。单词堆的文案要把两种查法分开说，所以 `RepeatLookupsInBook` 带出 `solo_word_lookups` / `solo_word_glances` 两个字段，前端按「只有卡片 / 只有词典 / 两种都有」选三句话中的一句——和第 7 节词详情页的分法一致。四次翻词典不能叫「你查了它四次」。多词那句原来的结尾「不是随手一查」也跟着删了：一个纯由词典查询攒出来的堆，那半句是在否定它自己。

**校准系数**（`calibration::lookup_rate_scale`）的分子改成卡片次数 + glance 次数，glance 按**满权重**计，不是 0.5。这不是不一致，是两个不同的问题：阶梯问的是「这次停顿有多说明他不认识这个词」，一次免费查词的证明力只有半张卡；而 lookup rate 问的是「这个读者读得有多细」，停下来翻词典和停下来开卡片，在这个问题上是一回事。同一条原则也解释了第 5 节为什么给满。
