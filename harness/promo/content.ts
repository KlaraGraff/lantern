/**
 * 样张里的 AI 产出。
 *
 * 截图脚本里不能有 API Key，所以卡片和回答的文本在这里写死。三条规矩，破了
 * 任何一条这批图就开始撒谎：
 *
 *  1. **结构必须是应用真会渲染的结构。** 学习卡走 `LearningCardResult`，对话
 *     走持久化消息的 `metadata` JSON —— 和真答案回来时走的是同一条解析路径。
 *     这里不另画一套版式。
 *  2. **引用的原文必须逐字出自那本书。** `snippet` 会被拿去在章节里检索并高亮，
 *     抄错一个字角标就点不回去了，图上也就看得出来。
 *  3. **不编数字。** 章节序号取自真实 EPUB 的 spine，百分比取自书架上真有的
 *     阅读进度。
 *
 * 原文全部来自 Standard Ebooks 的《Pride and Prejudice》（公有领域），章节
 * 范围止于第二十一章 —— 书架上那本书正读到 34%，再往后的原文不该出现在回答里。
 */

/**
 * spine 里第 0、1 项是扉页和版权页，所以第 N 章就是第 N+1 项。这本书 65 个
 * spine 项、61 章，下面每一处 `sectionIndex` 都是这么来的，没有一个是猜的。
 */
const chapterIndex = (chapter: number) => chapter + 1;
const chapterHref = (chapter: number) => `text/chapter-${chapter}.xhtml`;

/** 主角书在 spine 里的第 4 项（封面 / 扉页 / 版权页之后），也就是第二章。 */
const CH2 = chapterIndex(2);

const DAY = 86_400_000;
const ago = (days: number) => Date.now() - days * DAY;

/* ------------------------------------------------------------------ *
 * 对话
 * ------------------------------------------------------------------ */

interface Source {
  marker: string;
  chunkId: string;
  sectionIndex: number;
  sectionHref: string;
  sectionTitle: string;
  snippet: string;
}

/** 引自第几章。`title` 是那一章在书里印的罗马数字，和目录上的一致。 */
const from = (chapter: number, title: string) => (n: number, snippet: string): Source => ({
  marker: `S${n}`,
  chunkId: `pp-ch${chapter}-${n}`,
  sectionIndex: chapterIndex(chapter),
  sectionHref: chapterHref(chapter),
  sectionTitle: title,
  snippet,
});

const source = from(2, "II");

/**
 * 「他明明说不去」这一轮。首图和上下文图共用它 —— 问题短、答案里三处角标，
 * 缩略之后仍然看得出「每句话都能点回原文」。
 *
 * 问和答都用中文译名（班纳特、宾利、丽萃），原文引用仍是英文 —— 这正是人物
 * 别名表在做的事：书里一个汉字都没有，照样能用中文名问。
 */
const VISIT_SOURCES: Source[] = [
  source(1, "He had always intended to visit him, though to the last always assuring his wife that he should not go"),
  source(2, "till the evening after the visit was paid, she had no knowledge of it"),
  source(3, "I hope Mr. Bingley will like it, Lizzy."),
];

const VISIT_ANSWER = [
  "他从头到尾都打算去，只是嘴上一直说不去 [S1]。",
  "",
  "拜访是他一个人去的，回来也没讲；直到那天傍晚，班纳特太太都还不知道这件事已经办完了 [S2]。",
  "",
  "他挑的揭晓方式也是绕的：先冲正在修帽子的丽萃说了句「不知道宾利先生喜不喜欢」[S3]，等太太把「我们又不去拜访」抱怨完，才顺势把底掀开。",
  "",
  "所以这不是改主意，是他惯常的取乐方式 —— 消息压到最后一刻，看太太先着急。",
].join("\n");

/**
 * 生词清单那一轮。引用图要的是「一次三十几处引用」的密度，所以这轮的角标
 * 多、每条都短。词全部真出现在第二章。
 */
const VOCAB_SOURCES: Source[] = [
  source(11, "Observing his second daughter employed in trimming a hat"),
  source(12, "said her mother resentfully"),
  source(13, "She is a selfish, hypocritical woman, and I have no opinion of her."),
  source(14, "Mrs. Bennet deigned not to make any reply"),
  source(15, "but unable to contain herself, began scolding one of her daughters"),
  source(16, "Have a little compassion on my nerves."),
  source(17, "Kitty has no discretion in her coughs"),
  source(18, "replied Kitty fretfully"),
  source(19, "I honour your circumspection."),
  source(20, "and after all, Mrs. Long and her nieces must stand their chance"),
];

