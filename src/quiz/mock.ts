import type { Quiz, QuizConfig, QuizWord } from './types.ts'
import type { ArticleStep, ProgressFn } from './generate.ts'

/**
 * 演示模式：不调 API，用内置样卷把「出题 → 作答 → 判分 → 错词入池」整条链路跑通。
 * 迁自 labs/cijuan/src/llm/mock.ts。用途收窄为**仅供自动化测试**（拍板 D，
 * docs/impls/cijuan-merge.md §五）——Lantern 用户已有配好的 AI 线路，设置里
 * 不再暴露"演示模式"开关；这里不做两阶段拆分，样卷本身已经是"解析生成完成"
 * 后的最终形态，供 grading / UI 组件测试直接使用。
 */

export const DEMO_WORDS: QuizWord[] = [
  { word: 'subsidy', origin: 'today' },
  { word: 'allocate', origin: 'today' },
  { word: 'curb', origin: 'recur' },
  { word: 'deteriorate', origin: 'today' },
  { word: 'advocate', origin: 'today' },
  { word: 'plausible', origin: 'today' },
  { word: 'scrutiny', origin: 'today' },
  { word: 'vulnerable', origin: 'today' },
  { word: 'mitigate', origin: 'today' },
]

const STEP_DELAY_MS = 700

export async function generateMockQuiz(opts: {
  words: QuizWord[]
  config: QuizConfig
  onProgress?: ProgressFn
}): Promise<Quiz> {
  const progress = opts.onProgress ?? (() => {})
  const wait = () => new Promise((r) => setTimeout(r, STEP_DELAY_MS))
  // 与真实编排同形的事件流：拆词 → 两篇（对应样卷的两篇文章）各自 写稿 → 校验 → 完成
  progress({ type: 'splitting' })
  await wait()
  progress({ type: 'split', articles: [{ wordCount: 5 }, { wordCount: 4 }] })
  const steps: ArticleStep[] = ['writing', 'checking', 'done']
  for (const s of steps) {
    // 样卷永远一次成，没有重试这回事——两篇都固定停在第 1 次尝试
    progress({ type: 'article', index: 0, step: s, attempt: 1 })
    progress({ type: 'article', index: 1, step: s, attempt: 1 })
    if (s !== 'done') await wait()
  }
  progress({ type: 'done' })
  return {
    ...structuredClone(MOCK_QUIZ),
    createdAt: new Date().toISOString(),
    // 样卷的题永远考 DEMO_WORDS，词表必须与之一致；demo 标记让交卷时跳过错词池，
    // 免得演示词混进真实数据、两天后被注入付费生成的新卷
    config: { ...opts.config, model: 'demo', demo: true },
    words: DEMO_WORDS,
  }
}

