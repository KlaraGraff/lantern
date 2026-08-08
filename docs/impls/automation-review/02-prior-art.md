# 阶段 3 · 经典研究

限定六个领域。每条：标题 + 作者 + 年份 + 可点开的链接 + 【直接适用】/【只是类比】+ 它对应 Lantern 的哪一条机制。

**核实口径**：14 条全部在 2026-08-08 当场核对过标题、作者、年份与链接可达。核不出来的没写——具体删掉了什么，见文末。

---

## 一、Mixed-initiative interaction（人机主动权分配）

### 1. Principles of Mixed-Initiative User Interfaces
Eric Horvitz, 1999, CHI '99 · <https://dl.acm.org/doi/10.1145/302979.303030>

**【直接适用】**

十二条设计原则，其中三条几乎是照着我们的 inventory 写的：系统采取自动行动前要**衡量行动的期望效用**，不确定时**要么问要么退让**；自动行动必须**留下让用户直接接管的通道**；系统要**记住用户对上一次自动行动的态度**。

对应我们：inventory 里「用户看得见吗 = 否」且「能撤销吗 = 否」的那批条目——`profile.rs:1414` 的 prompt 注入、`reading_behavior.rs:39` 的发呆判定、`merge.rs` 的 LWW 裁决——全部违反第一条和第二条。而 `level_observation.rs:826` 的 90 天静默窗口恰好是第三条的正例，说明这套东西我们不是不会做，是没成体系地做。

---

## 二、Automation bias / 过度信任自动化

### 2. Humans and Automation: Use, Misuse, Disuse, Abuse
Raja Parasuraman & Victor Riley, 1997, *Human Factors* 39(2), 230–253 · <https://journals.sagepub.com/doi/10.1518/001872097778543886>

**【直接适用】**

这篇给了四个词。misuse = 过度依赖自动化；disuse = 因为误报太多而干脆关掉它；abuse = 设计方在不了解人类后果的情况下上自动化。

对应我们：`chapter-end-hint.ts` 的章末提示、`auto_analysis.rs:223` 的「升级为自动」建议，都在 disuse 的射程内——提示打扰一次两次，用户就把整块关掉，连带有用的部分一起丢。而 inventory 里那批「用户看不见」的自动判断属于 abuse 那一栏：我们上了自动化，但没评估判错时用户承担什么。

### 3. Does automation bias decision-making?
Linda J. Skitka, Kathleen L. Mosier & Mark Burdick, 1999, *International Journal of Human-Computer Studies* 51(5), 991–1006 · <https://doi.org/10.1006/ijhc.1999.0252>

**【直接适用】**

实验结论很硬：给了一个「很可靠但不完美」的自动化助手之后，被试在监控任务上的表现**比没有助手时更差**。自动化被当成了警觉性的替代品，而不是补充。

对应我们：难度条、CEFR 等级提示、画像卡片，都是「大多数时候对」的判断。这篇说的是——正因为它大多数时候对，用户会停止自己判断，于是它错的那几次代价被放大。这直接反驳「反正准确率挺高，不用给撤销入口」这类推理。

### 4. To Trust or to Think: Cognitive Forcing Functions Can Reduce Overreliance on AI in AI-Assisted Decision-Making
Zana Buçinca, Maja Barbara Malaya & Krzysztof Z. Gajos, 2021, *PACM HCI* 5, CSCW1, Article 188 · <https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca21trust.pdf>

**【直接适用】**

现代版的第 3 条，而且给了解法：在**决策发生的那一刻**插入一个小摩擦（先让人给出自己的判断、或者要点一下才展开 AI 的结论），能显著降低过度依赖。事后教育用户「AI 会出错」没用。

对应我们：这是「AI 填的书名要不要让用户核对」那个未开工功能的直接理论依据——核对条不是礼貌，是 cognitive forcing function。同样适用于 CEFR 等级提示：直接显示结论 vs. 点开才看到，效果不一样。

---

## 三、间隔重复与记忆模型

### 5. Distributed practice in verbal recall tasks: A review and quantitative synthesis
Nicholas J. Cepeda, Harold Pashler, Edward Vul, John T. Wixted & Doug Rohrer, 2006, *Psychological Bulletin* 132, 354–380 · <https://digitalcommons.usf.edu/psy_facpub/1771/>

