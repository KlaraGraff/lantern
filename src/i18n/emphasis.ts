/**
 * Emphasis inside a translated sentence.
 *
 * Some sentences need one word or one number picked out mid-sentence — "harder
 * than what you usually read", "8.4% of the running text". Where that run
 * falls depends entirely on the language, so it cannot be a separate element
 * the layout places next to a string, and splitting the sentence into three
 * translation keys would hand translators a sentence they cannot reorder.
 *
 * So the translation carries a private marker around the emphasized run and
 * the renderer splits on it. `<Trans>` would also solve this, but it is not
 * used anywhere in this codebase, and introducing an HTML-in-translations
 * convention for a handful of sentences is a larger commitment than a split.
 *
 * U+0011 is a device control character: it is never typed, never pasted, has
 * no visible width, and passes through i18next interpolation untouched.
 */
const MARK = "\u0011";

/** Wrap a value so the renderer will emphasize it. */
export function markEmphasis(value: string | number): string {
  return `${MARK}${value}${MARK}`;
}

export interface EmphasisPart {
  text: string;
  emphasis: boolean;
}

/**
 * Split a marked sentence into runs. Odd-indexed runs are the emphasized ones,
 * which falls out of splitting on a paired delimiter. An unmarked string comes
 * back as a single unemphasized run, so callers never need to check first.
 */
export function splitEmphasis(text: string): EmphasisPart[] {
  return text
    .split(MARK)
    .map((part, index) => ({ text: part, emphasis: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}
