/** The part of a question that names the person, for the low-confidence alias
 *  flow ("没认出「那个牧师」是谁").
 *
 *  The confirm button teaches a `'description'` alias, and the backend embeds
 *  that alias text *on its own* to compare against the reader's next question
 *  (see `teach_description_alias` in aliases.rs). Handing it the whole question
 *  — "那个牧师后来娶了谁？" — stores the question's topic along with the person:
 *  the table then lists a sentence as somebody's name, the receipt quotes it
 *  back, and the vector drifts toward "who married whom" instead of "the
 *  clergyman". This trims the question down to the referring phrase.
 *
 *  Zero model calls, so it is a heuristic, and it only claims the one shape it
 *  can recognise: a demonstrative + measure word ("那个 / 这位 / 那名 …") and
 *  what follows it. Without one it returns the question itself (minus trailing
 *  punctuation) — the previous behaviour, which is still a usable alias, just a
 *  noisy one.
 *
 *  Word boundaries come from `Intl.Segmenter`'s dictionary for Chinese, which
 *  both WebKit and Chromium ship. The shape it then looks for:
 *    - no 的 after the demonstrative → demonstrative + the next word
 *      (那个|牧师|后来 → 那个牧师);
 *    - a 的 before the phrase stops → everything up to the stop
 *      (那个|总|在|拍|马屁|的|牧师|为什么 → 那个总在拍马屁的牧师);
 *    - an "X的" right before the demonstrative is kept, because it narrows who
 *      is meant (伊丽莎白的那个表哥).
 *  A phrase stops at punctuation or at a word from STOP_WORDS — question words,
 *  time adverbs and conjunctions that start the predicate, not the person.
 */

const DEMONSTRATIVE = /[那这](?:个|位|名|家伙)/u;

const STOP_WORDS = new Set([
  "后来", "最后", "后面", "之后", "最终", "终于", "当时", "一开始", "开始",
  "为什么", "为何", "怎么", "怎样", "怎么样", "如何", "到底", "究竟",
  "是", "是不是", "有没有", "和", "跟", "与", "同", "对",
  "谁", "什么", "哪", "哪个", "哪里",
  "呢", "吗", "吧", "了", "啊",
]);

/** Words to look ahead before giving up on finding where the phrase ends. */
const MAX_WORDS = 8;

const TRAILING_PUNCTUATION = /[\s?？!！。.,，、;；:：]+$/u;

interface Word {
  text: string;
  index: number;
  isWordLike: boolean;
}

function segment(text: string): Word[] {
  const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
  return [...segmenter.segment(text)].map((s) => ({
    text: s.segment,
    index: s.index,
    isWordLike: s.isWordLike ?? false,
  }));
}

const isStop = (word: Word) => !word.isWordLike || STOP_WORDS.has(word.text);

export function referringPhrase(question: string): string {
  const trimmed = question.trim().replace(TRAILING_PUNCTUATION, "");
  const found = DEMONSTRATIVE.exec(trimmed);
  if (!found || typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return trimmed;

  const words = segment(trimmed);
  const after = found.index + found[0].length;
  // The demonstrative may be one dictionary word (那个) or two (那 | 个), so
  // locate the first word that starts at or past its end instead of counting.
  const first = words.findIndex((word) => word.index >= after);
  if (first < 0) return trimmed;

  let end = first;
  let sawDe = false;
  while (end < words.length && end - first < MAX_WORDS && !isStop(words[end])) {
    if (words[end].text === "的") sawDe = true;
    end += 1;
  }
  if (end === first) return trimmed;
  const last = sawDe ? end - 1 : first;
  const phraseEnd = words[last].index + words[last].text.length;

  // "伊丽莎白的那个表哥": walk back over an "X的" that qualifies the
  // demonstrative, stopping at the same boundaries a phrase stops at.
  let start = found.index;
  let before = words.findIndex((word) => word.index + word.text.length > found.index) - 1;
  if (before >= 0 && words[before].text === "的") {
    before -= 1;
    while (before >= 0 && !isStop(words[before])) before -= 1;
    start = before + 1 < words.length ? words[before + 1].index : start;
  }

  return trimmed.slice(start, phraseEnd);
}
