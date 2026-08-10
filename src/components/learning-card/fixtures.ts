import type {
  LearningCardKind,
  LearningCardNote,
  LearningCardResult,
  LearningModuleContent,
  LearningModuleId,
} from "./types";

type FixtureLanguage = "en" | "zh";

const content = (
  summary: string,
  details: string[] = [],
  items: LearningModuleContent["items"] = [],
  meta: string[] = [],
): LearningModuleContent => ({ summary, details, items, meta });

const WORD_EXCERPT = "A good translator must render the tone as well as the words.";

const wordModules = (language: FixtureLanguage): Partial<Record<LearningModuleId, LearningModuleContent>> =>
  language === "zh" ? {
    // `summary` doubles as the line printed above the word in the book, so it
    // is a bare sense and the explanation is the first `details` entry — the
    // fixtures have to show the shape the prompt now asks for, or the settings
    // preview stops matching real cards.
    context_meaning: content(
      "换一种形式重新表达",
      [
        "这里指把原文的内容重新做出来，而不只是把词换掉。",
        "宾语是 the tone，说明作者要求译者连语气一起转达。",
        "这层含义偏正式，常见于翻译、艺术和技术写作。",
      ],
    ),
    sentence_gist: content("好的译者不能只把词换过来，还得把原文的语气一起带过去。"),
    word_info: content("render", ["原形：render", "词形变化：renders / rendered / rendering"], [], ["/ˈrendə(r)/", "verb", "base form"]),
    target_translation: content("呈现；表达；给予；使成为"),
    common_senses: content("本文用的是第一个义项。", [], [
      { title: "表达；译出", text: "把内容换成另一种语言、媒介或表现形式。", examples: [
        { source: "She rendered the poem into English.", target: "她把这首诗译成了英文。" },
        { source: "The artist rendered the scene in charcoal.", target: "画家用炭笔画出了那个场景。" },
        { source: "The quartet rendered the piece with unusual warmth.", target: "四重奏把这首曲子演绎得格外温暖。" },
      ] },
      { title: "渲染", text: "由数据或代码生成最终的图像、页面。", examples: [
        { source: "The engine renders the scene in real time.", target: "这个引擎实时渲染场景。" },
        { source: "The browser renders the page before the script runs.", target: "浏览器会在脚本运行前渲染页面。" },
        { source: "The final frame took an hour to render.", target: "渲染最后一帧花了一个小时。" },
      ] },
      { title: "给予；致以", text: "正式地提供帮助、服务，或作出裁决。", examples: [
        { source: "They rendered assistance to the stranded crew.", target: "他们向受困的船员提供了援助。" },
        { source: "We render thanks to everyone who helped.", target: "我们向每一位帮过忙的人致谢。" },
        { source: "The court will render its decision next week.", target: "法院将于下周作出裁决。" },
      ] },
      { title: "使成为", text: "让人或事物变成某种状态，后面接形容词。", examples: [
        { source: "The injury rendered him unable to walk.", target: "这次受伤使他无法行走。" },
        { source: "One update rendered the old plugin useless.", target: "一次更新让旧插件彻底失效。" },
        { source: "The noise rendered the recording unusable.", target: "噪音让这段录音没法用了。" },
      ] },
    ]),
    collocations: content("常与语言、帮助、状态、裁决这几类词连用。", [], [
      { title: "render sth into English", text: "把某个内容译成英语。" },
      { title: "render assistance", text: "正式场合下提供帮助或服务。" },
      { title: "render sth useless", text: "使某物失去作用，后接形容词。" },
      { title: "render a verdict", text: "（法庭）作出裁决。" },
    ]),
    morphology: content("来自古法语 rendre（归还），由 re-（回）和 -der（给）构成。", ["名词用 rendering 或 rendition，施动者是 renderer。", "render 本身只作动词，不要当名词用。"]),
    grammar_role: content("谁做什么：好的译者 —— 必须传达 —— 语气。", ["后面的 as well as the words 是在给「传达」再补一个对象，说的还是同一件事。"]),
    synonyms: content("depict 侧重画出或写出对象；translate 只限语言之间；make 最中性，只说结果；render 强调有技巧地把某物转成另一种形式。"),
    why_this_word: content("换成 translate，只说明把话搬进另一种语言；render 还带着「有手艺地重新做出来」这层，而作者要的正是这层。", ["用 give 或 keep 都太轻，托不住「重新做出来」。"]),
    usage: content("常见于翻译、艺术评论、法律文书和图形技术，日常口语很少用。"),
    memory_aid: content("re-（回）+ -der（给）：把拿到的东西再给回去，只是换了个形式。"),
    source_excerpt: { quote: WORD_EXCERPT },
  } : {
    context_meaning: content(
      "remake in another form",
      [
        "Here it means turning the content into another form, not just swapping the words.",
        "The object is the tone, so the writer asks for the feeling to carry over too.",
        "The register is formal, typical of translation, art, and technical writing.",
      ],
    ),
    sentence_gist: content("A good translator has to carry the feeling across, not just swap the words."),
    word_info: content("render", ["Lemma: render", "Inflections: renders / rendered / rendering"], [], ["/ˈrendə(r)/", "verb", "base form"]),
    target_translation: content("呈现；表达；给予；使成为"),
    common_senses: content("The first sense below is the one used here.", [], [
      { title: "Express in another form", text: "To turn something into another language, medium, or performance.", examples: [
        { source: "She rendered the poem into English.", target: "她把这首诗译成了英文。" },
        { source: "The artist rendered the scene in charcoal.", target: "画家用炭笔画出了那个场景。" },
        { source: "The quartet rendered the piece with unusual warmth.", target: "四重奏把这首曲子演绎得格外温暖。" },
      ] },
      { title: "Generate an image", text: "To produce a final picture or page from data or code.", examples: [
        { source: "The engine renders the scene in real time.", target: "这个引擎实时渲染场景。" },
        { source: "The browser renders the page before the script runs.", target: "浏览器会在脚本运行前渲染页面。" },
        { source: "The final frame took an hour to render.", target: "渲染最后一帧花了一个小时。" },
      ] },
      { title: "Formally give", text: "To provide help or a service, or to hand down a ruling.", examples: [
        { source: "They rendered assistance to the stranded crew.", target: "他们向受困的船员提供了援助。" },
        { source: "We render thanks to everyone who helped.", target: "我们向每一位帮过忙的人致谢。" },
        { source: "The court will render its decision next week.", target: "法院将于下周作出裁决。" },
      ] },
      { title: "Cause to become", text: "To leave someone or something in a new state; an adjective follows.", examples: [
        { source: "The injury rendered him unable to walk.", target: "这次受伤使他无法行走。" },
        { source: "One update rendered the old plugin useless.", target: "一次更新让旧插件彻底失效。" },
        { source: "The noise rendered the recording unusable.", target: "噪音让这段录音没法用了。" },
      ] },
    ]),
    collocations: content("It pairs with words for language, help, a state, or a ruling.", [], [
      { title: "render sth into English", text: "To turn a text into English." },
      { title: "render assistance", text: "To give help or service, in formal use." },
      { title: "render sth useless", text: "To leave something with no use; an adjective follows." },
      { title: "render a verdict", text: "To hand down a court decision." },
    ]),
    morphology: content("From Old French rendre (to give back): re- (back) plus -der (give).", ["Nouns are rendering and rendition; the agent noun is renderer.", "Render itself stays a verb; use rendering for the noun."]),
    grammar_role: content("Who does what: a good translator — must render — the tone.", ["The as well as the words part simply adds one more thing being rendered; it is not a second action."]),
    synonyms: content("Depict points at the subject shown; translate covers languages only; make is the neutral word for a result; render adds the skill of turning one form into another."),
    why_this_word: content("Translate would only say the words moved into another language; render carries the craft of remaking it in another form, which is exactly what the writer is asking for.", ["Give or keep would be too weak to hold that remaking."]),
    usage: content("Common in translation, art criticism, legal writing, and graphics; rare in casual speech."),
    memory_aid: content("re- (back) + -der (give): you give it back, just in a different form."),
    source_excerpt: { quote: WORD_EXCERPT },
  };