const VOCAB_ANSWER = [
  "这一章里，按你现在的水平大概会挡一下的有十处：",
  "",
  "- **trimming** — 给帽子加装饰、修边 [S11]",
  "- **resentfully** — 带着不满地（说话）[S12]",
  "- **hypocritical** — 表里不一的 [S13]",
  "- **deigned not to** — 不屑于（作答）；deign 是「屈尊做某事」[S14]",
  "- **contain herself** — 忍住、按捺住自己 [S15]",
  "- **compassion** — 体谅、怜悯 [S16]",
  "- **discretion** — 分寸感；这里指「什么时候该咳」的分寸 [S17]",
  "- **fretfully** — 没好气地、烦躁地 [S18]",
  "- **circumspection** — 谨慎周全（Mr. Bennet 在反话）[S19]",
  "- **stand their chance** — 各安天命、碰运气 [S20]",
  "",
  "其中 **deign** 和 **circumspection** 明显高出你现在的等级，但这一章少了它们就读不出 Mr. Bennet 的语气，所以留着了，后面括号里是就地的解释。",
].join("\n");

/**
 * 「他俩最后怎么样」这一轮 —— 第 4 张图（它知道你读到哪）的主角。
 *
 * 问题必须明显指向全书，下面那条「已按你的阅读进度回答」和「结合全书重新回答」
 * 才会出现；而回答本身只许用前 34%（读到第二十一章）已经写出来的东西。五处
 * 引用分别落在第三、六、十六、十八、二十一章，都在这条线以内。
 */
const ENDING_SOURCES: Source[] = [
  from(3, "III")(1, "She is tolerable; but not handsome enough to tempt me"),
  from(6, "VI")(2, "I have been meditating on the very great pleasure which a pair of fine eyes in the face of a pretty woman can bestow."),
  from(16, "XVI")(3, "We are not on friendly terms, and it always gives me pain to meet him"),
  from(18, "XVIII")(4, "she found herself suddenly addressed by Mr. Darcy, who took her so much by surprise in his application for her hand"),
  from(21, "XXI")(5, "The whole party have left Netherfield by this time, and are on their way to town; and without any intention of coming back again."),
];

const ENDING_ANSWER = [
  "到你现在读到的地方，书里还没有写到结果。已经摆出来的是这些：",
  "",
  "**开场是他先得罪了她。** 第一场舞会上宾利劝他去请伊丽莎白跳舞，他当着人说「还行，但没好看到能打动我」[S1]，而这句话她就在旁边听着。",
  "",
  "**他那边先松动。** 到第六章，他已经在跟宾利小姐说一双好看的眼睛能带来多大的乐趣，说的就是她 [S2]。她自己完全不知道。",
  "",
  "**中间又被推远一次。** 韦翰讲了他和达西的旧账，末了那句「我们关系并不好，见到他总让我难受」[S3]，让伊丽莎白更确信自己最初的判断没错。",
  "",
  "**尼日斐的舞会上他主动来请她跳舞**，突然到她没反应过来就答应了 [S4]。",
  "",
  "**然后宾利一家走了。** 卡罗琳的信说他们已经动身进城，而且不打算再回来 [S5] —— 你正读到这里。",
  "",
  "所以现在能确定的只有：两个人的判断都还没修正过。再往后的事，前 34% 里没有。",
].join("\n");

