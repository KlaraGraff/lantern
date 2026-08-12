import type {
  Difficulty,
  GrammarFillQuestion,
  Passage,
  QuestionType,
  ReadingQuestion,
} from './types.ts'

/**
 * 提示词是这个产品的核心资产：
 * 「考点约束」——每道题必须做到不认识目标词就答不出来——全靠这里成立。
 *
 * 迁自 labs/cijuan/src/llm/prompts.ts，讲解口径原样保留。相对原版的结构变化：
 * 原版一次调用生成「文章+题目+全部解析」；这里拆成两阶段（docs/impls/cijuan-merge.md
 * §二.6）——阶段一只出文章+题目+答案（buildGeneratePrompt，不含 EXPLANATION_RULES），
 * 阶段二以「续写同一对话」的形态单独请求解析（buildExplanationPrompt）。
 * 新增 buildAnswerCheckPrompt：阶段一收卷前的「明答校验」，与遮词自检互补。
 */

export const DIFFICULTY_PROFILES: Record<Difficulty, string> = {
  cet4: '大学英语四级（CET-4）：文章 250-300 词，句式平实，题目口吻仿四级真题',
  cet6: '大学英语六级（CET-6）：文章 300-400 词，允许复合句与抽象话题，题目口吻仿六级真题',
  ielts:
    '雅思（IELTS）学术类：文章 350-450 词，信息密度高、学术语域，题目口吻仿雅思阅读（细节题/推断题）',
  kaoyan:
    '考研英语一：文章 350-450 词，长难句多、逻辑绕，干扰项设计仿考研阅读（偷换概念、以偏概全）',
}

const EXAM_POINT_RULES = `## 考点约束（最重要的规则，逐条服从）

1. 每道题绑定一个目标词（targetWord）。判定标准：**如果考生不认识这个词的意思，这道题必然做错或只能瞎猜**。
2. 阅读题合格的出题方式（任选其一）：
   - 词义决定推断：目标词所在句是答案的唯一依据，选项在「认识该词」与「不认识该词」之间产生分歧；
   - 同义替换：正确选项用目标词的同义改写，干扰项用形近词或常见误译的改写；
   - 态度/逻辑题：目标词是褒贬或转折的关键信号词。
3. 不合格（禁止出现）的出题方式：
   - 答案能靠上下文其他句子推出来，目标词可有可无；
   - 考文章主旨、段落结构等与目标词无关的能力；
   - 选项本身泄露答案（长度、语气差异明显）。
4. 干扰项必须「像真的」：用目标词的常见误记词义、形近词词义来造干扰项，让记错词义的人恰好掉进去。
5. 语法填空：句子语境必须依赖目标词词义才能确定该用的形态（时态/语态/词性转换），提示给原形。
6. 每个目标词必须被且仅被一道题考到：适合形态变化的词（动词、可派生的形容词/名词）优先分给语法填空（若该题型启用），其余进阅读题。`

const SOURCE_RULES = `## 溯源要求
- 每道阅读题给出 sourceParagraph（段号，从 1 计）和 sourceQuote（答案依据的原文句子）。
- sourceQuote 必须与文章原文**逐字一致**（前端要做高亮匹配），不许改写、不许截半句。`

/**
 * 讲解字段的口径。设计依据（用户实测的错因）：错题不止来自不认识目标词，
 * 还来自「认不出选项里的词」和「看不懂题目在问什么」——所以选项逐个给含义、
 * 题干给翻译、再给一句解题路径，而不是一段笼统的 explanation。
 * 阶段二（buildExplanationPrompt）专用；阶段一出题不生成这些字段。
 */