const phraseModules = (language: FixtureLanguage): Partial<Record<LearningModuleId, LearningModuleContent>> =>
  language === "zh" ? {
    context_meaning: content("因祸得福", [
      "这里表示某件事最终反而带来了积极、意外的结果。",
      "说话者是在回顾一个起初看似不利的变化。",
    ]),
    target_translation: content("结果证明这是因祸得福。"),
    common_senses: content("常用于描述坏事带来未预料到的好处。", [], [
      { title: "a blessing in disguise", text: "表面是坏事，后来才发现有好处。", examples: [
        { source: "Missing that train was a blessing in disguise.", target: "没赶上那班火车反而是因祸得福。" },
        { source: "The rejected application was a blessing in disguise.", target: "申请被拒后来证明反而是件好事。" },
        { source: "The delay proved to be a blessing in disguise.", target: "这次延误最终证明是因祸得福。" },
      ] },
    ]),
    collocations: content("常与 turn out to be、prove to be 搭配。"),
    grammar_analysis: content("整个短语在句中作表语。", ["in disguise 是介词短语，修饰 blessing。"]),
    idioms: content("这是固定习语，不能按“伪装的祝福”逐字理解。"),
    usage: content("适合用于回顾已经显现积极结果的事件。"),
    source_excerpt: { quote: "Losing the contract turned out to be a blessing in disguise." },
  } : {
    context_meaning: content("a hidden stroke of luck", [
      "Something that first looked harmful but later produced an unexpected benefit.",
      "The speaker is looking back after the positive result became clear.",
    ]),
    target_translation: content("结果证明这是因祸得福。"),
    common_senses: content("Used when a bad event leads to an unforeseen advantage.", [], [
      { title: "a blessing in disguise", text: "An apparent problem that later proves helpful.", examples: [
        { source: "Missing that train was a blessing in disguise.", target: "没赶上那班火车反而是因祸得福。" },
        { source: "The rejected application was a blessing in disguise.", target: "申请被拒后来证明反而是件好事。" },
        { source: "The delay proved to be a blessing in disguise.", target: "这次延误最终证明是因祸得福。" },
      ] },
    ]),
    collocations: content("Often follows turn out to be or prove to be."),
    grammar_analysis: content("The full phrase is a subject complement.", ["In disguise is a prepositional phrase modifying blessing."]),
    idioms: content("This is a fixed idiom; its meaning is not the literal sum of the words."),
    usage: content("Use it when the positive outcome is already visible."),
    source_excerpt: { quote: "Losing the contract turned out to be a blessing in disguise." },
  };

