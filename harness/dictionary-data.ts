/**
 * Real `dictionary_lookup_word` replies, captured live from Youdao's `jsonapi`
 * endpoint on 2026-08-10 and run through the same parsing the Rust side does
 * (part-of-speech split out, `【名】` transliteration groups dropped).
 *
 * The card is the one surface where the *shape* of the data is the whole
 * design problem — `deliver` is a single `v.` with eleven senses, `light` is
 * four parts of speech with twenty-one senses in one of them — so a
 * shape-guessed empty stub renders the one state that proves nothing. Words
 * outside this table fall through to `GENERIC_DICTIONARY_ENTRY`, and
 * `DICTIONARY_MISS` is the word that exercises the not-found state.
 */
export interface HarnessDictionaryEntry {
  phonetic: string | null;
  groups: Array<{ pos: string; senses: string[] }>;
}

/** Clicking this word in the harness gets the genuine "not in there" card. */
export const DICTIONARY_MISS = "zzzz";

export const GENERIC_DICTIONARY_ENTRY: HarnessDictionaryEntry = {
  phonetic: null,
  groups: [
    { pos: "n.", senses: ["示例释义一", "示例释义二", "示例释义三"] },
    { pos: "v.", senses: ["示例动词释义一", "示例动词释义二"] },
  ],
};