const MOCK_QUIZ: Quiz = {
  createdAt: '',
  config: {
    difficulty: 'cet6',
    types: ['reading', 'grammarFill'],
    materialSource: 'ai-original',
    model: 'demo',
    maskedCheck: true,
  },
  words: DEMO_WORDS,
  status: 'ready',
  passages: [
    {
      id: 'psg-demo-1',
      title: 'Why Cities Are Rethinking Farm Subsidies',
      targetWords: ['subsidy', 'allocate', 'curb', 'deteriorate'],
      paragraphs: [
        'For decades, the national government has offered a generous subsidy to small farms, hoping that direct payments would keep rural communities alive.',
        'Critics argue that the money is poorly targeted. Nearly half of the fund is allocated to large agricultural companies, while family farms receive only a fraction. To curb this imbalance, lawmakers have proposed strict income caps.',
        'Supporters of reform advocate a different approach: instead of cash, the state should offer training and equipment. Without such changes, they warn, rural economies will continue to deteriorate.',
      ],
    },
    {
      id: 'psg-demo-2',
      title: 'The Quiet Comeback of Urban Bees',
      targetWords: ['plausible', 'scrutiny', 'vulnerable'],
      paragraphs: [
        'City beekeeping once sounded like a hobby for eccentrics, but the idea that rooftops could host productive hives now seems entirely plausible.',
        'The trend has not escaped scrutiny. Ecologists point out that honeybees may compete with wild pollinators, which are far more vulnerable to habitat loss.',
        'Some councils have therefore shifted their support: residents are encouraged to plant wildflowers instead of keeping hives of their own.',
      ],
    },
  ],
  readingQuestions: [
    {
      id: 'rq-demo-1',
      type: 'reading',
      passageId: 'psg-demo-1',
      targetWord: 'subsidy',
      stem: 'The word "subsidy" in paragraph 1 is closest in meaning to ____.',
      stemTranslation: '第 1 段中的 subsidy 一词与下面哪个选项意思最接近？',
      howToSolve: '回到第 1 段找到 subsidy 所在句，把四个选项与它逐一对照，找同义改写。',
      wordNote: 'subsidy n. 补贴、津贴：政府给个人或企业的资金支持，常见搭配 government subsidy。',
      options: [
        {
          label: 'A',
          text: 'financial support',
          meaning: '资金支持',
          note: '正确：¶1 说政府用 direct payments（直接付款）维持乡村社区，subsidy 就是资金支持。',
        },
        {
          label: 'B',
          text: 'legal advice',
          meaning: '法律咨询',
          note: '原文与法律无关；把 subsidy 联想成「咨询、顾问」的人会误选。',
        },
        {
          label: 'C',
          text: 'technical inspection',
          meaning: '技术检查',
          note: '把 subsidy 误记成「审查、检查」的人会掉进来。',
        },
        {
          label: 'D',
          text: 'tax penalty',
          meaning: '税务处罚',
          note: '与补贴的意思恰好相反；把 subsidy 记成「罚款」的人会选它。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-1',
        paragraph: 1,
        quote:
          'For decades, the national government has offered a generous subsidy to small farms, hoping that direct payments would keep rural communities alive.',
      },
    },
    {
      id: 'rq-demo-2',
      type: 'reading',
      passageId: 'psg-demo-1',
      targetWord: 'allocate',
      stem: 'According to paragraph 2, critics complain that nearly half of the fund is ____.',
      stemTranslation: '根据第 2 段，批评者抱怨近一半的资金被怎样处理了？',
      howToSolve: '在第 2 段找到 fund 所在句，正确选项是原文 allocated 的同义改写。',
      wordNote: 'allocate v. 分配、拨给：把资源分给特定对象，常见搭配 allocate funds to…。',
      options: [
        {
          label: 'A',
          text: 'distributed to large companies',
          meaning: '被分配给大公司',
          note: '正确：原文 "allocated to large agricultural companies"，distribute 是 allocate 的同义替换。',
        },
        {
          label: 'B',
          text: 'borrowed by lawmakers',
          meaning: '被议员借走',
          note: '原文没有「借钱」一说；看不懂 allocated 只能乱猜的人容易选它。',
        },
        {
          label: 'C',
          text: 'spent on training programs',
          meaning: '花在培训项目上',
          note: '培训是第 3 段改革者的提议，不是资金的现状；张冠李戴型干扰。',
        },
        {
          label: 'D',
          text: 'returned to taxpayers',
          meaning: '退还给纳税人',
          note: '原文完全未提，纯干扰项。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-1',
        paragraph: 2,
        quote:
          'Nearly half of the fund is allocated to large agricultural companies, while family farms receive only a fraction.',
      },
    },
    {
      id: 'rq-demo-3',
      type: 'reading',
      passageId: 'psg-demo-1',
      targetWord: 'curb',
      stem: 'The income caps proposed by lawmakers are intended to ____ the imbalance.',
      stemTranslation: '议员提出的收入上限，意在对这种失衡做什么？',
      howToSolve: '回到第 2 段找到 curb 所在句（"To curb this imbalance"），题目问的就是 curb 本身的意思。',
      wordNote: 'curb v. 遏制、抑制：常见搭配 curb inflation（遏制通胀）、curb spending。',
      options: [
        {
          label: 'A',
          text: 'restrain',
          meaning: '约束、抑制',
          note: '正确：curb = restrain，收入上限就是为了约束这种失衡。',
        },
        {
          label: 'B',
          text: 'conceal',
          meaning: '掩盖、隐藏',
          note: '把 curb 记成「掩盖」的人会选它；原文是要解决失衡，不是藏起来。',
        },
        {
          label: 'C',
          text: 'measure',
          meaning: '衡量、测量',
          note: '把 curb 记成「衡量」的人会选它；上限是限制手段，不是测量工具。',
        },
        {
          label: 'D',
          text: 'publicize',
          meaning: '公开、宣传',
          note: '与原文无关，纯干扰项。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-1',
        paragraph: 2,
        quote: 'To curb this imbalance, lawmakers have proposed strict income caps.',
      },
    },
    {
      id: 'rq-demo-4',
      type: 'reading',
      passageId: 'psg-demo-1',
      targetWord: 'deteriorate',
      stem: 'Reformers warn that without changes, rural economies will ____.',
      stemTranslation: '改革者警告：如果不做出改变，乡村经济将会怎样？',
      howToSolve: '回到第 3 段找到警告所在句，题目问的就是 deteriorate 的意思。',
      wordNote: 'deteriorate v. 恶化、变坏：health/economy deteriorates，不及物动词。',
      options: [
        {
          label: 'A',
          text: 'get steadily worse',
          meaning: '持续变坏',
          note: '正确：原文 "will continue to deteriorate"，deteriorate 就是逐渐恶化。',
        },
        {
          label: 'B',
          text: 'expand rapidly',
          meaning: '快速扩张',
          note: '把 deteriorate 误记成「发展、扩张」的人恰好会选它，方向完全相反。',
        },
        {
          label: 'C',
          text: 'remain unchanged',
          meaning: '保持不变',
          note: '原文说的是持续变化（变坏），不是停滞。',
        },
        {
          label: 'D',
          text: 'attract more investment',
          meaning: '吸引更多投资',
          note: '原文未提投资，纯干扰项。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-1',
        paragraph: 3,
        quote: 'Without such changes, they warn, rural economies will continue to deteriorate.',
      },
    },
    {
      id: 'rq-demo-5',
      type: 'reading',
      passageId: 'psg-demo-2',
      targetWord: 'plausible',
      stem: 'The word "plausible" in paragraph 1 most nearly means ____.',
      stemTranslation: '第 1 段中的 plausible 一词最接近哪个意思？',
      howToSolve: '找到 plausible 所在句，注意「过去像怪人的爱好」与「如今 entirely ____」的前后对照。',
      wordNote: 'plausible adj. 貌似可信的、说得通的：a plausible explanation（说得通的解释）。',
      options: [
        {
          label: 'A',
          text: 'believable',
          meaning: '可信的',
          note: '正确：句子说这个想法从「怪人的爱好」变得 entirely plausible，即完全可信了。',
        },
        {
          label: 'B',
          text: 'profitable',
          meaning: '有利可图的',
          note: 'plausible 与 profitable 形近，记混的人会选它；原文没谈赚钱。',
        },
        {
          label: 'C',
          text: 'illegal',
          meaning: '非法的',
          note: '原文没有任何法律色彩，纯干扰项。',
        },
        {
          label: 'D',
          text: 'temporary',
          meaning: '临时的',
          note: '原文没谈时间长短，纯干扰项。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-2',
        paragraph: 1,
        quote:
          'City beekeeping once sounded like a hobby for eccentrics, but the idea that rooftops could host productive hives now seems entirely plausible.',
      },
    },
    {
      id: 'rq-demo-6',
      type: 'reading',
      passageId: 'psg-demo-2',
      targetWord: 'scrutiny',
      stem: '"The trend has not escaped scrutiny" (paragraph 2) suggests that urban beekeeping ____.',
      stemTranslation: '第 2 段「这股潮流没有逃过 scrutiny」暗示城市养蜂怎么了？',
      howToSolve: '先按字面理解 escape scrutiny（逃过 ____），再看下文生态学家的质疑印证了什么。',
      wordNote: 'scrutiny n. 仔细审视、细查：under scrutiny 受到审查，常与 escape/come under 搭配。',
      options: [
        {
          label: 'A',
          text: 'has been closely examined',
          meaning: '受到了仔细审视',
          note: '正确：「没有逃过 scrutiny」= 被仔细审视了，下文生态学家的质疑正是审视的内容。',
        },
        {
          label: 'B',
          text: 'has been officially banned',
          meaning: '被官方禁止了',
          note: '把 scrutiny 记成「禁令」的人会选它；文中议会只是转变支持方式，没有禁止。',
        },
        {
          label: 'C',
          text: 'has lost its popularity',
          meaning: '失去了人气',
          note: '原文说的是受到审视，不是失宠。',
        },
        {
          label: 'D',
          text: 'has become too expensive',
          meaning: '变得太昂贵',
          note: '原文没谈成本，纯干扰项。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-2',
        paragraph: 2,
        quote: 'The trend has not escaped scrutiny.',
      },
    },
    {
      id: 'rq-demo-7',
      type: 'reading',
      passageId: 'psg-demo-2',
      targetWord: 'vulnerable',
      stem: 'According to ecologists, wild pollinators are ____.',
      stemTranslation: '根据生态学家的说法，野生传粉昆虫是怎样的？',
      howToSolve: '在第 2 段找到 wild pollinators 所在句，正确选项是 vulnerable to habitat loss 的同义改写。',
      wordNote: 'vulnerable adj. 脆弱的、易受伤害的：be vulnerable to…（易受…的伤害）。',
      options: [
        {
          label: 'A',
          text: 'easily harmed by habitat loss',
          meaning: '容易被栖息地丧失伤害',
          note: '正确：原文 "far more vulnerable to habitat loss"，即更容易受栖息地丧失的伤害。',
        },
        {
          label: 'B',
          text: 'immune to environmental change',
          meaning: '对环境变化免疫',
          note: 'immune（免疫的）正是 vulnerable 的反义词；记反了词义的人会选它。',
        },
        {
          label: 'C',
          text: 'more productive than honeybees',
          meaning: '比蜜蜂更高产',
          note: '原文比的是「谁更脆弱」，不是产量。',
        },
        {
          label: 'D',
          text: 'responsible for habitat loss',
          meaning: '对栖息地丧失负有责任',
          note: '因果颠倒：它们是受害者，不是肇事者。',
        },
      ],
      answer: 'A',
      source: {
        passageId: 'psg-demo-2',
        paragraph: 2,
        quote:
          'Ecologists point out that honeybees may compete with wild pollinators, which are far more vulnerable to habitat loss.',
      },
    },
  ],
  grammarQuestions: [
    {
      id: 'gq-demo-1',
      type: 'grammarFill',
      passageId: 'psg-demo-1',
      targetWord: 'advocate',
      sentence: 'Since 2019, reform groups ____ (advocate) replacing cash payments with training programs.',
      sentenceTranslation: '自 2019 年以来，改革团体一直倡导用培训项目取代现金补贴。',
      hint: 'advocate',
      answer: 'have advocated',
      grammarPoints: ['现在完成时'],
      reasoning: [
        '先认词：advocate 是动词「倡导、主张」，这里作谓语，后接动名词 replacing。',
        'Since 2019 表示动作从 2019 年一直持续到现在，要用现在完成时。',
        '主语 reform groups 是复数，助动词用 have，故填 have advocated。',
      ],
      wrongForms: [
        { form: 'advocated', note: '漏掉 have：单独的过去式表达不了「持续到现在」，since 短语要求完成时。' },
        { form: 'advocate', note: '原形当一般现在时用，与 since 2019 的持续含义冲突。' },
      ],
      wordMeaning: 'advocate v. 倡导、主张（也可作名词「倡导者」，此处是动词）。',
    },
    {
      id: 'gq-demo-2',
      type: 'grammarFill',
      passageId: 'psg-demo-2',
      targetWord: 'mitigate',
      sentence: 'Unless the risks ____ (mitigate) in time, the entire project will be suspended.',
      sentenceTranslation: '除非这些风险被及时缓解，否则整个项目将被叫停。',
      hint: 'mitigate',
      answer: 'are mitigated',
      grammarPoints: ['被动语态', '条件句时态'],
      reasoning: [
        '先认词：mitigate 是及物动词「缓解、减轻」。',
        'risks 是被缓解的对象，不会自己缓解自己，需要被动语态 be mitigated。',
        'unless 引导的条件句用一般现在时代替将来时，主语 risks 是复数，故填 are mitigated。',
      ],
      wrongForms: [
        { form: 'mitigate', note: '主动原形：risks 与 mitigate 是被动关系，必须用被动语态。' },
        { form: 'will be mitigated', note: '条件句里不用 will，要用一般现在时代替将来时。' },
      ],
      wordMeaning: 'mitigate v. 缓解、减轻（风险、影响、损失）。',
    },
  ],
}
