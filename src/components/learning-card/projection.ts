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

/** The two text columns a lookup record keeps from a card. */
export function projection(result: LearningCardResult) {
  const context = moduleText(result.modules.context_meaning);
  const wordInfo = moduleText(result.modules.word_info);
  return {
    definition: wordInfo || context,
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
    gloss: result.modules.context_meaning?.summary ?? result.modules.word_info?.summary ?? null,
    // Normalised to null here rather than at each call site: an empty string
    // in `context_explanation` renders as a heading over nothing.
    contextExplanation: (projected.contextExplanation ?? projected.definition) || null,
  };
}
