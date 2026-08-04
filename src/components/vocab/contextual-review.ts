export interface ContextualReviewCloze {
  before: string;
  after: string;
}

export interface ContextualReviewAnswer extends ContextualReviewCloze {
  answer: string;
}

const WORD_CHARACTER = "\\p{L}\\p{N}\\p{M}_";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns a display-safe cloze model, or null when the saved context is not
 * reliable enough to quiz from. The model deliberately contains no word-length
 * information: the UI renders a fixed-width blank between these two strings.
 */
export function contextualReviewAnswer(sentence: string | null | undefined, word: string | null | undefined): ContextualReviewAnswer | null {
  const source = sentence?.trim();
  const target = word?.trim();
  if (!source || !target) return null;

  const escaped = escapeRegex(target);
  // Han text is ordinarily written without separators, so applying alphabetic
  // boundaries would reject every word embedded in an otherwise valid sentence.
  const useAlphabeticBoundaries = !/\p{Script=Han}/u.test(target);
  const firstIsWord = new RegExp(`^[${WORD_CHARACTER}]`, "u").test(target);
  const lastIsWord = new RegExp(`[${WORD_CHARACTER}]$`, "u").test(target);
  const pattern = new RegExp(
    `${useAlphabeticBoundaries && firstIsWord ? `(?<![${WORD_CHARACTER}])` : ""}${escaped}${useAlphabeticBoundaries && lastIsWord ? `(?![${WORD_CHARACTER}])` : ""}`,
    "iu",
  );
  const match = pattern.exec(source);
  if (!match || match.index === undefined) return null;

  return {
    before: source.slice(0, match.index),
    answer: match[0],
    after: source.slice(match.index + match[0].length),
  };
}

export function contextualReviewCloze(sentence: string | null | undefined, word: string | null | undefined): ContextualReviewCloze | null {
  const match = contextualReviewAnswer(sentence, word);
  return match ? { before: match.before, after: match.after } : null;
}

export function contextualSentenceMeaning(value: string | null | undefined) {
  return value?.trim() || null;
}
