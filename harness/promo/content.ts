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
import {
  createDefaultCardDesignConfig,
  serializeCardDesignConfig,
} from "../../src/components/learning-card/config";
import { getLearningCardFixture } from "../../src/components/learning-card/fixtures";
import type {
  CustomLearningDefinition,
  CustomLearningId,
} from "../../src/components/learning-card/types";
import { PROMO_COVERS } from "./covers.generated";

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
 * 语言也跟着等级走：中文界面下 A2 推荐中文讲解，C1 推荐全英文（见
 * `recommendedExplanationMode`）。所以 C1 这一份整张是英文的，按后端
 * `explanation_strategy` 给 C1 定的那条来写 —— 用词精确、句子可以复杂一点，
 * 遇到超出 C1 的词就地用更简单的英文加注，不许换成更含糊的词。
 *
 * 所以这两份不是同一份内容删几行，是各写各的：真让模型按这两套模块、这两档
 * 讲解语言生成，出来的也是两份不同的文字。
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
          summary: "Literally the habit of looking all around before acting. Here it is ironic: he wraps his wife's small scruple (a hesitation about what is proper) in a word built for grave decisions.",
          details: [
            "In one speech he first honours her caution, then supplies the reasoning she never offered, and only at the end says what he means: if you will not do it, I will.",
            "Austen's irony often sits in a word like this — the more decorous (polite and correct) the sentence, the wider the gap it hides.",
          ],
        },
        why_this_word: {
          summary: "caution or care would have said only \"being careful\". circumspection belongs to sermons and official prose — weighty and systematic. Set against a fortnight's acquaintance, the compliment turns into teasing.",
        },
        collocations: {
          items: [
            { title: "with circumspection", text: "Carefully, after weighing the situation; the commonest form." },
            { title: "a degree of circumspection", text: "A measured amount of caution, deliberately understated." },
          ],
        },
        usage: {
          summary: "Formal and mainly written; rare in speech. In dialogue it either sounds solemn or, as here, says the opposite of what it states.",
          meta: ["Formal", "Often ironic"],
        },
        common_senses: {
          items: [
            { title: "Careful weighing before acting", text: "circum (around) + spect (look): look all around you before you move." },
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
  // 设置页的预览用的是应用自己的样例词（不是书里的词），单独接一条；样例词取自
  // 那份 fixture 本身，两边不会各写一个。
  if (key === PROMO_PREVIEW_CARD.sourceText.toLowerCase()) return PROMO_PREVIEW_CARD;
  const byLevel = level ? LEVEL_CARDS[key]?.[String(level)] : undefined;
  return byLevel ?? CARDS[key] ?? null;
}

/* ------------------------------------------------------------------ *
 * 用户画像
 * ------------------------------------------------------------------ */

/**
 * 画像页上半段 ——「你写的」。
 *
 * 这一段的意义就在于它是读者自己敲的：总结器一个字都不会改它，冲突时也以它
 * 为准。所以这里写成一个人真会写的样子（三行、口语、有具体忌讳），而不是一段
 * 演示文案。
 */
const PROMO_PROFILE_TEXT = [
  "我在准备雅思，读小说是为了适应长句子，不是为了背单词。",
  "讲解直接说这句在讲什么就行，语法术语能少则少。",
  "古典小说里的称呼和礼节我不熟，遇到了帮我点一句。",
].join("\n");

/**
 * 下半段 —— 七个维度里系统真总结出结论的那三个。
 *
 * 一个维度没攒够记录就不该有卡片，所以这里只有三张，剩下四个维度在页面上
 * 干脆不出现 —— 这正是画像页的常态，凑满七张反而是假的。
 *
 * `evidence` 是总结器写结论时顺手写下的那一句自述；`hasEvidence` 说的是它当时
 * 读的那份聚合记录还留着（migration 068），也就是「查看原始记录」点不点得开。
 */
const PROMO_PROFILE_CARDS = [
  {
    slot: "syntax_explain",
    conclusion: "长句先给主干，再挂修饰成分；语法术语能省则省。",
    evidence: "多次在分词短语和从句上追问「这半句挂在谁身上」",
    status: "active",
    updatedAt: ago(2),
    hasEvidence: true,
  },
  {
    slot: "cultural_context",
    conclusion: "遇到称呼、登门、婚事上的规矩，补一句当时的背景再讲句子。",
    evidence: "在几处称谓和拜访礼节上主动追问",
    status: "active",
    updatedAt: ago(2),
    hasEvidence: true,
  },
  {
    slot: "example_source",
    conclusion: "举例取正在读的这本书，不另找例句。",
    evidence: "近三个月的阅读几乎都在书架上的三本小说里",
    status: "active",
    updatedAt: ago(2),
    hasEvidence: true,
  },
];

/**
 * 「查看原始记录」点开之后那一块 —— 写这条结论时模型读到的那份聚合记录。
 *
 * 抽出来的原文一律逐字出自《Pride and Prejudice》第二十一章以前：书架上那本
 * 正读到 34%，画像不该引用读者还没读到的地方。数字之间也要自洽 —— 抽样条数
 * 就是下面 `sampled_examples` 的实际条数，不是另写一个好看的数。
 */
export const PROMO_PROFILE_EVIDENCE: Record<string, { kind: string; payload: unknown }> = {
  syntax_explain: {
    kind: "followup",
    payload: {
      count: 14,
      weighted_count: 9.6,
      sampled_examples: [
        {
          passage: "He had always intended to visit him, though to the last always assuring his wife that he should not go",
          question: "though 后面这半句的主语还是他吗？",
        },
        {
          passage: "Mrs. Bennet deigned not to make any reply; but unable to contain herself, began scolding one of her daughters.",
          question: "unable to contain herself 挂在谁身上？",
        },
      ],
    },
  },
  cultural_context: {
    kind: "followup",
    payload: {
      count: 6,
      weighted_count: 4.1,
      sampled_examples: [
        {
          passage: "Mr. Bennet was among the earliest of those who waited on Mr. Bingley.",
          question: "拜访新邻居为什么非得男主人先去一趟？",
        },
        {
          passage: "A fortnight’s acquaintance is certainly very little.",
          question: "认识两周就不能替人引荐，是当时的规矩吗？",
        },
      ],
    },
  },
  example_source: {
    kind: "example_source",
    payload: {
      // 书架上真的在读的三本，顺序和占比取自它们的阅读状态（34% / 12% / 61%
      // 那三本），书名作者直接取自 EPUB 自己的元数据。
      top_books: [
        { title: PROMO_COVERS["pride-and-prejudice"].title, author: PROMO_COVERS["pride-and-prejudice"].author, share: 0.52 },
        { title: PROMO_COVERS["emma"].title, author: PROMO_COVERS["emma"].author, share: 0.29 },
        { title: PROMO_COVERS["heart-of-darkness"].title, author: PROMO_COVERS["heart-of-darkness"].author, share: 0.19 },
      ],
    },
  },
};

/**
 * `profile_get` 在拍样张时返回的东西，字段和 `ProfileView`（`profile.rs`）
 * 一一对应。
 *
 * 草稿和正文写成一样的：两者不一致是另一种状态（「上次没保存完，已恢复」），
 * 那是 smoke 那份 fixture 要覆盖的，不是这张图要讲的。上次总结的时间和
 * 「查看原始记录」里那句「记录快照留于…」都是两天前，对得上。
 */
export function promoProfileView(): Record<string, unknown> {
  return {
    userText: PROMO_PROFILE_TEXT,
    draftText: PROMO_PROFILE_TEXT,
    enabled: true,
    softLimit: 500,
    hardLimit: 1000,
    cards: PROMO_PROFILE_CARDS,
    newFollowupsSinceLastBatch: 9,
    lastSummarizedAt: ago(2),
    revisionCount: 4,
    batchSize: 20,
  };
}

/* ------------------------------------------------------------------ *
 * 生词与掌握度
 * ------------------------------------------------------------------ */

/**
 * 生词本里的词。全部出自第二、三、六章 —— 也就是书架上那本书已经读过的部分，
 * 而且每个词的原文都逐字抄自上面对话里已经用过的那几句，不另找。
 *
 * 释义写成应用自己存的那种格式：首行 `/音标/ 词性. 一句话`，空行之后是补充。
 * 折叠时列表只取首行，展开才看得到后面 —— 这个切分是 `entry-text.ts` 做的，
 * 不是这里排版排出来的。
 */
interface VocabSpec {
  word: string;
  mastery: "new" | "learning" | "familiar" | "mastered";
  definition: string;
  context: string;
  /** 「在这一句里」那一段。没有就不渲染那一节。 */
  inContext?: string;
  /** 收藏于几天前。 */
  saved: number;
  /** 距离下次复习几天；负数表示已经到期。 */
  due: number;
}

const PROMO_VOCAB_SPECS: VocabSpec[] = [
  {
    // 第 6 张图的主角。它的故事是完整的：查过两次 → 复习记住 → 换一本书里连着
    // 读到六次都没再查，于是自动升到「读顺了」。
    word: "tolerable",
    mastery: "mastered",
    definition:
      "/ˈtɒlərəbl/ adj. 还过得去、说得上尚可 —— 不是「可以忍受」。\n\n" +
      "奥斯汀笔下这个词是「够格但不出众」，用来打发人正合适：它没说难看，也一点都不算夸。",
    context: "She is tolerable; but not handsome enough to tempt me",
    inContext:
      "达西这句话的杀伤力全在 **tolerable** 上。他没说她丑，他说的是「还行」—— 而这句话伊丽莎白就在旁边听着。",
    saved: 21,
    due: 26,
  },
  {
    word: "waited",
    mastery: "familiar",
    definition:
      "/weɪt/ v. wait on sb 是「登门拜访」，不是「等某人」。\n\n" +
      "旧式的正式用法；现代英语里 wait on 多指「伺候」，换成 wait for 才是等。",
    context: "Mr. Bennet was among the earliest of those who waited on Mr. Bingley.",
    inContext: "这一句其实已经把结果说了：他去了 —— 读成「等宾利先生」就整段反了。",
    saved: 12,
    due: -1,
  },
  {
    word: "deigned",
    mastery: "learning",
    definition:
      "/deɪn/ v. 屈尊做某事；否定式 not deign to 是「不屑于」。\n\n" +
      "书面语，常带一点讽刺 —— 说的人自认为掉了价。",
    context: "Mrs. Bennet deigned not to make any reply",
    inContext: "她不是没听见，是觉得这句话不值得接。所以这半句写的是姿态，不是沉默。",
    saved: 9,
    due: -2,
  },
  {
    word: "circumspection",
    mastery: "learning",
    definition:
      "/ˌsɜːkəmˈspekʃn/ n. 审慎周全。\n\n" +
      "circum（周围）+ spect（看）：做事之前先把四周看一遍。",
    context: "I honour your circumspection.",
    inContext: "这一句是反话 —— 班纳特先生在笑太太把「认识不认识」看得比什么都重。",
    saved: 9,
    due: 1,
  },
  {
    word: "discretion",
    mastery: "familiar",
    definition: "/dɪˈskreʃn/ n. 分寸感；什么时候该做、什么时候不该做的那种拿捏。",
    context: "Kitty has no discretion in her coughs",
    saved: 7,
    due: 4,
  },
  {
    word: "bestow",
    mastery: "new",
    definition: "/bɪˈstəʊ/ v. 给予、赋予（正式，常搭 bestow sth on sb）。",
    context:
      "I have been meditating on the very great pleasure which a pair of fine eyes in the face of a pretty woman can bestow.",
    saved: 1,
    due: 0,
  },
];

const HERO_BOOK = PROMO_COVERS["pride-and-prejudice"];
const SECOND_BOOK = PROMO_COVERS["emma"];

/** 第 6 张图展开的那个词。场景按它找行，不写死在两个地方。 */
export const MASTERY_WORD = "tolerable";

/**
 * 那条自动升档的依据。存进 `vocab_words.mastery_reason` 的就是这么一串 JSON
 * （migration 038），界面拿它渲染卡片上那句紫色的「因为……」。
 */
const EXPOSURE_REASON = JSON.stringify({
  reason: "exposure_promotion",
  book_title: SECOND_BOOK.title,
  distinct_days: 9,
  exposures: 6,
});

function promoVocabWord(spec: VocabSpec) {
  return {
    id: `promo-vw-${spec.word}`,
    word: spec.word,
    normalized_word: spec.word.toLowerCase(),
    lemma: spec.word.toLowerCase(),
    language: "en",
    definition: spec.definition,
    translation: null,
    phonetic: null,
    context_sentence: spec.context,
    context_explanation: spec.inContext ?? null,
    book_id: "pride-and-prejudice",
    book_title: HERO_BOOK.title,
    cfi: "epubcfi(/6/8!/4/2/2)",
    list_status: "confirmed",
    mastery: spec.mastery,
    // 只有阅读曝光引擎会写 auto。这里唯一那个 auto 就是主角词，「自动判定」
    // 的徽标因此只落在它一行上 —— 全列表都挂着才是假的。
    mastery_source: spec.word === MASTERY_WORD ? "auto" : "manual",
    mastery_reason: spec.word === MASTERY_WORD ? EXPOSURE_REASON : null,
    review_count: spec.mastery === "new" ? 0 : 2,
    created_at: ago(spec.saved),
    updated_at: ago(spec.saved),
    last_reviewed_at: spec.mastery === "new" ? null : ago(Math.min(spec.saved, 8)),
    next_review_at: Date.now() + spec.due * DAY,
    review_interval_days: Math.max(spec.due, 0),
    last_review_rating: spec.mastery === "new" ? null : "good",
    notes: null,
    tags: [],
    source: "reader",
  };
}

export const promoVocabWords = () => PROMO_VOCAB_SPECS.map(promoVocabWord);

/**
 * 「它是怎么走到这一步的」那条时间线（`mastery_events`，migration 038）。
 *
 * 三条事件是一条能站住的线：先查了两次被记下来，再复习时评成「掌握」，最后
 * 换到《Emma》里连着读到六次都没查 —— 所以最后一档是应用自己升的，不是谁点的。
 * `detail` 里的字段就是界面拿去填那句话的参数，没有一个是装饰。
 */
const masteryEvent = (
  n: number,
  from: string,
  to: string,
  source: "auto" | "manual" | "review",
  reason: string,
  detail: Record<string, unknown>,
  days: number,
) => ({
  id: `promo-me-${n}`,
  vocab_word_id: `promo-vw-${MASTERY_WORD}`,
  from_mastery: from,
  to_mastery: to,
  source,
  reason,
  detail: JSON.stringify(detail),
  created_at: ago(days),
});

/** 界面按 `created_at` 原样铺，所以这里就是从早到晚。 */
export const PROMO_MASTERY_EVENTS = [
  masteryEvent(1, "new", "learning", "auto", "watchlist_promoted", {
    book_title: HERO_BOOK.title,
    lookup_count: 2,
  }, 21),
  masteryEvent(2, "learning", "familiar", "review", "review_promotion", { rating: "good" }, 12),
  masteryEvent(3, "familiar", "mastered", "auto", "exposure_promotion", {
    book_title: SECOND_BOOK.title,
    distinct_days: 9,
    exposures: 6,
  }, 2),
];

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

/* ------------------------------------------------------------------ *
 * 自定义模块（第 8 张图）
 * ------------------------------------------------------------------ */

/**
 * 第 8 张图里那个自己造的模块。
 *
 * 内容和这批图里的读者是同一个人：他在画像里写着「我在准备雅思」，书架上却全是
 * 一两百年前的小说 —— 从旧小说里学来的词能不能写进今天的作文，内置模块一个都
 * 不管（「语气与使用场景」讲的是语域，不是年代）。所以他自己造了一个。
 *
 * 选题要躲开内置模块：句子结构有「全句脉络」、词根构词有「词形与构词」，再造
 * 一个同义的模块，这张图就成了自己和自己重复。
 *
 * id 的格式是应用自己认的那一套（`custom_` 开头，见 `config.ts` 的 `isCustomId`）；
 * 真机上是个 uuid，这里给个念得出来的名字，图上也看不见 id。
 */
const CUSTOM_MODULE_ID = "custom_stillsaid" as CustomLearningId;

const CUSTOM_MODULE: CustomLearningDefinition = {
  name: "现在还这么说吗",
  // 五行，是照着输入框的高度写的：那个 textarea 是 rows=5，多一行就得往里滚，
  // 图上会切出半截字。样张里的提示词要一眼看完，所以每一条都压在一行之内。
  prompt: [
    "我在准备雅思，可读的是一两百年前的小说。就选中的这个词：",
    "1. 今天的英语里还常用吗，还是基本只出现在旧书里。",
    "2. 现在少用了的话，日常和考试作文里通常换成什么说法。",
    "3. 词还在用但味道变了的，说清楚现在听起来是什么感觉。",
    "拿不准就直说拿不准，别编。",
  ].join("\n"),
  createdAt: ago(23),
  updatedAt: ago(4),
};

/**
 * 点「生成真实预览」时那一次 `ai_learning_card` 的答案。
 *
 * 预览面板问的是应用自己的样例词 `render`（`getLearningCardFixture`），所以内置
 * 那几块直接用应用自带的那份 —— 图上不该出现第二套样例内容。这里只多加读者那个
 * 模块的产出，而且只用「这一个词」答得出来的东西：预览这一路传给模型的
 * `context` 就是这个词本身，编一段需要上下文才写得出的答案，图就在撒谎了。
 */
export const PROMO_PREVIEW_CARD = (() => {
  const fixture = getLearningCardFixture("word", "zh");
  return {
    ...fixture,
    modules: {
      ...fixture.modules,
      [CUSTOM_MODULE_ID]: {
        summary: "还在用，但已经偏书面；日常说「翻译」用 translate。",
        details: [
          "render the tone 这类「表达、译出」的用法今天基本只出现在书面语里，口语很少这么说。",
          "雅思作文里想说翻译、表达，用 translate、express 更稳；render 拿不准会显得端着。",
          "反倒是电脑上的「渲染」（render an image）成了这个词今天最常见的用法。",
        ],
      },
    },
  };
})();

/**
 * 第 8 张图的卡片设置：出厂默认，加上那个自定义模块。
 *
 * 两点是刻意的：
 *  - 底子用 `createDefaultCardDesignConfig()`，不是手写一份。所以图上开着的
 *    五块、关着的八块，就是这个应用装完之后的样子。
 *  - 自定义模块插在「当前语境含义」后面，不是排在最后 —— 它和内置模块同级，
 *    能排在任何位置，这一点得让图自己说出来。
 */
export const PROMO_CARD_CONFIG_CUSTOM = (() => {
  const config = createDefaultCardDesignConfig();
  const word = config.cards.word;
  const modules = [...word.modules];
  const at = modules.findIndex((module) => module.id === "context_meaning") + 1;
  // 密度单独调成「详细」：这张卡整体是「精简」（出厂默认），而这个模块一次要
  // 回答三个问题，跟着精简就只剩一句话。每个模块的密度本来就能各调各的，图上
  // 顺便把这件事说了。
  modules.splice(at, 0, {
    id: CUSTOM_MODULE_ID,
    enabled: true,
    defaultExpanded: true,
    density: "detailed",
  });
  return serializeCardDesignConfig({
    ...config,
    cards: {
      ...config.cards,
      word: {
        ...word,
        widthMode: "compact",
        modules,
        customModules: { [CUSTOM_MODULE_ID]: CUSTOM_MODULE },
      },
    },
  });
})();

/** 场景要点开的就是这一行。名字只写一处，图和数据不会各说各的。 */
export const PROMO_CUSTOM_MODULE_NAME = CUSTOM_MODULE.name;