const EXPLANATION_RULES = `## 讲解要求（全部中文，写给一个词汇量有限的考生）

阅读题每道给出：
- stemTranslation：题干的中文翻译，忠实通顺，不省略限定语（如 "according to paragraph 2"）。
- howToSolve：怎么下手，一句话。口径按出题方式定：
  - 词义决定推断 → 指出「回到第 X 段找到目标词所在句，题目问的就是这句话的意思」；
  - 同义替换 → 指出「把选项与原文里的目标词逐一对照，找同义改写」；
  - 态度/逻辑题 → 指出「目标词是褒贬/转折信号，先判断它的感情色彩或逻辑方向」。
- wordNote：考点词卡：目标词的准确词义 + 一句用法或常见搭配。
- 每个选项的 meaning：该选项本身的中文含义（考生可能认不出选项里的词，逐个翻译）。
- 每个选项的 note：正确项讲词义如何锁定它；干扰项讲它针对哪种误记设陷（记成什么意思的人会选它）。

语法填空每道给出：
- sentenceTranslation：答案填入后整句的中文翻译。
- grammarPoints：语法点标签 1-3 个（如 现在完成时 / 被动语态 / 非谓语动词）。
- reasoning：判定链 2-4 步，每步一句话，从句中线索推到答案形态。
  第一步必须先讲词义（认出目标词是什么意思、什么词性），后续步骤讲线索词如何决定时态/语态/词性。
- wrongForms：考生最可能误填的 1-3 个形态，各配一句错因（针对具体的语法误区，不写「粗心」这类空话）。
- wordMeaning：考点词的中文词义，一句话。

## answerDispute（泄压阀）
逐题写讲解时，如果你发现某题的既定答案（题干、选项、答案字母/答案文本均已锁定，不许改）
其实站不住脚、你无法给出一段自圆其说的讲解，**不要擅自改判**：把这道题的 answerDispute
字段写成一句话说明「哪里说不通」，其余照常给出你能给的最合理讲解；没有异议的题不要给这个字段
（或留空字符串）。`

/**
 * 阶段一：出题（文章 + 题目 + 答案，不含任何讲解字段）。
 * regenerate 分支同样只产出无解析的题——阶段二的解析生成统一在收卷后单独请求。
 */
export function buildGeneratePrompt(opts: {
  /** 本次调用负责的一组词（对应一篇文章）；regenerate 时传空数组 */
  words: string[]
  difficulty: Difficulty
  types: QuestionType[]
  regenerate?: {
    passages: Passage[]
    failedReadingQuestions: ReadingQuestion[]
    failedGrammarQuestions: GrammarFillQuestion[]
  }
}): string {
  const { words, difficulty, types } = opts

  if (opts.regenerate) {
    const { passages, failedReadingQuestions, failedGrammarQuestions } = opts.regenerate
    const readingList = failedReadingQuestions
      .map(
        (q, i) =>
          `${i + 1}. [阅读] passageIndex=${passages.findIndex((p) => p.id === q.passageId)}，targetWord=${q.targetWord}，原题（不合格，勿重复出法）：${q.stem}`,
      )
      .join('\n')
    const grammarList = failedGrammarQuestions
      .map(
        (q, i) =>
          `${i + 1}. [语法填空] targetWord=${q.targetWord}，原句（不合格，勿重复出法）：${q.sentence}`,
      )
      .join('\n')
    return `你是一位英语命题人。下面这些题没有通过质检——阅读题可能是「遮住目标词后仍能答对」（没有真正考到目标词），也可能是「复核时你自己重新作答，得到的答案和既定答案不一致」（说明题目或答案设计有问题）；语法填空题一律是后一种原因。请针对同一个目标词，**重新命题**，让题目严格满足考点约束，且答案必须清晰唯一、经得起独立复核。

${EXAM_POINT_RULES}

${SOURCE_RULES}

## 文章（不要改动文章本身）
${passages
  .map(
    (p, i) =>
      `### 文章 ${i}：${p.title}\n${p.paragraphs.map((para, j) => `¶${j + 1} ${para}`).join('\n')}`,
  )
  .join('\n\n')}

## 需要重出的题
${[readingList, grammarList].filter(Boolean).join('\n')}

输出 JSON：passages 留空数组，readingQuestions 按上面「阅读」题目顺序给出重出的题（不含解析字段），grammarQuestions 按上面「语法填空」题目顺序给出重出的题（不含解析字段）。没有对应类型的重出题时，该数组留空。`
  }

  const grammarEnabled = types.includes('grammarFill')
  return `你是一位资深英语命题人，为一名正在背单词的中国考生出一份「今日试卷」。考生今天背了下面这些词，试卷的唯一目的是**检验这些词是否真的记住了**。

## 难度与风格
${DIFFICULTY_PROFILES[difficulty]}

## 目标词
${words.join(', ')}

## 文章要求
- 用这些词写一篇英语文章，**每个目标词都必须自然出现**在文章里（可用合理的屈折形态）。
- 文章题材自选，但必须让目标词出现在承担实义的位置，不许堆砌词表式的生硬句子。
- 按段落输出 paragraphs 数组（passages 数组里只放这一篇，passageIndex 一律填 0）。