interface PromoMessage {
  id: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  context: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

const userTurn = (id: string, chatId: string, content: string, days: number): PromoMessage => ({
  id,
  chat_id: chatId,
  role: "user",
  content,
  context: null,
  metadata: null,
  created_at: ago(days),
  updated_at: ago(days),
});

/**
 * 助手轮。`metadata` 是应用自己存的那串 JSON —— 界面从它身上解析出角标、
 * 来源行、进度提示，和线上答案回来时走的是同一段代码。
 */
const assistantTurn = (
  id: string,
  chatId: string,
  content: string,
  days: number,
  metadata: Record<string, unknown>,
): PromoMessage => ({
  id,
  chat_id: chatId,
  role: "assistant",
  content,
  context: null,
  metadata: JSON.stringify(metadata),
  created_at: ago(days),
  updated_at: ago(days),
});

export const PROMO_CHATS = [
  {
    id: "promo-ending",
    book_id: "pride-and-prejudice",
    title: "达西和伊丽莎白最后会怎么样",
    model: "harness-model-large",
    pinned: false,
    metadata: null,
    created_at: ago(0),
    updated_at: ago(0),
  },
  {
    id: "promo-visit",
    book_id: "pride-and-prejudice",
    title: "他明明说不去拜访宾利",
    model: "harness-model-large",
    pinned: false,
    metadata: null,
    created_at: ago(1),
    updated_at: ago(1),
  },
  {
    id: "promo-vocab",
    book_id: "pride-and-prejudice",
    title: "这一章我会卡住的词",
    model: "harness-model-large",
    pinned: false,
    metadata: null,
    created_at: ago(3),
    updated_at: ago(3),
  },
];

/**
 * 进度取书架上那本书真实的 34%。`wholeBookIntent` 决定回答下方是那条
 * 「已按你的阅读进度回答」＋「结合全书重新回答」，还是一个静默的徽标 ——
 * 只有问题明显指向全书时才是前者，所以第一轮是 true，生词清单那轮是 false。
 */
const PROGRESS = 34;

export const PROMO_CHAT_MESSAGES: Record<string, PromoMessage[]> = {
  "promo-ending": [
    userTurn("promo-ending-1", "promo-ending", "达西和伊丽莎白最后走到一起了吗？", 0),
    assistantTurn("promo-ending-2", "promo-ending", ENDING_ANSWER, 0, {
      sources: ENDING_SOURCES,
      spoilerGuard: { active: true, wholeBookIntent: true, progress: PROGRESS },
      route: "whole_book",
      sectionIndex: chapterIndex(21),
    }),
  ],
  "promo-visit": [
    userTurn("promo-visit-1", "promo-visit", "班纳特先生前面明明说不去拜访宾利，后来怎么又去了？", 1),
    assistantTurn("promo-visit-2", "promo-visit", VISIT_ANSWER, 1, {
      sources: VISIT_SOURCES,
      spoilerGuard: { active: true, wholeBookIntent: true, progress: PROGRESS },
      route: "whole_book",
      sectionIndex: CH2,
    }),
  ],
  "promo-vocab": [
    userTurn("promo-vocab-1", "promo-vocab", "这一章里有哪些词按我的水平大概会卡住？", 3),
    assistantTurn("promo-vocab-2", "promo-vocab", VOCAB_ANSWER, 3, {
      sources: VOCAB_SOURCES,
      spoilerGuard: { active: true, wholeBookIntent: false, progress: PROGRESS },
      route: "current_section_vocabulary",
      sectionIndex: CH2,
    }),
  ],
};

/* ------------------------------------------------------------------ *
 * 学习卡
 * ------------------------------------------------------------------ */

/**
 * 双击查词时 `ai_learning_card` 返回的东西。字段名和内置模块一一对应，
 * 单词卡默认开的是 context_meaning / word_info / common_senses /
 * collocations / synonyms 这五个。
 *
 * 键是小写后的词。查不到的词返回 null，界面照常走「这次没答上来」的分支 ——
 * 与其临时编一张，不如让缺口自己显出来。
 */
const CARDS: Record<string, unknown> = {
  /**
   * 首图查的词。挑它有两个原因：一是它就在第二章第一句里，和右边那轮对话问的
   * 是同一件事（他到底去没去）；二是这一句真的会读错 —— wait on 不是「等」。
   * 位置也重要：它在左栏，卡片就落在左边，不会盖住右边的 AI 侧栏。
   */
  waited: {
    version: 1,
    kind: "word",
    sourceText: "waited",
    modules: {
      context_meaning: {
        summary: "wait on someone 在这里是「登门拜访」，不是「等某人」——所以这一句已经把结果说了：他去了。",
      },
      word_info: {
        summary: "wait /weɪt/ 动词；这里是短语动词 wait on sb。",
        meta: ["旧式用法", "现代英语里 wait on 多指「伺候」"],
      },
      common_senses: {
        items: [
          { title: "拜访、拜会", text: "wait on sb：旧式的正式登门，本章就是这一种。" },
          { title: "等待", text: "wait for sb 才是「等」——换个介词就换个意思。" },
        ],
      },
      collocations: {
        items: [
          { title: "wait on a new neighbour", text: "上门拜会新搬来的邻居。" },
        ],
      },
      synonyms: {
        summary: "call on 最接近，也是「登门」；visit 中性。",
        meta: ["call on", "pay a call", "visit"],
      },
      source_excerpt: {
        quote: "Mr. Bennet was among the earliest of those who waited on Mr. Bingley.",
      },
    },
  },

  deigned: {
    version: 1,
    kind: "word",
    sourceText: "deigned",
    modules: {
      context_meaning: {
        summary: "这里是「不屑于回话」——deign 指「放下身段去做某件自认掉价的事」，前面加 not 就成了拒绝搭理。",
        details: [
          "Mrs. Bennet 不是没听见，是觉得丈夫这句话不值得接（deem it beneath her，认为有失身份），于是转头去骂女儿。",
          "所以这半句写的是姿态，不是沉默：她在摆架子。",
        ],
      },
      word_info: {
        summary: "deign /deɪn/ 动词，过去式 deigned。",
        meta: ["书面语", "常带轻微的讽刺"],
      },
      common_senses: {
        items: [
          { title: "屈尊做某事", text: "deign to do sth：勉强答应，且暗示做的人觉得自己吃了亏。" },
          { title: "不屑于（否定式）", text: "not deign to：连做都懒得做，本章就是这一种。" },
        ],
      },
      collocations: {
        items: [
          { title: "deign to reply / answer", text: "屈尊作答，最常见的搭配。" },
          { title: "deign to notice", text: "勉强正眼看一下。" },
        ],
      },
      synonyms: {
        summary: "condescend 最接近，也带同一层「自认降格」的意味；stoop 更重，含贬义。",
        meta: ["condescend", "stoop", "consent（中性，不带姿态）"],
      },
      source_excerpt: {
        quote: "Mrs. Bennet deigned not to make any reply; but unable to contain herself, began scolding one of her daughters.",
      },
    },
  },

  circumspection: {
    version: 1,
    kind: "word",
    sourceText: "circumspection",
    modules: {
      context_meaning: {
        summary: "字面是「谨慎周全」，但这句是反话——Mr. Bennet 在笑太太把「认识不认识」看得比什么都重。",
        details: [
          "他上一句刚说「我来替你引荐」，紧接着一句 I honour your circumspection（我敬佩你的审慎），敬佩两个字就是拿来挖苦的。",
          "读到这种词先别急着查褒贬：这本书里越正式的词，越可能是在反着说。",
        ],
      },
      word_info: {
        summary: "circumspection /ˌsɜːkəmˈspekʃn/ 名词，形容词 circumspect。",
        meta: ["正式", "本义中性偏褒"],
      },
      common_senses: {
        items: [
          { title: "审慎、周全", text: "做事之前把四周都看一遍，字面就是 circum（周围）+ spect（看）。" },
        ],
      },
      collocations: {
        items: [
          { title: "with circumspection", text: "谨慎地（做某事）。" },
          { title: "a degree of circumspection", text: "一定程度的审慎，公文里常见。" },
        ],
      },
      synonyms: {
        summary: "prudence 最近，caution 更日常；wariness 偏「戒备」，不合这里的语气。",
        meta: ["prudence", "caution", "wariness"],
      },
      source_excerpt: {
        quote: "“I honour your circumspection. A fortnight’s acquaintance is certainly very little.”",
      },
    },
  },
};

/**
 * 同一个词，按学习者等级换一套内容。
 *
 * 等级换的是「显示哪几块」（见 `src/components/learning-card/level-presets.ts`）：
 * A2 是 当前语境含义 / 全句大意 / 全句脉络 / 单词信息 / 常见释义，C1 换成
 * 当前语境含义 / 用词取舍 / 常用搭配 / 语气与使用场景 / 常见释义。块数一样多，
 * 密度也一样 —— 低一档不是「给少几块」，是先把整句说清楚。
 *
 * 所以这两份不是同一份内容删几行，是各写各的：真让模型按这两套模块生成，出来
 * 的也是两份不同的文字。
 */
const LEVEL_CARDS: Record<string, Record<string, unknown>> = {
  circumspection: {
    A2: {
      version: 1,
      kind: "word",
      sourceText: "circumspection",
      modules: {
        context_meaning: {
          summary: "这个词的意思是「凡事先看看四周再动」的谨慎。但这句不是在夸她——他在拿这个词笑话太太。",
          details: [
            "太太刚说「我自己都不认识他，怎么替人引荐」，他就接了一句「我敬佩你的审慎」。",
            "紧接着他说「你不肯出面，那我自己来」——前面那句敬佩，是为了衬这句。",
          ],
        },
        sentence_gist: {
          summary: "他表面上说「认识才半个月，是不好乱介绍」，其实是在说：那我去。",
        },
        grammar_role: {
          summary: "说话的是父亲 Mr. Bennet；「敬佩」的对象是太太的谨慎，也就是她上一句「我跟人家都不认识」。后半句「认识两周确实太短」是替她把理由补完，好显得他很认真。",
        },
        word_info: {
          summary: "circumspection /ˌsɜːkəmˈspekʃn/ 名词；形容词是 circumspect。",
          meta: ["正式", "circum（周围）+ spect（看）"],
        },
        common_senses: {
          items: [
            { title: "审慎、周全", text: "做事之前把四周都看一遍再决定。" },
            { title: "说话留一手", text: "不把话说死，也算这个词管的范围。" },
          ],
        },
      },
    },

    C1: {
      version: 1,
      kind: "word",
      sourceText: "circumspection",
      modules: {
        context_meaning: {
          summary: "字面是「审慎周全」，这里是反话：他用一个郑重其事的大词，去罩太太那点「没经人介绍就不好开口」的讲究。",
          details: [
            "同一段话里他先敬佩，再替她把理由补完，最后一句才是真的：你不出面，我来。",
            "奥斯汀的讽刺常藏在这种词上——句子越体面，落差越大。",
          ],
        },
        why_this_word: {
          summary: "换成 caution 或 care，就只是「小心」；circumspection 是公文和道德说教里的词，郑重、成体系。把这么大一个词按在一件小事上，敬佩就成了打趣。",
        },
        collocations: {
          items: [
            { title: "with circumspection", text: "谨慎地（做某事），最常见的用法。" },
            { title: "a degree of circumspection", text: "一定程度的审慎，语气克制。" },
          ],
        },
        usage: {
          summary: "正式、偏书面，日常口语基本不用。放进对话里要么显得极郑重，要么像这里一样反着说。",
          meta: ["正式", "常带反讽"],
        },
        common_senses: {
          items: [
            { title: "审慎、周全", text: "circum（周围）+ spect（看）：动手之前先把四周看一遍。" },
          ],
        },
      },
    },
  },
};

/**
 * `level` 传的就是设置里的 `cefr_level`。给了等级、而且这个词备了那一档的内容，
 * 就用那一份；否则回到默认那份（出厂等级 B2 的模块组合）。
 */
export function promoLearningCard(text: unknown, level?: unknown): unknown | null {
  const key = String(text ?? "").trim().toLowerCase().replace(/[^a-z']/g, "");
  const byLevel = level ? LEVEL_CARDS[key]?.[String(level)] : undefined;
  return byLevel ?? CARDS[key] ?? null;
}

/** 首图双击的那个词。放在这里，场景和内容不用两边各写一份。 */
export const HERO_LOOKUP_WORD = "waited";

/**
 * 第 4 张图要点的那个角标。点它有两层作用：既演示「角标能点回原文」，又把
 * 阅读器真的带到第二十一章 —— 那儿正好是全书 34%，和回答下面那句「已按你的
 * 阅读进度回答（前 34%）」对得上。不这么做的话，画面左边停在第二章，右边却
 * 写着 34%，一眼就穿帮。
 */
export const ENDING_JUMP = { marker: 5, sectionIndex: chapterIndex(21) };

/** 第 5 张图要点的那个角标：第二章里 `deigned` 那一句，点完原文就地高亮。 */
export const VOCAB_JUMP = { marker: 14, sectionIndex: CH2 };

/**
 * 卡片宽度设成「紧凑」。默认的「自动」在这本书上会撑到六百多像素，一张卡就把
 * 正文压掉大半 —— 这是设置里真有的一档（划词与卡片 › 卡片设计 › 卡片宽度），
 * 只写这一个字段，其余全部走应用自己的默认值。
 */
export const PROMO_CARD_CONFIG = JSON.stringify({
  version: 2,
  cards: { word: { widthMode: "compact" } },
});
