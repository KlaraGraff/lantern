# 上下文行对关键词检索的实测

《Jane Eyre》（Charlotte Brontë），928 个 chunk，写出定位句 928 条，模型返回不可用 0 条，调用失败跳过 0 条（留待下一轮补）。查询 36 条。

对照方式：同一个索引、同一批数据，唯一的差别是 `MATCH` 允不允许看 `seg_context` 这一列。「改前」把匹配限制在正文列上，等价于这一列不存在。查询里从不含 gold 短语。

| 查询 | 类型 | 改前 | 改后 |
|---|---|---|---|
| How does Jane describe John Reed's eating habits and appearance as a boy at Gateshead? | pronoun | 未进前 50 | #33 |
| How was Mrs. Reed positioned in the drawing room with her children on the afternoon Jane was excluded from the group? | pronoun | #2 | #1 |
| What did Bessie and Miss Abbot do when Jane tried to spring up off the stool in the red room? | pronoun | #2 | #1 |
| Which of the Reed children does Jane say she felt physically inferior to at the start of the novel? | named | 未进前 50 | 未进前 50 |
| How old was John Reed and how is he first described physically in the opening chapter? | named | #6 | #6 |
| What did Jane imagine Helen Burns was thinking about while she stood being punished in front of the class? | pronoun | #16 | #3 |
| How did Miss Temple first appear to Jane as she walked to the front of the schoolroom at Lowood? | pronoun | 未进前 50 | #20 |
| How did Jane first recognize Mr Brocklehurst approaching the schoolroom before she could see his face clearly? | pronoun | #2 | #3 |
| What did Helen Burns do when Jane whispered to her in the middle of the night in Miss Temple's room? | pronoun | #13 | #7 |
| What did Helen Burns say to Miss Smith right after passing Jane while Jane stood on the stool of shame? | named | #1 | #1 |
| What is Miss Temple's full first name, and how did Jane learn it? | named | 未进前 50 | #18 |
| How does Jane describe the stranger's face when she first meets Rochester after his horse slips on the icy road near Thornfield? | pronoun | 未进前 50 | #22 |
| What did Rochester say to Jane to get her to move out of his way while he tried to remount his horse on the icy lane? | pronoun | #23 | #3 |
| How did Rochester move through the gallery on the night Jane heard the strange laugh outside her bedroom door? | pronoun | #5 | #8 |
| How did Rochester react right after Jane finished telling him about the curtain fire in his room? | pronoun | 未进前 50 | #43 |
| How did Jane describe Mr Mason's condition as he sat wounded and bleeding in the hidden room upstairs at Thornfield? | pronoun | 未进前 50 | 未进前 50 |
| How did Rochester approach Jane in the orchard just before he proposed to her? | pronoun | 未进前 50 | 未进前 50 |
| How did Rochester look and act right after Jane accepted his proposal in the orchard? | pronoun | #24 | #10 |
| How did Rochester stand and react in the church when Mr Briggs interrupted the wedding to reveal his existing marriage? | pronoun | #20 | #7 |
| How does Jane describe Bertha Mason's build and strength during the struggle when she attacked her brother? | pronoun | 未进前 50 | 未进前 50 |
| What did the gypsy fortune teller do with the fire while reading Jane's palm during the party at Thornfield, before Jane realized it was Rochester in disguise? | pronoun | #41 | #12 |
| According to Adele, how did Rochester bring her ashore from the ship when they landed in a foreign port? | named | #2 | #3 |
| In what state did Jane find Rochester in his bed just before she woke him during the curtain fire? | named | #2 | #2 |
| How did Rochester arrive in the gallery right after Mr Mason was attacked in the night? | named | #5 | #2 |
| What does Rochester tell his wedding guests about Bertha Mason's family and her sanity? | named | #1 | #1 |
| How does Jane describe the voice that cried her name across the moors the night before she decided to leave Moor House and search for Rochester? | pronoun | #9 | #14 |
| What did St John Rivers say to Jane about death and suffering just after he found her collapsed outside Moor House? | pronoun | 未进前 50 | #30 |
| How did Jane describe Diana Rivers's countenance when she looked at her right after being taken in at Moor House? | pronoun | #33 | #21 |
| How did Jane first describe Rosamond Oliver's appearance when she arrived at the garden gate to meet St John? | pronoun | 未进前 50 | #42 |
| What did St John Rivers do with his foot while telling Rosamond Oliver it was too late for her to be out alone? | pronoun | #2 | #1 |
| Which of the Rivers sisters spoke up to ask Jane if they had now given her all the aid she required? | named | #15 | #12 |
| How does Jane first identify Rosamond Oliver to herself after the young woman asks about Alice Wood? | named | 未进前 50 | #14 |
| What phrase does Diana Rivers use to sum up her brother St John's character after Jane witnesses his encounter with Rosamond Oliver? | named | #15 | #2 |
| How did Jane first spot Rochester when she arrived at Ferndean in the rainy twilight, before she recognized him? | pronoun | #4 | #2 |
| How was Rochester described sitting by the fire in the parlour just before Jane brought him his glass of water at Ferndean? | pronoun | #1 | #1 |
| How does Jane identify the figure who steps out of the house at Ferndean the moment she first sees him in the twilight? | named | #4 | #1 |