${EXAM_POINT_RULES}

${SOURCE_RULES}

## 题型
- 阅读理解（readingQuestions）：四选一。
${
  grammarEnabled
    ? '- 语法填空（grammarQuestions）：从目标词里挑适合形态变化的词出题，句子必须是**新写的独立句子**（不从文章里抄），语境要让人先想起词义、再判断形态。'
    : '- 语法填空未启用：grammarQuestions 输出空数组，所有目标词都出阅读题。'
}

## 本阶段输出范围
这一步**只出文章、题干、选项与答案**，不要给任何讲解/翻译/语法点字段——那些留到下一步再单独请求。

严格按给定的 JSON schema 输出。`
}

/**
 * 明答校验（阶段一收卷前的新增质检，docs/impls/cijuan-merge.md §二.6）：
 * 让模型正常重做一遍它刚刚出的卷（不遮词、不告知答案），返回每题它自己选的答案，
 * 与答案键不一致的题走 buildGeneratePrompt 的 regenerate 分支重出。
 *
 * 动机：两阶段拆分后阶段二锁定答案（只许解释、不许改判），原先「写解析时发现
 * 答案圆不回来会自我修正」的隐性纠错通道消失了，必须在锁定前显式校验答案本身。
 * 遮词自检查「不认识词能不能答出」，这里查「答案对不对」，互补不重叠。
 *
 * 以「续写同一对话」的形态调用（generate.ts 的 runAnswerCheck）：这条 prompt 只是
 * 追加的新 user 消息，前面接的是阶段一该组原始的 user/assistant 回合——文章原文和
 * 题目本身已经在对话里，不重复贴一遍，换来能命中阶段一的 prompt cache。
 */
export function buildAnswerCheckPrompt(opts: {
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
}): string {
  const { readingQuestions, grammarQuestions } = opts
  return `请重新独立作答一遍上面这些题——上面的题目未附答案，请凭自己的判断独立作答后输出，也不遮盖任何词，对每道题给出你自己的答案。

## 阅读题
${readingQuestions
  .map((q, i) => `### 题 ${i}\n${q.stem}\n${q.options.map((o) => `${o.label}. ${o.text}`).join('\n')}`)
  .join('\n\n')}

## 语法填空题
${grammarQuestions
  .map((q, i) => `### 题 ${i}\n${q.sentence}\n（提示：${q.hint}）`)
  .join('\n\n')}

对每道阅读题输出 questionIndex（对应上面的题号，从 0 计）与 answer（你选的字母）；
对每道语法填空题输出 questionIndex（从 0 计）与 answer（你填入的形态）。`
}

/**
 * 阶段二：解析生成。以「同一对话续写」形态调用——传给 transport 的 messages 里，
 * 上一条 assistant 消息是阶段一该组的原始结构化输出，这条 prompt 是新追加的
 * user 消息，只要求补全解析字段，不重复文章与题干本身（省 token、吃提示词缓存）。
 * 索引按「这一组」内部的顺序（0 计），不是整卷全局索引——每组续写各自的对话，
 * 天然不需要全局编号。
 */
export function buildExplanationPrompt(opts: {
  readingQuestions: ReadingQuestion[]
  grammarQuestions: GrammarFillQuestion[]
}): string {
  const { readingQuestions, grammarQuestions } = opts
  return `很好。现在请给上面这些题目逐一补全讲解字段，题目本身（文章、题干、选项、答案）已经**最终锁定，不许改动**。

readingQuestions 共 ${readingQuestions.length} 道（对应上面 readingQuestions 数组，questionIndex 从 0 计，按原顺序）；
grammarQuestions 共 ${grammarQuestions.length} 道（同理）。

