import { invoke } from "@tauri-apps/api/core";
import { createUuid } from "../../utils/randomUuid";

interface CollectWordArgs {
  bookId: string;
  word: string;
  contextSentence?: string | null;
  cfi?: string | null;
}

/**
 * Saves a word from the selection menu, filling in a short gloss first.
 *
 * The gloss is generated *before* the row is created rather than backfilled
 * afterwards: `VocabAdd` already carries `definition`, whereas updating it
 * later would need a new sync event type. The cost is that saving waits on one
 * short model call — the row appears with its meaning instead of appearing bare
 * and changing under the user a second later.
 *
 * A failure here is not worth surfacing: AI may be unconfigured, offline, or
 * slow, and a word saved without a gloss is exactly the previous behaviour.
 */
export async function collectWord({ bookId, word, contextSentence, cfi }: CollectWordArgs) {
  let definition = "";
  try {
    definition = await invoke<string>("ai_vocab_gloss", {
      word,
      context: contextSentence || null,
      requestId: createUuid(),
    });
  } catch {
    // Saved without a gloss, same as before this existed.
  }

  if (!definition.trim()) {
    // No AI configured, or the call failed. A dictionary sense cannot know
    // which meaning this sentence used, but it beats an empty row.
    try {
      const entry = await invoke<{ firstSense: string }>("dictionary_gloss", { word });
      definition = entry.firstSense;
    } catch {
      // Saved bare.
    }
  }

  await invoke("add_vocab_word", {
    bookId,
    word,
    definition,
    contextSentence: contextSentence || null,
    contextExplanation: null,
    cfi: cfi || null,
  });
}