export const DICTIONARY_ENTRIES: Record<string, HarnessDictionaryEntry> = {
  "deliver": {
    phonetic: "dɪˈlɪvər",
    groups: [
      { pos: "v.", senses: ["投递，运送", "履行，兑现", "交付，移交", "发表，宣布", "接生，分娩", "解救，拯救", "投掷，击打", "（法官或法庭）宣布（判决）", "拉（选票）", "发行，发布（计算机程序）", "处理"] },
    ],
  },
  "light": {
    phonetic: "laɪt",
    groups: [
      { pos: "n.", senses: ["光，光线", "光源（如电灯）", "某种光亮", "交通信号灯", "车灯", "打火机，点火器", "角度，（事物呈现的）状态", "眼光，处世标准（lights）", "（对问题的）了解，启迪", "眼神", "亮色，浅色", "窗，天窗，采光口", "直棂窗窗玻璃上的竖框", "杰出的人，有声望的人", "<英>（字谜游戏中的）待填空格"] },
      { pos: "adj.", senses: ["浅色的，淡色的", "采光好的，光线足的", "天亮的，白天的", "轻的，不重的", "分量不足的", "轻型的，轻便的", "少量的，程度低的", "不严厉的", "（风）轻柔的", "轻声的", "（碰触）轻轻的", "不累的，轻松的", "不严肃的，愉快的", "单薄的，不保暖的", "（睡眠）不深的，易醒的", "（饭食）简单的", "酒精含量低的，低度酒的", "（食物）清淡的，易消化的", "（食物）松软的", "（土地）轻质的", "（字体）细体的"] },
      { pos: "v.", senses: ["（使）照亮", "（使）燃烧，点燃", "用光指引", "点烟"] },
      { pos: "adv.", senses: ["（旅行）轻装地", "轻地"] },
    ],
  },
  "run": {
    phonetic: "rʌn",
    groups: [
      { pos: "v.", senses: ["跑，奔跑", "参加（赛跑），举行（比赛）", "跑垒，持球跑动进攻", "奔忙，赶快去", "管理，经营，使用（车辆）", "（使）运转，操作", "刊登，播放", "（使）行驶", "（使）移动，揉擦", "闯红灯", "（使）流动，流淌", "掉色，渗色", "变成，变得", "达到（一定数量或比率）", "（对……）进行（测试或检验）", "参加竞选", "（连裤袜、长统袜）抽丝，脱线", "（使）延伸", "（感觉或想法）掠过，迅速传遍", "包含（某种词语、内容等）", "持续，延续", "偷运，走私", "印刷", "（特征）共有，世代相传（run in）", "<美>（物品，行动）花费（某人）（特定数额的钱）"] },
      { pos: "n.", senses: ["跑步，赛跑", "旅程，航程", "一系列（成功或失败）", "连续上演（或放映）", "尝试，努力", "额定产量", "抛售（美元、英镑等）", "争购，挤兑", "滑道，路径", "（板球或棒球中的）得分", "使用自由，出入自由（the run of）", "竞选", "普通人，普通事物", "饲养场", "急奏，走句", "顺子", "<非正式>腹泻（the runs）", "<美>（长统袜或连裤袜的）抽丝", "（油漆或类似物刷得过厚引起的）挂流，小溪", "（航海）船尾端部"] },
    ],
  },
  "bank": {
    phonetic: "bæŋk",
    groups: [
      { pos: "n.", senses: ["银行", "储蓄罐", "库存，库", "河岸", "斜坡", "云团，雾团", "一排，一组", "庄家的赌本", "（泥）滩，沙洲"] },
      { pos: "v.", senses: ["把（钱）存入银行，把……储存入库", "与银行有业务往来", "（飞机）倾斜飞行", "使反弹", "（把某物）堆积起来，聚集起来", "（用煤等）封炉火"] },
    ],
  },
  "meaning": {
    phonetic: "ˈmiːnɪŋ",
    groups: [
      { pos: "n.", senses: ["意思，意义，含义", "真正重要性，价值", "原因"] },
      { pos: "adj.", senses: ["<旧>意味深长的"] },
      { pos: "v.", senses: ["表示……的意思，作……的解释", "意味着", "打算，意欲（mean 的现在分词形式）"] },
    ],
  },
  "sister": {
    phonetic: "ˈsɪstər",
    groups: [
      { pos: "n.", senses: ["姐姐，妹妹", "（称志同道合者）姐妹", "（女权运动中的）姐妹", "姊妹，大姐，妹妹（妇女对其他妇女表示友好和支持时的用语）", "<非正式>姐妹，大姐，妹子（用作女性间的称呼）", "<美>大姐，小妹（美国黑人妇女之间使用的称呼）", "修女，女教友（Sister）", "<英>护士（长）（Sister）", "（美国大学）女生联谊会会员", "（尤指组织之间的）姐妹（关系）"] },
      { pos: "adj.", senses: ["同类的，同质的，如同姐妹的"] },
    ],
  },
  "developed": {
    phonetic: "dɪˈveləpt",
    groups: [
      { pos: "adj.", senses: ["发达的，高度发展的", "先进的，成熟的", "人体成规定比例的"] },
      { pos: "v.", senses: ["发展，壮大", "养成，形成", "开发，研制（develop 的过去式和过去分词形式）"] },
    ],
  },
  "old": {
    phonetic: "oʊld",
    groups: [
      { pos: "adj.", senses: ["（人）……岁的，（事物）存在……久的", "年老的，年纪大的", "衰老的", "古老的，历史悠久的", "陈旧的", "过去的，从前的", "原来（属于自己的）的", "结识久的", "<非正式>（表示亲昵）老……", "（语言形式）古的，早期的", "老派的，守旧的", "老一套的，经历多次的"] },
      { pos: "n.", senses: ["老年人", "某个年龄段的人", "古时"] },
    ],
  },
  "audience": {
    phonetic: "ˈɔːdiəns",
    groups: [
      { pos: "n.", senses: ["观众，听众", "读者", "觐见，拜见", "拥护者"] },
    ],
  },
  "responsibility": {
    phonetic: "rɪˌspɑːnsəˈbɪləti",
    groups: [
      { pos: "n.", senses: ["责任，负责", "（对不良事件所负的）责任", "（道义上或法律规定的）责任（responsibility to/towards）", "职责，任务", "重任，职权"] },
    ],
  },
  "search": {
    phonetic: "sɜːrtʃ",
    groups: [
      { pos: "v.", senses: ["搜查，搜寻", "搜查（地方，车辆），搜……的身", "思索，细想（问题答案等）", "细察，细查", "（用计算机）搜索，检索"] },
      { pos: "n.", senses: ["搜寻，搜查", "探索，寻求", "（计算机的）搜索，检索", "<律>调查地产负担"] },
    ],
  },
  "night": {
    phonetic: "naɪt",
    groups: [
      { pos: "n.", senses: ["夜间，夜晚", "晚上，傍晚", "<文>黄昏", "（特殊活动之）夜", "黑夜，夜色", "挫败时期"] },
      { pos: "adj.", senses: ["夜晚的", "夜晚使用的", "夜间进行的", "夜晚活动的"] },
      { pos: "int.", senses: ["晚安（goodnight 的简称）"] },
    ],
  },
  "free": {
    phonetic: "friː",
    groups: [
      { pos: "adj.", senses: ["免费的", "自由的", "随心所欲的", "不含……的", "免于，不遭受", "空闲的", "未使用的，空着的", "无阻碍的", "不拘泥于原文的", "游离的", "不吝惜的", "干净整洁的", "（风）顺的"] },
      { pos: "adv.", senses: ["自由地", "免费地", "帆脚索被松开地"] },
      { pos: "v.", senses: ["释放", "使解脱出来", "使免于", "使可用于", "使能腾出时间"] },
      { pos: "n.", senses: ["<英，非正式>自由转会"] },
    ],
  },
  "agreed": {
    phonetic: "əˈɡriːd",
    groups: [
      { pos: "adj.", senses: ["同意的", "通过协议的"] },
      { pos: "v.", senses: ["同意", "赞成（agree 的过去式）"] },
    ],
  },
  "mean": {
    phonetic: "miːn",
    groups: [
      { pos: "v.", senses: ["意味着", "表示……的意思，作……的解释", "打算，意欲", "使专门用于", "导致，结果是", "十分熟识", "当真，说到做到", "对某人重要"] },
      { pos: "adj.", senses: ["吝啬的，小气的", "不善良的，刻薄的", "要发怒的", "熟练的，出色的", "平均的", "简陋的，破旧的", "微薄的", "<旧>出身卑贱的，社会地位低下的", "中庸的，中等的", "<美>凶狠的，好斗的"] },
      { pos: "n.", senses: ["中庸，折衷", "平均数，中数", "中间点"] },
    ],
  },
  "nineteen": {
    phonetic: "ˌnaɪnˈtiːn",
    groups: [
      { pos: "num.", senses: ["十九"] },
      { pos: "n.", senses: ["十九个", "十九岁", "十九号"] },
    ],
  },
};
