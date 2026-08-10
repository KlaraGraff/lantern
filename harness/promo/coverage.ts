/**
 * 第 7 张样张（「这本书对你」）的数据。
 *
 * 数字不在这个文件里 —— 它们在 `coverage.generated.ts`，由
 * `node scripts/promo-coverage.mjs` 数真书数出来的。这里只做一件事：把那些
 * 计数摆成端上四个命令返回的形状（`coverage.rs` 里的 `BookReaderCoverage`、
 * `VocabProfileSummary`、`UnknownWord`）。
 *
 * 这么分是为了让「哪些是事实、哪些是设定」一眼看得出来：generated 里全是数
 * 出来的，这里只有时间戳和那位虚构读者的履历。
 */
import {
  PROMO_BASELINE_BOOKS,
  PROMO_COVERAGE_READER,
  PROMO_COVERAGE_ROWS,
  PROMO_EXPOSURE,
  PROMO_UNKNOWN_WORDS,
} from "./coverage.generated";
const DAY = 86_400_000;
const ago = (days: number) => Date.now() - days * DAY;

/**
 * 覆盖率和词汇画像都是两天前算的。
 *
 * 同一个时刻，不是两个 —— 画像比覆盖率新的话，卡片会多出一句「这是 x 月 x 日
 * 那份画像算出来的」。那是个真实存在的状态，但不是这张图要讲的。
 */
const COMPUTED_AT = ago(2);

/** 读者认识的词形数：频率表前 8 000 名，加上生词本里已经读顺了的那几个。 */
const MASTERED_FORMS = PROMO_COVERAGE_READER.masteredRank + PROMO_COVERAGE_READER.savedKnown.length;
const FAMILIAR_FORMS = PROMO_COVERAGE_READER.familiarRank - PROMO_COVERAGE_READER.masteredRank;

const rowFor = (bookId: unknown) =>
  PROMO_COVERAGE_ROWS.find((row) => row.bookId === bookId) ?? PROMO_COVERAGE_ROWS[0];

/** `get_book_coverage`。 */
export function promoBookCoverage(bookId: unknown) {
  const row = rowFor(bookId);
  return {
    ...row,
    status: "done",
    masteredForms: MASTERED_FORMS,
    familiarForms: FAMILIAR_FORMS,
    baselineBooks: PROMO_BASELINE_BOOKS,
    profileAt: new Date(COMPUTED_AT).toISOString(),
    computedAt: new Date(COMPUTED_AT).toISOString(),
    // 端上存的是 EPUB 的哈希，用来发现「书换了但数还是旧的」。样张里书没换过，
    // 这一栏界面也不显示，所以留空而不是编一串十六进制。
    sourceSha256: null,
    stale: false,
    error: null,
  };
}

/** `list_shelf_coverage` —— 书架上每本书封面下面那一行。 */
export const promoShelfCoverage = () =>
  PROMO_COVERAGE_ROWS.map((row) => ({
    bookId: row.bookId,
    totalTokens: row.totalTokens,
    masteredTokens: row.masteredTokens,
    familiarTokens: row.familiarTokens,
    nameTokens: row.nameTokens,
    baselineBooks: PROMO_BASELINE_BOOKS,
  }));

/**
 * `get_vocab_profile` —— 覆盖率那张卡片拿它判断「这位读者有没有记录」，
 * 顺带印上「画像更新于…」。
 */
export const promoVocabProfile = () => ({
  booksRead: PROMO_BASELINE_BOOKS,
  // 这两个字段是给「只读过一本」的那种画像准备的，读完九本就不该有值。
  singleBookTitle: null,
  singleBookProgress: null,
  exposureTokens: PROMO_EXPOSURE.tokens,
  exposureWords: PROMO_EXPOSURE.words,
  lookupRecords: 1_842,
  lookupDays: 96,
  vocabWords: 6,
  reviewedWords: 4,
  masteredForms: MASTERED_FORMS,
  familiarForms: FAMILIAR_FORMS,
  updatedAt: COMPUTED_AT,
});

/** 生词本里查过但还没学会的那几个词，查词次数照抄生词本。 */
const LOOKED_UP: Record<string, number> = PROMO_COVERAGE_READER.savedUnknown;

/** 生词本里存着的释义，只有这几个词有 —— 端上也只从 `vocab_words` 取。 */
const GLOSSES: Record<string, string> = {
  deigned: "/deɪn/ v. 屈尊做某事；否定式 not deign to 是「不屑于」。",
  circumspection: "/ˌsɜːkəmˈspekʃn/ n. 审慎周全。",
  bestow: "/bɪˈstəʊ/ v. 给予、赋予（正式，常搭 bestow sth on sb）。",
};

/**
 * 这本书读到哪儿了 —— `library.ts` 里写着 34%。
 *
 * 「读到过几次没查」那个角标数的是已经翻过去的屏幕上遇见的次数，所以按进度
 * 折算：只在后半本出现的词，标签就该是「从没遇到过」，而它确实会是。
 */
const PROGRESS = 0.34;

/** `get_book_unknown_words`。 */
export const promoUnknownWords = () =>
  PROMO_UNKNOWN_WORDS.map((entry) => ({
    word: entry.word,
    tokens: entry.tokens,
    gloss: GLOSSES[entry.word] ?? null,
    encounters: Math.round(entry.tokens * PROGRESS),
    lookups: LOOKED_UP[entry.word] ?? 0,
    // 「眼熟」的词只在读者把那个开关关掉时才进这张表；样张里开关是开着的。
    familiar: false,
  }));
