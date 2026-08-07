/**
 * Which sentence a continuous read-aloud run opens with, given where the page
 * the reader is looking at begins.
 *
 * The reader is looking at this page; playback is something that happens to what
 * they can see. So the run opens with the first sentence that *begins* on the
 * page, never with one that began earlier and merely spills onto it: a spilling
 * sentence's true start is behind the reader, and revealing it drags the view
 * back to a page they had already left. Starting playback may move the reader
 * forwards (the next sentence, the next section) but never backwards.
 */

/**
 * One sentence's position relative to the page's first character.
 *
 * Both fields are the sign of a boundary comparison — negative before the page
 * starts, zero exactly at it, positive after — which is all the decision needs
 * and is what keeps it out of the DOM.
 */
export interface SentenceBoundaries {
  /** Sign of (sentence start − page start). */
  startVsPage: number;
  /** Sign of (sentence end − page start). */
  endVsPage: number;
}

export type ReadAloudStart =
  /**
   * This sentence opens on the page. Read it and reveal it the ordinary way —
   * revealing cannot move backwards, because the sentence starts here.
   */
  | { kind: "sentence"; index: number }
  /**
   * No sentence opens on the page: it is the middle of one long sentence that
   * started earlier. Read that sentence — it is the text on screen, and half a
   * sentence cannot be spoken — but hold the view still. Skipping it instead
   * would silently drop text the reader can see, and honouring its true start
   * would throw the page backwards, which is the thing this rule forbids.
   */
  | { kind: "continuation"; index: number }
  /**
   * Nothing here to open with — no sentences at all, or every one of them ends
   * before the page does. The caller falls through to the next section.
   */
  | { kind: "none" };

export function pickReadAloudStart(sentences: readonly SentenceBoundaries[]): ReadAloudStart {
  const opening = sentences.findIndex((sentence) => sentence.startVsPage >= 0);
  if (opening >= 0) return { kind: "sentence", index: opening };
  // Ends *after* the page starts, so the page shows part of it. Strictly after:
  // a sentence ending exactly at the page's first character is entirely behind
  // the reader and has nothing on screen.
  const spilling = sentences.findIndex((sentence) => sentence.endVsPage > 0);
  if (spilling >= 0) return { kind: "continuation", index: spilling };
  return { kind: "none" };
}