const passageModules = (language: FixtureLanguage): Partial<Record<LearningModuleId, LearningModuleContent>> =>
  language === "zh" ? {
    context_meaning: content("作者认为，真正重要的发现往往出现在成熟学科相互接触的地方。", ["这句话承接上文对专业分工的讨论，并把重点转向跨领域合作。", "隐含观点是：过于封闭的知识边界会限制创新。"]),
    target_translation: content("新的想法往往产生于成熟领域之间的交界处。"),
    grammar_analysis: content("主干是 New ideas emerge。", ["often 是频率副词；at the interfaces 是地点状语；between established fields 修饰 interfaces。"]),
    key_terms: content("理解这句话的三个关键词", [], [
      { title: "emerge", text: "出现、逐渐显现。", examples: [
        { source: "A clear pattern began to emerge.", target: "一个清晰的模式开始显现。" },
        { source: "New evidence emerged during the study.", target: "研究期间出现了新的证据。" },
        { source: "She emerged as a strong leader.", target: "她逐渐成为一位有能力的领导者。" },
      ] },
      { title: "interfaces", text: "发生互动的交界处。", examples: [
        { source: "Innovation grows at the interface of art and science.", target: "创新在艺术与科学的交汇处发展。" },
        { source: "The role sits at the interface between teams.", target: "这个岗位处于多个团队的协作交界处。" },
        { source: "They improved the interface between research and practice.", target: "他们改善了研究与实践之间的衔接。" },
      ] },
      { title: "established", text: "已经成熟、得到认可的。", examples: [
        { source: "It is an established method.", target: "这是一种公认的方法。" },
        { source: "She challenged an established view.", target: "她质疑了一种既有观点。" },
        { source: "The firm entered an established market.", target: "这家公司进入了一个成熟市场。" },
      ] },
      { title: "fields", text: "知识、研究或工作的领域。" },
      { title: "often", text: "表示某事经常发生，但并非总是如此。" },
      { title: "between", text: "说明两个或多个对象之间的关系。" },
      { title: "ideas", text: "这里指新的观点、方案或发现。" },
      { title: "new", text: "强调此前不存在或尚未被提出。" },
    ]),
    idioms: content("本句没有必须整体理解的习语。"),
    references: content("established fields 指上文讨论的传统学科。"),
    reusable_patterns: content("X often emerges at the interface between A and B.", ["可用于描述跨学科创新或两种方法结合后的结果。"]),
    tone: content("语气概括而肯定，带有鼓励跨领域合作的意味。"),
    source_excerpt: { quote: "New ideas often emerge at the interfaces between established fields." },
  } : {
    context_meaning: content("The author argues that important discoveries often happen where mature disciplines meet.", ["The sentence shifts the discussion from specialization to collaboration across fields.", "It implies that rigid knowledge boundaries can limit innovation."]),
    target_translation: content("新的想法往往产生于成熟领域之间的交界处。"),
    grammar_analysis: content("The main clause is New ideas emerge.", ["Often is an adverb of frequency; at the interfaces gives the place; between established fields modifies interfaces."]),
    key_terms: content("Three terms carry the meaning", [], [
      { title: "emerge", text: "To appear or gradually become clear.", examples: [
        { source: "A clear pattern began to emerge.", target: "一个清晰的模式开始显现。" },
        { source: "New evidence emerged during the study.", target: "研究期间出现了新的证据。" },
        { source: "She emerged as a strong leader.", target: "她逐渐成为一位有能力的领导者。" },
      ] },
      { title: "interfaces", text: "Places where different things interact.", examples: [
        { source: "Innovation grows at the interface of art and science.", target: "创新在艺术与科学的交汇处发展。" },
        { source: "The role sits at the interface between teams.", target: "这个岗位处于多个团队的协作交界处。" },
        { source: "They improved the interface between research and practice.", target: "他们改善了研究与实践之间的衔接。" },
      ] },
      { title: "established", text: "Already recognized and well developed.", examples: [
        { source: "It is an established method.", target: "这是一种公认的方法。" },
        { source: "She challenged an established view.", target: "她质疑了一种既有观点。" },
        { source: "The firm entered an established market.", target: "这家公司进入了一个成熟市场。" },
      ] },
      { title: "fields", text: "Areas of knowledge, study, or work." },
      { title: "often", text: "Shows that something happens frequently, but not always." },
      { title: "between", text: "Expresses a relationship involving two or more things." },
      { title: "ideas", text: "New thoughts, plans, or discoveries in this context." },
      { title: "new", text: "Not previously present or proposed." },
    ]),
    idioms: content("There is no fixed idiom that must be read as one unit."),
    references: content("Established fields refers to the traditional disciplines discussed earlier."),
    reusable_patterns: content("X often emerges at the interface between A and B.", ["Useful for describing interdisciplinary work or combined methods."]),
    tone: content("The tone is confident and encourages work across disciplinary boundaries."),
    source_excerpt: { quote: "New ideas often emerge at the interfaces between established fields." },
  };

export function getLearningCardFixture(
  kind: LearningCardKind,
  language: string,
): LearningCardResult {
  const fixtureLanguage: FixtureLanguage = language === "zh" ? "zh" : "en";
  const sourceText = kind === "word"
    ? "render"
    : kind === "phrase"
      ? "a blessing in disguise"
      : "New ideas often emerge at the interfaces between established fields.";
  const modules = kind === "word"
    ? wordModules(fixtureLanguage)
    : kind === "phrase"
      ? phraseModules(fixtureLanguage)
      : passageModules(fixtureLanguage);
  return { version: 1, kind, sourceText, modules };
}

export const LEARNING_CARD_NOTE_FIXTURE: LearningCardNote[] = [
  {
    id: "preview-note",
    content: "Compare this use with the more technical meaning in software design.",
    updatedAt: Date.UTC(2026, 6, 13, 10, 0),
    scope: "book",
  },
];
