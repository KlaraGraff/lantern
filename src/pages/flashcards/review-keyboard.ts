/**
 * What a keypress means on the flashcard page.
 *
 * Kept out of the page so the decision can be tested without a React tree.
 * The order of the branches is the bug-prone part: the question side focuses
 * 「显示答案」 and the answer side moves focus onto the first rating button, so
 * a branch that sits behind the "focus is on a control" guard never runs
 * exactly where the reader starts. The footer advertises 1–4 and H as
 * shortcuts on this page, which is the promise this function keeps.
 */
export type ReviewKeyAction =
  | { kind: "back" }
  | { kind: "hint" }
  | { kind: "reveal" }
  | { kind: "rate"; rating: "again" | "hard" | "good" | "easy" };

const RATINGS = ["again", "hard", "good", "easy"] as const;

export interface ReviewKeyState {
  reviewing: boolean;
  answerVisible: boolean;
  submitting: boolean;
  /** Focus sits on a control that handles keys itself (or would take a click from Space). */
  onControl: boolean;
  /** Focus sits in a text field, where a letter or digit is typing. */
  onTextEntry: boolean;
}

export interface ReviewKeyInput {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export function reviewKeyAction(
  event: ReviewKeyInput,
  state: ReviewKeyState,
): ReviewKeyAction | null {
  if (event.key === "Escape") return { kind: "back" };
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;

  if (
    state.reviewing
    && !state.answerVisible
    && plain
    && (event.key === "h" || event.key === "H")
    && !state.onTextEntry
  ) {
    return { kind: "hint" };
  }

  // Before the control guard: these are the shortcuts the footer prints, and
  // the rating buttons hold focus by default on the answer side.
  if (
    state.reviewing
    && state.answerVisible
    && !state.submitting
    && !state.onTextEntry
    && plain
    && /^[1-4]$/.test(event.key)
  ) {
    return { kind: "rate", rating: RATINGS[Number(event.key) - 1] };
  }

  if (state.onControl) return null;

  // Space activates a focused button natively, so it is only claimed when
  // nothing focusable owns it.
  if (state.reviewing && !state.answerVisible && event.code === "Space") {
    return { kind: "reveal" };
  }
  return null;
}
