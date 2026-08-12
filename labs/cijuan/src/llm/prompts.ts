import type { Difficulty, Passage, QuestionType, ReadingQuestion } from '../types'

/**
 * 提示词是这个产品的核心资产：
 * 「考点约束」——每道题必须做到不认识目标词就答不出来——全靠这里成立。
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
- wordMeaning：考点词的中文词义，一句话。`

export function buildGeneratePrompt(opts: {
  /** 本次调用负责的一组词（对应一篇文章）；regenerate 时传空数组 */
  words: string[]
  difficulty: Difficulty
  types: QuestionType[]
  regenerate?: { passages: Passage[]; failedQuestions: ReadingQuestion[] }
}): string {
  const { words, difficulty, types } = opts

  if (opts.regenerate) {
    const { passages, failedQuestions } = opts.regenerate
    return `你是一位英语命题人。下面这些阅读题没有通过「遮词自检」：把目标词遮住后题目仍然能答对，说明它们没有真正考到目标词。请针对同一篇文章、同一个目标词，**重新命题**，让题目严格满足考点约束。

${EXAM_POINT_RULES}

${SOURCE_RULES}

${EXPLANATION_RULES}

## 文章（不要改动文章本身）
${passages
  .map(
    (p, i) =>
      `### 文章 ${i}：${p.title}\n${p.paragraphs.map((para, j) => `¶${j + 1} ${para}`).join('\n')}`,
  )
  .join('\n\n')}

## 需要重出的题（passageIndex 对应上面的文章编号）
${failedQuestions
  .map(
    (q, i) =>
      `${i + 1}. passageIndex=${passages.findIndex((p) => p.id === q.passageId)}，targetWord=${q.targetWord}，原题（不合格，勿重复出法）：${q.stem}`,
  )
  .join('\n')}

输出 JSON：passages 留空数组，readingQuestions 按上面顺序给出重出的题（含全部讲解字段），grammarQuestions 留空数组。`
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

${EXPLANATION_RULES}

严格按给定的 JSON schema 输出。`
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
 * 选取追问的 system 提示词：把选中片段和它的出处上下文钉进对话，
 * 后续多轮消息不再重复上下文（见 client.ts 的 callChat）。
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
