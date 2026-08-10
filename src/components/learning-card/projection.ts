/**
 * What a finished learning card contributes to the rows that outlive it.
 *
 * A card is thrown away when it closes; the lookup record and the saved word
 * are what remain. Both are filled from the same result, and both used to be
 * filled by private helpers inside `LearningCardController` — which is why the
 * vocabulary panel's "regenerate" could not reuse them without copying the
 * rules, and copied rules drift. They live here so the two paths that write a
 * saved word (collect, regenerate) provably agree.
 *
 * Nothing here imports React, i18n or Tauri (explicit `.ts` extensions, the
 * same as `cardSnapshot.ts`) so the rules below can be asserted in a plain
 * `node --test` run.
 */
import { clampGloss, condenseGloss } from "../vocab/gloss.ts";
import type { LearningCardResult, LearningModuleContent } from "./types.ts";

/** Every scrap of prose in one module, flattened in the order it is drawn. */
export function moduleText(content: LearningModuleContent | undefined): string {
  if (!content) return "";
  return [
    content.heading,
    content.summary,
    ...(content.details ?? []),
    ...(content.items ?? []).flatMap((item) => [item.title, item.text, ...(item.examples ?? []).flatMap((example) => [example.source, example.target])]),
    content.quote,
  ].filter(Boolean).join("\n");
}

/**
 * The one short line a card offers as the gloss — the text that ends up above
 * the word in the book.
 *
 * `context_meaning.summary` is written for exactly this job: the prompt asks
 * for the bare contextual sense there and puts the sentence that explains it in
 * `details`. Everything after it is a fallback for a card that ignored the
 * contract or had the module switched off.
 *
 * `word_info` is deliberately absent. It describes spelling, pronunciation and
 * form — "reuniting 是 reunite 的现在分词形式" is a true sentence and a useless
 * gloss, and it is what used to be printed over the word. With nothing on
 * offer here the save paths fall through to a fresh one-line gloss or the
 * offline dictionary, both of which answer "what does it mean".
 */
export function cardGloss(result: LearningCardResult): string | null {
  const context = result.modules.context_meaning;
  const candidates = [
    context?.summary,
    context?.heading,
    result.modules.target_translation?.summary,
    result.modules.common_senses?.items?.[0]?.title,
  ];
  for (const candidate of candidates) {
    const condensed = condenseGloss(candidate);
    if (condensed) return condensed;
  }
  return null;
}

/**
 * The two text columns a lookup record keeps from a card.
 *
 * `definition` is the same short gloss the vocabulary list stores, clamped, and
 * not by coincidence: every lookup drops the word into the observation zone
 * (`observe_lookup_for_vocab`), and this string is copied verbatim into
 * `vocab_words.definition` — the ruby annotation over the word. It used to be
 * the whole `word_info` module, so a first lookup planted a four-line
 * morphology blob above the word and the reader saw its first line there.
 *
 * The old preference had a reason on file — a cached lookup is reused in other
 * sentences, so the context-independent module was thought to travel better.
 * The premise is wrong: `find_cached_lookup` only ever reuses an answer at the
 * same CFI, or failing that in the same sentence.
 */
export function projection(result: LearningCardResult) {
  const context = moduleText(result.modules.context_meaning);
  const wordInfo = moduleText(result.modules.word_info);
  return {
    // The last resort keeps a blob out of the column rather than keeping the
    // column full: whatever text exists is condensed to its first line and
    // clamped to what fits over a word.
    definition: clampGloss(cardGloss(result) ?? condenseGloss(context || wordInfo)),
    contextExplanation: context || null,
  };
}

/**
 * The two fields a *saved word* takes from a card.
 *
 * `gloss` is only an offer: `definition` is one short line printed above the
 * word in the book, and the caller runs this through `resolveVocabGloss`,
 * which uses it verbatim only when it already fits. The card's own long text
 * belongs in `context_explanation` — storing it in `definition` once put a
 * module heading over every saved word.
 */
export function cardVocabFields(result: LearningCardResult) {
  const projected = projection(result);
  return {
    gloss: cardGloss(result),
    // Normalised to null here rather than at each call site: an empty string
    // in `context_explanation` renders as a heading over nothing.
    contextExplanation: (projected.contextExplanation ?? projected.definition) || null,
  };
}