${EXPLANATION_RULES}`
}

/**
 * 目标词的常见屈折形态，显式枚举——不用「词干+任意尾缀」这种开放式正则：
 * 那会把 art 连带 article/artist 一起遮掉（误遮），
 * 又遮不住 allocating（allocate 去 e 加 ing，漏遮），自检判定会整个反转。
 */
export function wordForms(word: string): string[] {
  const w = word.toLowerCase().trim().replace(/\s+/g, ' ')
  if (w.includes(' ')) {
    // 词组：屈折发生在首词（动词短语 take over → takes/taking over）
    // 或尾词（名词短语 climate change → climate changes），两头都枚举
    const tokens = w.split(' ')
    const forms = new Set<string>([w])
    for (const f of singleWordForms(tokens[0])) {
      forms.add([f, ...tokens.slice(1)].join(' '))
    }
    for (const f of singleWordForms(tokens[tokens.length - 1])) {
      forms.add([...tokens.slice(0, -1), f].join(' '))
    }
    return [...forms]
  }
  return singleWordForms(w)
}

function singleWordForms(w: string): string[] {
  const forms = new Set([w, `${w}s`, `${w}es`, `${w}ed`, `${w}ing`, `${w}d`, `${w}r`, `${w}rs`])
  if (/[^aeiou]y$/.test(w)) {
    const stem = w.slice(0, -1)
    forms.add(`${stem}ies`)
    forms.add(`${stem}ied`)
  }
  if (w.endsWith('e')) {
    // 去 e 加 -ing / -ed：allocate → allocating
    const stem = w.slice(0, -1)
    forms.add(`${stem}ing`)
  }
  if (/[^aeiou][aeiou][^aeiouwxy]$/.test(w)) {
    // 短元音闭音节双写尾字母：run → running
    const last = w[w.length - 1]
    forms.add(`${w}${last}ing`)
    forms.add(`${w}${last}ed`)
  }
  return [...forms]
}

/** 匹配目标词全部形态的整词正则（长形态优先，避免短形态截胡）；判分页高亮也用它 */
export function wordFormsRegex(word: string): RegExp {
  const alts = wordForms(word)
    .map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  return new RegExp(`\\b(?:${alts.join('|')})\\b`, 'gi')
}

/** 遮词：把文本中目标词的各种形态替换为 ████ */
export function maskWord(text: string, word: string): string {
  return text.replace(wordFormsRegex(word), '████')
}

export function buildMaskedCheckPrompt(
  items: { passage: Passage; question: ReadingQuestion }[],
): string {
  return `下面每道阅读题的文章里，有一个关键词被 ████ 遮住了。请你**只凭剩余的上下文**作答，并汇报：遮住这个词之后，你是否仍能有把握地选出答案。

判定口径：
- confident=true：即使不知道被遮的词是什么，剩余上下文也足以锁定唯一答案；
- confident=false：不知道被遮的词就只能猜。

${items
  .map(({ passage, question }, i) => {
    const maskedParas = passage.paragraphs.map((p) => maskWord(p, question.targetWord))
    const maskedStem = maskWord(question.stem, question.targetWord)
    return `## 题 ${i}
文章：
${maskedParas.map((p, j) => `¶${j + 1} ${p}`).join('\n')}

题目：${maskedStem}
${question.options.map((o) => `${o.label}. ${maskWord(o.text, question.targetWord)}`).join('\n')}`
  })
  .join('\n\n')}

对每道题输出 questionIndex、answeredWithoutWord、confident。`
}

/**
 * 追问的 system 提示词：把选中片段和它的出处上下文钉进对话，
 * 后续多轮消息不再重复上下文。
 */
export function buildAskSystemPrompt(opts: {
  /** 用户选中的片段 */
  quote: string
  /** 片段出处标注，如「文章 ¶2」「第 3 题 选项 B」 */
  quoteFrom: string
  /** 片段所在的完整上下文（整段原文/整道题） */
  context: string
}): string {
  return `你是一名英语学习助教，正在帮一位词汇量有限的中国考生复盘一份英语试卷。考生在卷面上选中了一段文字发起追问。

## 考生选中的片段（出处：${opts.quoteFrom}）
${opts.quote}

## 片段所在的完整上下文
${opts.context}

## 回答要求
- 用中文回答，直接回应考生的问题，不要复述上下文。
- 涉及英文词汇时给出准确词义；涉及句子时先给整句翻译再解释。
- 简洁：默认三五句话说清，考生追问再展开。`
}

export function buildGrammarJudgePrompt(
  items: { sentence: string; hint: string; answer: string; userAnswer: string }[],
): string {
  return `你是语法填空的阅卷人。对每道题，判断考生填写是否可接受：与标准答案语法功能等价（如缩写、可选助动词、英式/美式拼写）判对；时态/语态/词性错误判错。大小写与首尾空格不影响判分。

${items
  .map(
    (it, i) =>
      `## 题 ${i}\n句子：${it.sentence}\n提示词：${it.hint}\n标准答案：${it.answer}\n考生填写：${it.userAnswer}`,
  )
  .join('\n\n')}

对每道题输出 questionIndex、correct、note（一句话中文）。`
}
