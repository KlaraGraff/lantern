# 上下文行对关键词检索的实测

《Moby-Dick》（Herman Melville），1158 个 chunk，写出定位句 1158 条，模型返回不可用 0 条，调用失败跳过 0 条（留待下一轮补）。查询 36 条。

对照方式：同一个索引、同一批数据，唯一的差别是 `MATCH` 允不允许看 `seg_context` 这一列。「改前」把匹配限制在正文列上，等价于这一列不存在。查询里从不含 gold 短语。

| 查询 | 类型 | 改前 | 改后 |
|---|---|---|---|
| The morning after Ishmael first wakes up sharing a bed with Queequeg, what does he notice covering Queequeg's arm? | pronoun | #1 | #1 |
| When Ishmael introduces Starbuck as the chief mate, how does he describe Starbuck's body being suited to hot climates? | pronoun | #2 | #1 |
| What does Stubb do with an old tune even while he's in the middle of a dangerous whale fight? | pronoun | #5 | #5 |
| In the chapter where Ahab first appears after several days hidden in his cabin, how is his burned face and body described? | pronoun | 未进前 50 | 未进前 50 |
| Some days after Ahab's first appearance, how does the old man make his way up from the cabin at night to the deck? | pronoun | #8 | #3 |
| In the Cetology chapter, how does Ishmael define what makes a creature a whale rather than an ordinary fish? | pronoun | #1 | #1 |
| In The Whiteness of the Whale, what legendary status does Ishmael give the White Steed of the Prairies among wild horses? | pronoun | #1 | #1 |
| When Fedallah is first introduced to the crew, what does Ishmael say stays unexplained about him for the rest of the voyage? | pronoun | #6 | #8 |
| In The Fountain chapter, how does Ishmael sum up the sperm whale's overall character or bearing? | pronoun | 未进前 50 | #22 |
| In The Tail chapter, what gentle motion does Ishmael describe the whale making with its flukes when it feels a sailor's whisker? | pronoun | #1 | #1 |
| During the whale hunt in Stubb Kills a Whale, what is Stubb's lance secretly seeking as he churns it into the whale? | pronoun | #2 | #1 |
| After Pip is rescued half-mad from being left alone in the ocean, what does he claim to have seen upon a loom in the depths? | pronoun | #1 | #1 |
| In The Try-Works chapter, what does Ishmael say the whale itself provides to keep the trying-out fire burning? | pronoun | #2 | #1 |
| In The Lamp chapter, how does Ishmael contrast the ordinary sailor's darkness with how the whaleman experiences light? | pronoun | #1 | #1 |
| In The First Lowering, when Ahab first calls out to Fedallah before the chase, how loud does Ishmael say his voice was? | pronoun | #6 | #5 |
| As Queequeg lies dying of fever in his coffin chapter, what does Ishmael notice happening to his eyes even as the rest of him wastes away? | pronoun | #1 | #1 |
| During Starbuck's tormented soliloquy over the loaded musket in the typhoon, what does he fear Ahab is willing to do to his own crew? | pronoun | #2 | #1 |
| In The Symphony, as Starbuck approaches him at the rail, how is Ahab described leaning over the side of the ship? | pronoun | #5 | #5 |
| During the corpusants scene in The Candles, how is Fedallah positioned kneeling in front of Ahab at the base of the mainmast? | pronoun | #1 | #1 |
| On the third day of the chase, what does Starbuck murmur about the whale's direction as the ship comes about? | pronoun | #23 | #7 |
| During the hiring negotiation in The Ship, what does Peleg insist Ishmael deserves regarding his pay lay? | pronoun | #8 | #3 |
| In Stubb's comic dream in Queen Mab, what does Stubb say the old man Ahab did to him with his ivory leg? | pronoun | #3 | #3 |
| In A Bosom Friend, while Ishmael studies Queequeg counting the pages of a book, how does Queequeg react to being watched? | pronoun | #3 | #2 |
| In Starbuck's Dusk soliloquy, what does Starbuck say about how Ahab dominates everyone beneath him on the ship? | pronoun | #23 | #1 |
| What is the very first line the narrator gives about his own name at the start of Moby Dick? | named | 未进前 50 | 未进前 50 |
| In the Spouter-Inn, what is Queequeg doing with his pipe when he first grunts at Ishmael from the bed? | named | #2 | #1 |
| How does Ishmael compare Queequeg's head to a famous American historical figure in A Bosom Friend? | named | 未进前 50 | 未进前 50 |
| What does Ishmael say about Stubb's rank and origin when introducing him as the second mate? | named | #7 | #3 |
| During the chase in Stubb Kills a Whale, where does Stubb keep his position relative to the other boats? | named | 未进前 50 | 未进前 50 |
| When Ahab finally appears on deck after days of hiding, how does Ishmael describe him standing there? | named | 未进前 50 | 未进前 50 |
| In The Doubloon, what does Ahab say the firm tower carved on the coin represents about himself? | named | #4 | #3 |
| When Captain Gardiner of the Rachel begs Ahab to help search for his lost son, what is Ahab's blunt reply? | named | #9 | #5 |
| In The Doubloon, how does Ishmael describe Fedallah's tail as he approaches the coin? | named | #1 | #1 |
| After their tense confrontation in the cabin, what does Ahab quietly say to Starbuck out on deck? | named | #5 | #5 |
| What does Ishmael say about Starbuck's role and hometown when introducing him as chief mate? | named | 未进前 50 | #37 |
| During the rowdy midnight dance on the forecastle, what warning is shouted at Pip as the royal yard swings? | named | #1 | #1 |

