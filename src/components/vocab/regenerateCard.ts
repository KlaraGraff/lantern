import { invoke } from "@tauri-apps/api/core";
import { getAllSettings } from "../../hooks/useSettings";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { createUuid } from "../../utils/randomUuid";
import { parseCardDesignConfig } from "../learning-card/config.ts";
import { cardVocabFields } from "../learning-card/projection.ts";
import type { LearningCardResult } from "../learning-card/types.ts";
import { serializeCardSnapshot } from "./cardSnapshot.ts";
import { resolveVocabGloss } from "./collect.ts";

/**
 * Whether a saved word can have its whole card rebuilt.
 *
 * "What does it mean in this sentence" is the card's spine, so a word saved
 * without a sentence — from the selection menu, from an import — has no card
 * to rebuild and no snapshot to contradict. Those keep the one-line re-gloss.
 */
export function canRegenerateCard(word: Pick<DictionaryWord, "context_sentence">): boolean {
  return Boolean(word.context_sentence?.trim());
}

/**
 * Rebuild the whole learning card for a saved word and store it.
 *
 * The panel used to re-run the one-line gloss alone, which left the definition
 * at the top of the panel arguing with the card snapshot below it — both on
 * screen at once, one of them silently stale. So this runs the same
 * `ai_learning_card` pipeline the reader's lookup card runs (the prompt is
 * assembled in Rust from the reader's own card design; nothing is composed
 * here) and writes definition, explanation and snapshot in one transaction.
 *
 * Deliberately not routed through the lookup cache the reader's card consults
 * first: "regenerate" means the reader wants a different answer, and a cache
 * hit would hand back the very card they are trying to replace.
 */
export async function regenerateVocabCard(word: DictionaryWord): Promise<DictionaryWord> {
  const settings = await getAllSettings();
  const config = parseCardDesignConfig(settings.learning_card_config);
  const result = await invoke<LearningCardResult>("ai_learning_card", {
    text: word.word,
    context: word.context_sentence,
    kind: "word",
    bookTitle: word.book_title || null,
    // The vocabulary row carries no author, and the chapter only when the
    // listing resolved one. Both are hints in the prompt, so an absent one
    // costs a little context — inventing one would cost more.
    bookAuthor: null,
    chapter: word.chapter || null,
    cardConfig: JSON.stringify(config),
    requestId: createUuid(),
  });

  const fields = cardVocabFields(result);
  // The same funnel the collect path uses, for the same reason: the card's
  // summary becomes `definition` only when it already fits above a word, and
  // a short fresh gloss or a dictionary sense stands in when it does not.
  const definition = await resolveVocabGloss({
    bookId: word.book_id,
    word: word.word,
    contextSentence: word.context_sentence,
    gloss: fields.gloss,
  });

  return invoke<DictionaryWord>("update_vocab_card", {
    id: word.id,
    // A blank definition is refused by the backend, and losing the card over a
    // gloss the offline fallbacks could not produce would be the wrong trade —
    // the reader asked for a new card, not for their old meaning to be erased.
    definition: definition || word.definition,
    // Already null rather than empty, and null means "leave the column alone".
    contextExplanation: fields.contextExplanation,
    cardSnapshot: serializeCardSnapshot(result, Date.now()),
  });
}
