# 上下文行对关键词检索的实测

《傲慢与偏见》，642 个 chunk，写出定位句 642 条，模型返回不可用 0 条，调用失败跳过 0 条（留待下一轮补）。

对照方式：同一个索引、同一批数据，唯一的差别是 `MATCH` 允不允许看 `seg_context` 这一列。「改前」把匹配限制在正文列上，等价于这一列不存在。查询里从不含 gold 短语。

| 查询 | 类型 | 改前 | 改后 |
|---|---|---|---|
| Darcy proposes to Elizabeth for the first time and she turns him down | pronoun | 未进前 50 | 未进前 50 |
| Elizabeth realises she was wrong about Wickham after reading the letter | pronoun | 未进前 50 | 未进前 50 |
| Mr Collins asks Elizabeth to marry him | pronoun | #3 | #4 |
| Lady Catherine confronts Elizabeth about her engagement to Darcy | pronoun | 未进前 50 | 未进前 50 |
| Elizabeth sees the grounds of Pemberley for the first time | pronoun | #4 | #4 |
| Darcy proposes a second time and Elizabeth accepts him | pronoun | 未进前 50 | #10 |
| Darcy refuses to dance with Elizabeth at the assembly | pronoun | #10 | #3 |
| Lydia has run away with Wickham | pronoun | 未进前 50 | 未进前 50 |
| Mrs Bennet tells her husband that Netherfield has been taken | named | #1 | #1 |
| Mr Bennet stops Mary singing at the ball | named | #17 | #4 |
| Mr Collins reads a volume of sermons aloud to the Bennets | named | #1 | #1 |

上升 3 条，下降 1 条。

## 实际返回的卡片

### Darcy proposes to Elizabeth for the first time and she turns him down

**#1** · 定位句：Mrs. Bennet’s lament over Lydia’s departure, Elizabeth’s retort, and the news of Mr. Bingley’s return to Netherfield.

> “I often think,” said she, “that there is nothing so bad as parting with one’s friends. One seems so forlorn without them.” “This is the consequence you see, Madam, of marrying a d…

**#2** · 定位句：Mr. Bennet’s refusal to force Elizabeth to marry Mr. Collins, after her rejection, and Mrs. Bennet’s continued pressure on Elizabeth and Jane.

> “What do you mean, Mr. Bennet, by talking in this way? You promised me to insist upon her marrying him.” “My dear,” replied her husband, “I have two small favours to request. First…

**#3** · 定位句：Elizabeth Bennet, at Rosings, teases Darcy before Colonel Fitzwilliam about his dancing only four dances at the Meryton ball.

> “Pray let me hear what you have to accuse him of,” cried Colonel Fitzwilliam. “I should like to know how he behaves among strangers.” “You shall hear then﻿—but prepare yourself for…


### Elizabeth realises she was wrong about Wickham after reading the letter

**#1** · 定位句：During their walk to Lucas Lodge, Elizabeth and Darcy discuss his letter and her changed feelings.

> “I can easily believe it. You thought me then devoid of every proper feeling, I am sure you did. The turn of your countenance I shall never forget, as you said that I could not hav…

**#2** · 定位句：Chapter 42: Elizabeth tells Jane of Darcy’s proposal and letter, discussing Wickham’s character and concealing Bingley’s involvement.

> XL Elizabeth’s impatience to acquaint Jane with what had happened could no longer be overcome; and at length resolving to suppress every particular in which her sister was concerne…

**#3** · 定位句：Elizabeth Bennet’s reflections on her changed feelings for Mr. Darcy after learning of Lydia’s elopement with Wickham, following Jane’s letters at Lambton.

> If gratitude and esteem are good foundations of affection, Elizabeth’s change of sentiment will be neither improbable nor faulty. But if otherwise, if the regard springing from suc…


### Mr Collins asks Elizabeth to marry him

**#1** · 定位句：Mr. Bennet’s library interview with Elizabeth after her refusal of Mr. Collins, where he mocks Mrs. Bennet’s insistence.

> “Of Mr. Collins and Lizzy. Lizzy declares she will not have Mr. Collins, and Mr. Collins begins to say that he will not have Lizzy.” “And what am I to do on the occasion?﻿—It seems…

**#2** · 定位句：Charlotte Lucas’s private confession to Elizabeth Bennet of her engagement to Mr. Collins, and Elizabeth’s shocked, disapproving reaction.

> The steady countenance which Miss Lucas had commanded in telling her story, gave way to a momentary confusion here on receiving so direct a reproach; though, as it was no more than…

**#3** · 定位句：Mr. Collins’s plan to marry one of the Bennet daughters as atonement for inheriting Longbourn estate.

> Having now a good house and very sufficient income, he intended to marry; and in seeking a reconciliation with the Longbourn family he had a wife in view, as he meant to choose one…


## 怎么读这张表

按类型拆开：

- **pronoun（8 条，目标段落里少有专名）**：2 升，1 降，5 条没动。降的那条是 #3→#4，一名之差，在噪声里。
- **named（3 条，对照组，用来查稀释）**：1 升，0 降。没有稀释迹象——多出来的一列没有把本来排第一的挤下去。

真正要看的是那 5 条没动的：其中 4 条的目标段落**两边都没进前 50**。上下文行没能把它们捞起来。

## 为什么没捞起来

两个原因，都不是实现出了错。

**一，0.3 是个平局裁判的权重。** 设计时就写明「它该在两段书里话分不出高下时打破平局，永远不该盖过真正说了这些词的那一段」。一个差 40 名的查询，平局裁判救不了——它本来就不是干这个的。

**二，问句和定位句用的不是同一批词。** 卡片里能看出来：问「Darcy proposes to Elizabeth for the first time」，排第一的段落定位句是「Mrs. Bennet's lament over Lydia's departure」。定位句本身写得很好，人名地点都对，但它写的是「Mr. Bennet's refusal to force Elizabeth to marry Mr. Collins」，而问句说的是「proposes / turns him down」。关键词检索按 token 对，refusal ≠ turns down。而 Elizabeth、Darcy 这种词在这本书里每一段都有，BM25 给不了它们任何区分度。

**这类查询本来就不该由关键词检索扛。** 它们是语义查询，该走向量那条路。而上下文行的另一个读者——它同时也拼进 embedding 的输入——正是这次**完全没测到**的那一半。

## 这次测到的和没测到的

测到的：上下文行填进 FTS 第二列之后，对**关键词检索**的影响。这是每个读者都有的那一半，也正是「取消向量门槛」这个决定要回答的问题。答案是小幅正向、无稀释——够格支持那个决定，但仅此而已。

没测到的：上下文行拼进 embedding 输入之后对**向量检索**的影响。那是它设计上发挥作用的主战场，需要配一个 embedding provider 才能测。

## 这次实验设计上的弱点

查询和 gold 段落都是我自己挑的，11 条，样本小。挑查询的人和读结果的人是同一个，这不是干净的设计。要把结论坐实，查询该来自真实提问记录而不是我编的。

## 下次要便宜得多

这一轮烧了 642 次调用、15 分钟，结束时 TempDir 一销毁，生成好的定位句全没了。想换个权重再看一眼，就得整个重来。下次跑之前先把生成结果落盘缓存——权重扫描本身是纯 SQL，不该再花一次模型钱。