上升 23 条，下降 4 条。

| 类型 | 上升 | 下降 | 不变 |
|---|---|---|---|
| named | 6 | 1 | 5 |
| pronoun | 17 | 3 | 4 |

## 实际返回的卡片

### How does Jane describe John Reed's eating habits and appearance as a boy at Gateshead?

**#1** · 定位句：Robert Leaven, Gateshead coachman, tells Jane of John Reed's ruin, imprisonment, and suspected suicide, and of Mrs. Reed's stroke.

> “Doing well! He could not do worse: he ruined his health and his estate amongst the worst men and the worst women. He got into debt and into jail: his mother helped him out twice, …

**#2** · 定位句：Jane Eyre’s solitary reflections in the red-room at Gateshead Hall, recalling John Reed’s blow and her unjust punishment.

> My head still ached and bled with the blow and fall I had received: no one had reproved John for wantonly striking me; and because I had turned against him to avert farther irratio…

**#3** · 定位句：Mrs. Reed’s deathbed confession to Jane Eyre at Gateshead, recalling her hatred of Jane as a baby and her husband’s dying wish, amid John Reed’s ruin and her own decline.

> “I had a dislike to her mother always; for she was my husband’s only sister, and a great favourite with him: he opposed the family’s disowning her when she made her low marriage; a…


### How was Mrs. Reed positioned in the drawing room with her children on the afternoon Jane was excluded from the group?

**#1** · 定位句：Jane Eyre excluded from the Reed family circle in the drawing-room, retreating to the breakfast-room window-seat with Bewick's book.

> The said Eliza, John, and Georgiana were now clustered round their mama in the drawing-room: she lay reclined on a sofa by the fireside, and with her darlings about her (for the ti…

**#2** · 定位句：Jane Eyre, locked in the red-room at Gateshead Hall, recalls her uncle Mr. Reed’s deathbed promise to Mrs. Reed, and fears his ghost.

> Daylight began to forsake the red-room; it was past four o’clock, and the beclouded afternoon was tending to drear twilight. I heard the rain still beating continuously on the stai…

**#3** · 定位句：Jane Eyre’s lonely winter at Gateshead, excluded from Christmas festivities with Eliza and Georgiana, finding solace in her doll and Bessie’s rare kindness.

> November, December, and half of January passed away.  Christmas and the New Year had been celebrated at Gateshead with the usual festive cheer; presents had been interchanged, dinn…


### What did Bessie and Miss Abbot do when Jane tried to spring up off the stool in the red room?

**#1** · 定位句：Jane Eyre's struggle with Bessie and Miss Abbot after striking John Reed, leading to her imprisonment in the red-room at Gateshead Hall.

> II I resisted all the way: a new thing for me, and a circumstance which greatly strengthened the bad opinion Bessie and Miss Abbot were disposed to entertain of me. The fact is, I …

**#2** · 定位句：Jane Eyre's terrified scream in the red-room brings Bessie, Abbot, and Mrs. Reed, who refuses her plea for release.

> Steps came running along the outer passage; the key turned, Bessie and Abbot entered. “Miss Eyre, are you ill?” said Bessie. “What a dreadful noise! it went quite through me!” excl…

**#3** · 定位句：Jane Eyre’s imprisonment in the red-room at Gateshead Hall, after her fight with John Reed, as Bessie and Miss Abbot scold her.

> “Don’t take them off,” I cried; “I will not stir.” In guarantee whereof, I attached myself to my seat by my hands. “Mind you don’t,” said Bessie; and when she had ascertained that …