**【直接适用】**

184 篇文献、317 个实验、839 组测量的元分析。核心结论：**最优复习间隔随目标保持期变长而变长**——想记一周和想记一年，间隔安排不是同一套。

对应我们：这是间隔重复整块的地基。它也提出一个我们没回答的问题——Lantern 的目标保持期是多久？「读完这本书时还认得」和「一年后还认得」对应的排程不一样，而我们从没定义过这个目标。

### 6. A Trainable Spaced Repetition Model for Language Learning
Burr Settles & Brendan Meeder, 2016, ACL 2016 · <https://aclanthology.org/P16-1174/>

**【直接适用】**

Duolingo 的 HLR（half-life regression）：不预设遗忘曲线参数，而是从**真实练习日志**回归出每个词的记忆半衰期，特征里带上词本身的属性。

对应我们：这是机制 E 那个缺口的最近参照。我们的 familiar=4 / mastered=8 / `CHAPTER_CREDIT_CAP=2.0` 是拍出来的常数；HLR 的做法是让同类参数从数据里长出来。我们已经在攒曝光日志了，原材料是有的。

### 7. Optimizing Spaced Repetition Schedule by Capturing the Dynamics of Memory
Jingyong Su, Junyao Ye, Liqiang Nie, Yilong Cao & Yongyong Chen, 2023, *IEEE TKDE* · <https://ieeexplore.ieee.org/document/10059206/> · DOI 10.1109/TKDE.2023.3251721

**【直接适用】**

FSRS 背后的论文。用 Markov 性质建记忆动力学，把排程转成随机最短路问题求解。

对应我们：我们通过 `rs-fsrs` 直接吃到了这篇的成果。列出来是为了标清边界——**排程这一半有论文兜底，喂进去的曝光信号那一半没有**。

---

## 四、LLM-as-judge 的可靠性与偏差

### 8. Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena
Lianmin Zheng, Wei-Lin Chiang, Ying Sheng, Siyuan Zhuang, Zhanghao Wu, Yonghao Zhuang, Zi Lin, Zhuohan Li, Dacheng Li, Eric P. Xing, Hao Zhang, Joseph E. Gonzalez & Ion Stoica, 2023, NeurIPS 2023 Datasets & Benchmarks · <https://arxiv.org/abs/2306.05685>

**【直接适用】**

奠基性的一篇，同时也是列问题清单的一篇：位置偏差、冗长偏差（更长的答案被打更高分）、自我增强偏差、以及在需要推理的题目上判断力有限。

对应我们：`level_word_class.rs` 让 AI 判 topical/general、`followup_difficulty.rs` 让 AI 给追问分类、`profile.rs:1238` 让 AI 改写画像结论——三处都是 LLM 在做分类判断，三处都没做偏差检查。第三处尤其值得警惕：改写画像结论是最典型的「AI 评判 AI 的输入」。

### 9. Large Language Models are not Fair Evaluators
Peiyi Wang, Lei Li, Liang Chen, Zefan Cai, Dawei Zhu, Binghuai Lin, Yunbo Cao, Qi Liu, Tianyu Liu & Zhifang Sui, 2023 · <https://arxiv.org/abs/2305.17926>

**【直接适用】**

只是**调换候选项在 prompt 里的先后顺序**，排名就会翻。缓解办法：多次评估取平均、换顺序再评一遍。

对应我们：`level_word_class.rs` 一批送约 30 个词，`followup_difficulty.rs` 一批送不超过 30 条。批内顺序会不会影响判定，我们从没测过。这是一个便宜的检查：同一批打乱顺序跑两次，看结果差多少。

### 10. LLM Evaluators Recognize and Favor Their Own Generations
Arjun Panickssery, Samuel R. Bowman & Shi Feng, 2024 · <https://arxiv.org/abs/2404.13076>

**【只是类比】**

模型能以不低的准确率认出自己的输出，且倾向于给自己打高分。

标只是类比，因为我们没有让模型评判候选答案的场景。但有一处擦边：`profile.rs:1238` 用 AI 改写的画像结论，会经 `profile.rs:1414` 注入到后续每一次 AI 回复；下一轮画像 batch 的证据（追问、回复节奏）又来自那些被影响过的回复。这是自我强化的形状，虽然不是这篇讲的那个机制。