上升 16 条，下降 1 条。

| 类型 | 上升 | 下降 | 不变 |
|---|---|---|---|
| named | 5 | 0 | 7 |
| pronoun | 11 | 1 | 12 |

## 实际返回的卡片

### The morning after Ishmael first wakes up sharing a bed with Queequeg, what does he notice covering Queequeg's arm?

**#1** · 定位句：Ishmael waking to find Queequeg's tattooed arm over him, recalling his childhood supernatural hand, and Queequeg's morning toilet with harpoon.

> IV The Counterpane Upon waking next morning about daylight, I found Queequeg’s arm thrown over me in the most loving and affectionate manner. You had almost thought I had been his …

**#2** · 定位句：Ishmael wakes to find Queequeg’s tattooed arm around him, recalls a childhood phantom hand, and struggles to free himself from the sleeping harpooneer’s embrace.

> Now, take away the awful fear, and my sensations at feeling the supernatural hand in mine were very similar, in their strangeness, to those which I experienced on waking up and see…

**#3** · 定位句：Mrs. Hussey demands Queequeg's harpoon at the Try Pots, citing young Stiggs's death, before Ishmael orders both chowders for breakfast.

> Supper concluded, we received a lamp, and directions from Mrs. Hussey concerning the nearest way to bed; but, as Queequeg was about to precede me up the stairs, the lady reached fo…


### When Ishmael introduces Starbuck as the chief mate, how does he describe Starbuck's body being suited to hot climates?

**#1** · 定位句：Chapter 32, "Knights and Squires": opening portrait of Starbuck, Pequod's chief mate, Nantucket Quaker, his hardy constitution, superstition, and domestic memories.

> The chief mate of the Pequod was Starbuck, a native of Nantucket, and a Quaker by descent.  He was a long, earnest man, and though born on an icy coast, seemed well adapted to endu…

**#2** · 定位句：Chapitre XLVI, « Surmises » : réflexions d’Ahab sur l’usage des hommes, la rébellion latente de Starbuck et la nécessité de maintenir l’équipage occupé.

> To accomplish his object Ahab must use tools; and of all tools used in the shadow of the moon, men are most apt to get out of order.  He knew, for example, that however magnetic hi…

**#3** · 定位句：Peleg's tearful farewell to Bildad and the mates Starbuck, Stubb, and Flask as the pilots leave the Pequod at sea, Christmas night.

> As for Peleg himself, he took it more like a philosopher; but for all his philosophy, there was a tear twinkling in his eye, when the lantern came too near. And he, too, did not a …


### What does Stubb do with an old tune even while he's in the middle of a dangerous whale fight?

**#1** · 定位句：Carpenter's soliloquy after Ahab leaves, comparing him to the Equator, while caulking Queequeg's coffin into a life-buoy.

> “He goes aft. That was sudden, now; but squalls come sudden in hot latitudes. I’ve heard that the Isle of Albemarle, one of the Galápagos, is cut by the Equator right in the middle…

**#2** · 定位句：Flask’s valuation of the doubloon as cigars, followed by Stubb’s commentary on the Manxman’s reading of the coin’s zodiac signs.

> “I see nothing here, but a round thing made of gold, and whoever raises a certain whale, this round thing belongs to him. So, what’s all this staring been about? It is worth sixtee…

**#3** · 定位句：Ahab’s quarterdeck rallying of the crew, his gold-ounce reward for sighting Moby Dick, and Starbuck’s protest.

> “Good!” cried Ahab, with a wild approval in his tones; observing the hearty animation into which his unexpected question had so magnetically thrown them. “And what do ye next, men?…

