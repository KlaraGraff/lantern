[简体中文](#chinese) · [English](#english)

<a id="chinese"></a>
## 中文

### 修复

**免费词典查词，此前对整套学习系统完全隐形**

单击一个词，菜单顶上那条免费词典释义——熟练度不记、复习堆不数、校准系数的分子也不算。一个习惯用单击查词的读者，他最常做的那个动作，对应用给他的全部评估没有任何输入。这一版把它接了进来：

- **什么才算一次查看。** 词典真的返回了词条、菜单在词条渲染后又开了 1.5 秒、期间没点过任何菜单动作——四条都满足才算数。展开词条不算「点了别的」，那本来就是在读释义。同一位置 60 秒内重复点开算一次。
- **一次查看值半张 AI 卡。** 7 天窗口内累计：跨过 1.0 降一档，跨过 2.0 打回「学习中」，到 3.0 标成这本书的拦路词。只用学习卡的读者，1.0 / 2.0 / 3.0 就是原来的第 1 / 2 / 3 次，一个数都没动。
- **同一本书里翻够 4 次词典的词自己进观察区。** 没有这一条，只用词典、从不开卡的词根本进不了生词列表，上面那套阶梯对他就是够不着的。
- **复习堆的门槛统一成权重 2.0**——两张卡、或一卡两次词典、或四次词典。只开卡的读者，堆里的成员一个没变。
- **降档说明按实际做过的事写。** 原来一律是「你又查了它一次」，可背后可能只翻过词典、压根没开过卡——那是应用把自己的证据说错了。现在只开卡、只翻词典、两样都有，各说各的话。
- 词典查看记在本机，和阅读曝光一样不参与同步。

**查词卡不再把长词条裁成一条**

单击 `deliver` 只看到一条动词释义，后面直接叫人去问 AI。原因在后端：它按字符预算裁每个词性，猜不到卡片实际多宽，而「还剩几条」也是它自己算的。现在截断交给布局——每一行都填到边缘再省略，被吃掉几条是量出来的。`deliver` 十一条义项全出；`light` 那种超长词条给「展开全部」，点开滚动看全。

- 朗读图标挪进卡片头部、单词右侧——词典本来就该放在那儿。
- 卡片从菜单打开的第一帧就在，音标和释义先占骨架条；此前要等网络回来才整块蹦出来，菜单跟着改宽度、跳位置。
- 「双击让 AI 告诉你这里是哪个意思」这一行现在跟随双击查词开关：关掉双击查词，这句话就不该出现。

**其余修复**

- 顶栏章数按正文算。扉页、版权页、尾注本来就是目录条目，一并计入之后和书里印的章号对不上：Standard Ebooks 版《傲慢与偏见》61 章，原来读作「第 4 章，共 65 章」，现在读作「第 2 章，共 61 章」。站在扉页或版权页上时读数留空，不再谎报章号。
- 在设置页改英语等级时，讲解语言跟着走——除非你自己挑过某一档。B1 走完引导的人升到 C1，此前看到的还是整段中文。
- 高频生词榜里的两个数据缺陷：`cannot` 被上游分词切成了 `can not`，词频从没被记录；`sister's` 这类所有格因为查表时不削撇号，一律算作不认识。《傲慢与偏见》的覆盖率因此从 95.5% 升到 95.8%。
- `Lady Catherine de Bourgh` 里的 `de` 出现 41 次、排在生词榜第二——它是人名的一部分，不是你该学的词。夹在两个大写词中间、且词频表里查不到的小写词，现在一并归还给人名。
- 「出现 40 次以上」那组的提示语原来同时假设了「不止一个词」和「认下来数字会动」。两个假设常常一起落空，句子就成了「这几个词认下来，覆盖率会从 95.9% 升到 95.9%」——读得越好越容易撞见。现在按词数和数字是否真的会动，分四句写。
- 学习卡的「当前语境含义」拆成两段：上面一行只写光秃秃的语境义，解释句挪到下面。正文上方那行小字取的就是这一行，此前它拿到的是整句话，长度过不了检查，保存生词时还要再跑一次生成——同一个词于是有了两套措辞不同的答案。
- 模块里不再重复一遍自己的标题：卡片已经印了「当前语境含义」，模型又写一遍「语境含义」，读者要读两遍同样的词才碰到第一句正文。

### 改进

- 正文里的生词注解收小一档——字号、字重、透明度都降了，行上方预留的空间也收窄。它是备查的，不该在段落里显出一道空档、让那一行看起来像分节。
- 注解贴回它自己那个词。此前包裹层的行框上下各比单词高出约 0.3em，注解离自己的词比离上一行还远，读起来像是上一行的注。

### 下载与兼容

- macOS：`Lantern_2.15.2_aarch64.dmg` —— 仅支持 Apple Silicon（M 系列）芯片，macOS 12 Monterey 及以上。
- Windows：`Lantern_2.15.2_x64-setup.exe` —— Windows 11 x64。
- macOS 安装包已用 Developer ID 证书签名并通过 Apple 公证，直接双击打开即可，不会遇到 Gatekeeper 阻拦。

<a id="english"></a>
## English

### Bug Fixes

**Free dictionary lookups were invisible to the whole learning system**

Single-click a word and the free dictionary sense appears at the top of the menu — and mastery never recorded it, review piles never counted it, and the calibration factor left it out of the numerator. A reader who habitually looks words up by single-clicking was feeding nothing at all into the app's assessment of them. This release wires it in:

- **What counts as a lookup.** The dictionary actually returned an entry, the menu stayed open for 1.5 seconds after it rendered, and nothing else in the menu was clicked in the meantime. Expanding the entry doesn't disqualify it — reading the senses is the point. Reopening at the same spot within 60 seconds counts once.
- **A lookup is worth half an AI card.** Over a 7-day window: crossing 1.0 drops the word one level, crossing 2.0 sends it back to Learning, 3.0 marks it as a blocker for that book. For readers who only use cards, 1.0 / 2.0 / 3.0 are exactly the old 1st / 2nd / 3rd time — nothing moved.
- **Four dictionary lookups in one book put a word on the watchlist.** Without it, a word you only ever look up and never open a card for could never enter the vocabulary list at all, which put the whole ladder above out of reach.
- **The review pile threshold is now a single weight of 2.0** — two cards, or one card and two lookups, or four lookups. For card-only readers, pile membership is unchanged.
- **Level-drop explanations now describe what you actually did.** They used to say "you looked it up again" in every case, including when you had only consulted the dictionary and never opened a card — the app misstating its own evidence. Cards only, dictionary only, and both now each get their own wording.
- Dictionary lookups are stored locally and, like reading exposure, do not sync.

**The dictionary card no longer cuts long entries down to one sense**

Single-clicking `deliver` showed a single verb sense and then told you to go ask the AI. The cause was on the backend: it trimmed each part of speech against a character budget, with no way to know how wide the card actually is — and the "N senses hidden" count was its own guess. Truncation is now the layout's job: every line fills to the edge before eliding, and what got cut is measured rather than estimated. `deliver` shows all eleven senses; an entry as long as `light` offers "Show all" and scrolls.

- The pronunciation button moved into the card header, to the right of the word — where a dictionary puts it.
- The card is present from the first frame the menu opens, with skeleton bars for the phonetics and senses. It used to appear all at once when the network came back, resizing the menu and shifting things under the cursor.
- "Double-click to ask the AI which sense applies here" now follows the double-click lookup setting. With double-click lookup off, the line has no business being there.

**Other fixes**

- The chapter readout in the top bar now counts body matter only. Title pages, copyright pages and endnotes are table-of-contents entries too, and counting them put the readout out of step with the chapter numbers printed in the book: the Standard Ebooks edition of *Pride and Prejudice* has 61 chapters and used to read "Chapter 4 of 65". It now reads "Chapter 2 of 61", and goes blank on a title or copyright page rather than claiming a chapter number.
- Changing your English level in Settings now carries the explanation language with it — unless you have picked one yourself. Someone who finished onboarding at B1 and moved up to C1 was still getting whole paragraphs in their first language.
- Two data defects in the frequent-unknown-words list: `cannot` had been split into `can not` upstream, so its real frequency was never recorded, and possessives like `sister's` counted as unknown because the apostrophe was never stripped before the lookup. Coverage for *Pride and Prejudice* rises from 95.5% to 95.8% as a result.
- The `de` in `Lady Catherine de Bourgh` appeared 41 times and sat second on the unknown-words list — it is part of a name, not a word to learn. Lowercase words sandwiched between two capitalized ones and absent from the frequency table now go back to the name they belong to.
- The note under "appearing 40+ times" assumed both that there was more than one word and that learning them would move the number. Both assumptions fail together, and the sentence became "learn these words and coverage goes from 95.9% to 95.9%" — the better you read, the more likely you were to see it. It is now one of four sentences, chosen by the word count and by whether the figure genuinely changes.
- "In this context" on the learning card is now two parts: a bare contextual sense on the first line, with the explanation moved below it. The small gloss printed above the word in the text is that first line — it used to receive a full sentence, fail the length check, and force a second generation pass when the word was saved, leaving the same word with two differently worded answers.
- Sections no longer repeat their own titles. The card already prints "In this context" above the section, and the model wrote "contextual sense" again underneath, so you read the same words twice before reaching the first real line.

### Improvements

- Vocabulary glosses in the text are a notch quieter — smaller, lighter, more transparent, with less space reserved above the line. They are there for reference, and shouldn't open a visible gap in the paragraph that makes the line look like a section break.
- Glosses now sit with the word they belong to. The wrapper's line box stood about 0.3em taller than the word on each side, leaving the gloss closer to the line above than to its own word, so it read as an annotation on the wrong line.

### Download and compatibility

- macOS: `Lantern_2.15.2_aarch64.dmg` — Apple Silicon (M-series) Macs only, running macOS 12 Monterey or later.
- Windows: `Lantern_2.15.2_x64-setup.exe` — Windows 11 x64.
- The macOS installer is signed with a Developer ID certificate and notarized by Apple, so it opens without a Gatekeeper prompt.