---

## 五、模型输出的不确定性与校准

### 11. Language Models (Mostly) Know What They Know
Saurav Kadavath, Tom Conerly, Amanda Askell 等（Anthropic），2022 · <https://arxiv.org/abs/2207.05221>

**【直接适用】**

大模型在多选和判断题上**自身是良好校准的**——它报出的概率跟实际正确率对得上，只要题目格式合适。但把置信度推广到没见过的任务上仍然困难。

对应我们：`useAiChat.ts:1173` 的别名置信度是目前唯一一处把不确定性摆到界面上的（低/中置信度有提示）。这篇说的是这条路走得通，值得往其他判断上推——尤其是 AI 清洗书名那种「拿不准就别改」的场景。反过来也要注意后半句：跨任务的置信度不能直接信。

---

## 六、推荐系统的冷启动与反馈回路

### 12. Methods and Metrics for Cold-Start Recommendations
Andrew I. Schein, Alexandrin Popescul, Lyle H. Ungar & David M. Pennock, 2002, SIGIR '02, 253–260 · <https://dl.acm.org/doi/10.1145/564376.564421>

**【只是类比】**

冷启动的经典表述与评测方法：没有任何评分记录的物品怎么推荐，以及怎么衡量做得好不好。

标只是类比，因为我们不做推荐。但**证据不足时怎么办**这个问题是共通的，而我们的答案散在各处且互不一致：`profile.rs:64` 是「少于 5 条就跳过这个维度」，`calibration/mod.rs:152` 是「样本不足退回中性 1.0」，`book_difficulty.rs:648` 是「样本达标才显示」。三种策略，没有统一口径。这篇的贡献是提醒：冷启动是要专门设计和度量的，不是每处各拍一个阈值。

### 13. How Algorithmic Confounding in Recommendation Systems Increases Homogeneity and Decreases Utility
Allison J. B. Chaney, Brandon M. Stewart & Barbara E. Engelhardt, 2018, RecSys '18（arXiv 2017 首发） · <https://arxiv.org/abs/1710.11214>

**【直接适用】**

在已被算法影响过的数据上继续训练算法，会让用户行为趋同，而**效用并不上升**。

对应我们：这就是画像闭环的形状。画像改写 AI 的语气 → AI 的回答改变用户的追问方式 → 追问又成为下一轮画像的证据。我们的 30 天半衰期能让旧证据褪色，但褪不掉这个环本身。

### 14. Degenerate Feedback Loops in Recommender Systems
Ray Jiang, Silvia Chiappa, Tor Lattimore, András György & Pushmeet Kohli, 2019, AIES '19 · <https://arxiv.org/abs/1902.10730>

**【直接适用】**

比上一条更进一步：系统的决策会改变用户的信念与偏好，而这些被改变的偏好又回流成训练信号。文中区分了回音室与过滤气泡，并给了可操作的缓解手段（随机化、探索）。

对应我们：直接的应用是——画像不应该 100% 决定讲解口吻。留一部分不受画像影响的输出，既是探索，也是唯一能发现「画像推错了」的途径。目前 `profile.rs:1414` 是无条件注入。

---

## 补充材料

### 别名表的学术出处
**A Bayesian Mixed Effects Model of Literary Character** — David Bamman, Ted Underwood & Noah A. Smith, 2014, ACL 2014 · <https://aclanthology.org/P14-1035/>

**【直接适用】**，对应机制 B。BookNLP 的学术源头。列在这里是因为它连着阶段 2 的那个结论：这条线上有语料（LitBank）、有评测传统，而我们的别名表准确率至今是零测量。

### 没写进来的
- **推荐系统冷启动的现代综述**——找到的候选都不是公认经典，宁缺。
- **神经网络校准（Guo et al. 2017）与「用语言表达不确定性」（Lin, Hilton & Evans 2022）**——两条我都记得，但这一轮没当场核实出处，按「写不出来比写错好」的口径不写。第 11 条已经覆盖了这一支的核心结论。
- **Ebbinghaus 1885**——真要引得引原始德文版或特定英译本，版本混乱，且第 5 条的元分析已经把结论收进去了。
