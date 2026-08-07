import { findWordBoundaryMatch, wordBoundaryMatches } from "./word-boundary.ts";

export interface ContextualReviewSegment {
  text: string;
  hidden: boolean;
}

export interface ContextualReviewCloze {
  segments: ContextualReviewSegment[];
}

export interface ContextualReviewAnswer {
  before: string;
  answer: string;
  after: string;
}

/**
 * Returns a display-safe answer model for the revealed state, or null when
 * the saved context is not reliable enough to quiz from.
 */
export function contextualReviewAnswer(sentence: string | null | undefined, word: string | null | undefined): ContextualReviewAnswer | null {
  const source = sentence?.trim();
  const target = word?.trim();
  if (!source || !target) return null;

  const match = findWordBoundaryMatch(source, target);
  if (!match) return null;

  return {
    before: source.slice(0, match.index),
    answer: match.text,
    after: source.slice(match.index + match.text.length),
  };
}

/**
 * Returns a display-safe cloze model, or null when the saved context is not
 * reliable enough to quiz from. Every boundary-respecting occurrence of the
 * target is hidden (not just the first) so the answer cannot leak through a
 * repeated word elsewhere in the sentence. The model deliberately contains no
 * per-occurrence length information: the UI renders a fixed-width blank for
 * every hidden segment.
 */
export function contextualReviewCloze(sentence: string | null | undefined, word: string | null | undefined): ContextualReviewCloze | null {
  const source = sentence?.trim();
  const target = word?.trim();
  if (!source || !target) return null;

  const matches = wordBoundaryMatches(source, target);
  if (matches.length === 0) return null;

  const segments: ContextualReviewSegment[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    if (match.index > lastIndex) segments.push({ text: source.slice(lastIndex, match.index), hidden: false });
    segments.push({ text: match.text, hidden: true });
    lastIndex = match.index + match.text.length;
  }
  if (lastIndex < source.length) segments.push({ text: source.slice(lastIndex), hidden: false });
  return { segments };
}

export function contextualSentenceMeaning(value: string | null | undefined) {
  return value?.trim() || null;
}

export interface ContextualReviewProgress {
  /** 1-based position of the card on screen; 0 only when the round is empty. */
  position: number;
  total: number;
  /** 0–1 share of the round reached, for the hairline bar under the header. */
  ratio: number;
}

/**
 * Review is a task with an end, so the card has to say how much of the round
 * is left. Takes the queue index (0-based) and the queue length; clamps both
 * so a stale index during a queue swap can never render "0 / 5" or "6 / 5".
 */
export function contextualReviewProgress(index: number, total: number): ContextualReviewProgress {
  const size = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  if (size === 0) return { position: 0, total: 0, ratio: 0 };
  const safeIndex = Number.isFinite(index) ? Math.floor(index) : 0;
  const position = Math.min(Math.max(safeIndex + 1, 1), size);
  return { position, total: size, ratio: position / size };
}

export interface ContextualReviewSource {
  bookTitle: string;
  /** Null means the UI must not draw the separator or an empty segment. */
  chapter: string | null;
}

/**
 * Composes the source line above the sentence. The chapter is what actually
 * lets the reader recall the original context, but it is not always saved, so
 * the caller gets an explicit null rather than a blank tail to render.
 */
export function contextualReviewSource(
  bookTitle: string | null | undefined,
  chapter: string | null | undefined,
  unknownBookLabel: string,
): ContextualReviewSource {
  const title = bookTitle?.trim() || unknownBookLabel;
  const section = chapter?.trim() ?? "";
  // A chapter that merely repeats the book title reads as "Book · Book";
  // dropping it is better than a separator that adds nothing.
  return { bookTitle: title, chapter: section && section !== title ? section : null };
}
