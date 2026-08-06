/**
 * The shape of `vocab_words.definition`: one short line, in the reader's own
 * UI language, that fits above a word as a ruby annotation.
 *
 * Every save path funnels through here because `definition` is read in four
 * places at once — the passive-vocab gloss over the word, the vocabulary list,
 * review cards, and export. A path that stored a paragraph there (the learning
 * card used to store its whole `word_info` module) corrupted all four at once.
 * The long text has its own column: `context_explanation`.
 *
 * Nothing in this module talks to Tauri or the DOM, so the rules below can be
 * asserted directly in unit tests.
 */

/**
 * Full-width scripts carry roughly twice the meaning per character and take
 * roughly twice the horizontal room, so the ceiling is counted in columns
 * rather than characters: about 14 CJK characters, or about 28 Latin ones.
 * The model is asked for far less than this (~8 CJK / ~24 Latin); the ceiling
 * is the guard rail, not the target.
 */
const WIDE_CHARACTER = new RegExp(
  "[\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF"
  + "\\uA000-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE30-\\uFE6F\\uFF00-\\uFF60"
  + "\\uFFE0-\\uFFE6]",
);

export const MAX_GLOSS_WIDTH = 28;

/** Display width in columns, counting full-width characters as two. */
export function glossWidth(text: string) {
  let width = 0;
  for (const character of text) width += WIDE_CHARACTER.test(character) ? 2 : 1;
  return width;
}

/**
 * The first meaningful line, stripped of the decoration models put around a
 * gloss: bullets, bold markers, code ticks, quotes, a trailing full stop.
 */
export function condenseGloss(text: string | null | undefined) {
  const first = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
  return first
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^[-*>#\s]+/, "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.。]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a definition a caller already holds can be stored as-is. A blank
 * one cannot (there is nothing to show), and neither can a multi-line or
 * over-wide one — that is the card blob this whole module exists to keep out.
 */
export function isShortGloss(text: string | null | undefined) {
  const plain = (text ?? "").trim();
  if (!plain || /\r?\n/.test(plain)) return false;
  return glossWidth(plain) <= MAX_GLOSS_WIDTH;
}

/**
 * Last-resort clamp. Truncation is never the mechanism that makes a gloss
 * short — the model is asked for a short one and a dictionary sense is the
 * offline fallback — but a runaway answer must not be allowed to sit over a
 * word, so anything still too wide is cut with an ellipsis.
 */
export function clampGloss(text: string | null | undefined, maxWidth = MAX_GLOSS_WIDTH) {
  const plain = (text ?? "").replace(/\s+/g, " ").trim();
  if (glossWidth(plain) <= maxWidth) return plain;
  let width = 0;
  let kept = "";
  for (const character of plain) {
    const next = width + (WIDE_CHARACTER.test(character) ? 2 : 1);
    // One column is reserved for the ellipsis itself.
    if (next > maxWidth - 1) break;
    kept += character;
    width = next;
  }
  return `${kept.trimEnd()}…`;
}
