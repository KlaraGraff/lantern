import { invoke } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import { createUuid } from "../../utils/randomUuid";
import { clampGloss, condenseGloss, isShortGloss } from "./gloss.ts";

export interface SaveVocabWordArgs {
  bookId: string;
  word: string;
  contextSentence?: string | null;
  cfi?: string | null;
  /**
   * A definition this caller already holds — a translation, a card's summary,
   * a stored lookup. Used verbatim when it is already one short line, and
   * otherwise treated as raw material rather than as the gloss.
   */
  gloss?: string | null;
  /** The long, card-shaped text this save produced, if any. */
  contextExplanation?: string | null;
  /**
   * The whole learning card result, serialised, for a future vocabulary
   * detail surface. Nothing reads this yet.
   */
  cardSnapshot?: string | null;
}

/**
 * The single gloss every save path stores in `definition`.
 *
 * Order matters: something the caller already paid for beats a fresh model
 * call, a fresh model call beats the offline dictionary, and the dictionary
 * beats a clamped fragment of whatever long text was on hand. Truncation is
 * only ever the last of those, never the mechanism.
 *
 * A failure at any step is not worth surfacing: AI may be unconfigured,
 * offline, or slow, and the next fallback down is always something.
 */
export async function resolveVocabGloss({ word, contextSentence, gloss }: SaveVocabWordArgs) {
  const offered = condenseGloss(gloss);
  if (isShortGloss(offered)) return offered;

  try {
    const generated = await invoke<string>("ai_vocab_gloss", {
      word,
      context: contextSentence || null,
      // The reader's own UI language, resolved by i18next — not a language
      // pinned in code, and not the translation target, which is a separate
      // choice they may have set for a different purpose.
      locale: i18n.resolvedLanguage || i18n.language || null,
      requestId: createUuid(),
    });
    const cleaned = condenseGloss(generated);
    if (cleaned) return clampGloss(cleaned);
  } catch {
    // Fall through to the dictionary.
  }

  try {
    // A dictionary sense cannot know which meaning this sentence used, but it
    // beats an empty row.
    const entry = await invoke<{ firstSense: string }>("dictionary_gloss", { word });
    const sense = condenseGloss(entry.firstSense);
    if (sense) return clampGloss(sense);
  } catch {
    // Saved with whatever the caller had.
  }

  return clampGloss(offered);
}

/**
 * Saves a word, filling in the gloss first.
 *
 * The gloss is generated *before* the row is created rather than backfilled
 * afterwards: `VocabAdd` already carries `definition`, whereas updating it
 * later would need a new sync event type. The cost is that saving waits on one
 * short model call — the row appears with its meaning instead of appearing
 * bare and changing under the user a second later.
 */
export async function saveVocabWord<T = unknown>(args: SaveVocabWordArgs) {
  const definition = await resolveVocabGloss(args);
  return invoke<T>("add_vocab_word", {
    bookId: args.bookId,
    word: args.word,
    definition,
    contextSentence: args.contextSentence || null,
    contextExplanation: args.contextExplanation || null,
    cfi: args.cfi || null,
    cardSnapshot: args.cardSnapshot || null,
  });
}

/** The selection menu's "save" — no long text to keep, so no explanation. */
export async function collectWord(args: Omit<SaveVocabWordArgs, "gloss" | "contextExplanation">) {
  await saveVocabWord(args);
}
