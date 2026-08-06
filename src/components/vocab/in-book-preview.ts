import { contextualReviewAnswer } from "./contextual-review.ts";
import {
  passiveVocabLabel,
  passiveVocabStage,
  type PassiveVocabSettings,
  type PassiveVocabStyle,
} from "../passive-vocab.ts";

export interface InBookPreviewSentence {
  before: string;
  answer: string;
  after: string;
}

/**
 * The sentence the preview renders: the word's own saved context, split
 * around its real occurrence in it. Falls back to the bare word (with no
 * surrounding sentence) when the saved context is missing or the word can no
 * longer be found in it — the same case contextual review already treats as
 * "no usable context" for its own display.
 */
export function inBookPreviewSentence(
  contextSentence: string | null | undefined,
  word: string,
): InBookPreviewSentence {
  const match = contextualReviewAnswer(contextSentence, word);
  if (match) return match;
  return { before: "", answer: word, after: "" };
}

export type InBookPreviewPlan =
  | { kind: "off" }
  | { kind: "definition"; style: PassiveVocabStyle; sentence: InBookPreviewSentence; label: string }
  | { kind: "marker"; sentence: InBookPreviewSentence }
  | { kind: "none"; sentence: InBookPreviewSentence };

/**
 * What the "in the book" preview draws, decided the same way the reader
 * itself decides it: `passiveVocabStage` reads the mastery tier, the reader's
 * own passive-vocab style setting picks ruby vs. margin, and the master
 * enabled switch overrides everything else — a preview drawn while the
 * reader's annotations are off would show a mark the book itself never shows.
 *
 * Two more suppressions are copied from `selectPassiveVocab` (`passive-vocab.ts`),
 * the function that actually decides what gets annotated in the text: a word
 * with no CFI, or an empty `passiveVocabLabel`, draws nothing there, so the
 * preview must fall to `none` too rather than promise a definition the page
 * never shows. The per-screen definition *count* limit in that same function
 * is deliberately **not** copied — it depends on which other words share the
 * current screen, something this word-detail view has no way to know (and
 * showing "maybe" would be worse than showing the untruncated truth).
 */
export function resolveInBookPreviewPlan(
  passiveVocab: PassiveVocabSettings,
  mastery: string | null | undefined,
  definition: string | null | undefined,
  contextSentence: string | null | undefined,
  word: string,
  cfi: string | null | undefined,
): InBookPreviewPlan {
  if (!passiveVocab.enabled) return { kind: "off" };
  const sentence = inBookPreviewSentence(contextSentence, word);
  const stage = passiveVocabStage(mastery);
  if (stage === "none") return { kind: "none", sentence };
  if (stage === "marker") return { kind: "marker", sentence };
  const label = passiveVocabLabel(definition);
  if (!cfi || !label) return { kind: "none", sentence };
  return { kind: "definition", style: passiveVocab.style, sentence, label };
}
