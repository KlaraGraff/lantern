import { findWordBoundaryMatch, wordBoundaryRegex } from "./word-boundary.ts";

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
    answer: match[0],
    after: source.slice(match.index + match[0].length),
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

  const regex = wordBoundaryRegex(target, "giu");
  const segments: ContextualReviewSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let found = false;
  while ((match = regex.exec(source))) {
    found = true;
    if (match.index > lastIndex) segments.push({ text: source.slice(lastIndex, match.index), hidden: false });
    segments.push({ text: match[0], hidden: true });
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (!found) return null;
  if (lastIndex < source.length) segments.push({ text: source.slice(lastIndex), hidden: false });
  return { segments };
}

export function contextualSentenceMeaning(value: string | null | undefined) {
  return value?.trim() || null;
}
