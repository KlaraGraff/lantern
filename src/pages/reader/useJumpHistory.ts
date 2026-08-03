import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One entry: where the reader was *before* a jump, so a return can land back
 * on it. `location` is whatever `goTo`-style navigation accepts back — a CFI,
 * a text-book location string (see `text-book-location.ts`), or an href — and
 * `label` is a short human-readable description of that origin (typically the
 * chapter title) shown in the return pill.
 */
export interface JumpHistoryEntry {
  location: string;
  label: string;
}

/**
 * How many ordinary page turns the return pill survives once a jump lands,
 * before fading out. Not a fixed timer — a reader who lingers on the page
 * they jumped to keeps the affordance for as long as they stay put.
 */
export const FADE_AFTER_PAGE_TURNS = 3;

export function pushEntry(
  stack: readonly JumpHistoryEntry[],
  entry: JumpHistoryEntry,
): JumpHistoryEntry[] {
  return [...stack, entry];
}

export function popEntry(
  stack: readonly JumpHistoryEntry[],
): { stack: JumpHistoryEntry[]; popped: JumpHistoryEntry | undefined } {
  if (stack.length === 0) return { stack: [...stack], popped: undefined };
  return { stack: stack.slice(0, -1), popped: stack[stack.length - 1] };
}

export function topLabel(stack: readonly JumpHistoryEntry[]): string | null {
  return stack.length > 0 ? stack[stack.length - 1].label : null;
}

/** Counts ordinary location changes since the last jump, to drive the pill's fade. */
export interface FadeCounter {
  turnsSincePush: number;
  /**
   * True right after a push or a return: the `goTo` the caller is about to
   * issue will itself fire one more relocate/progress update, which must not
   * count against the fade budget.
   */
  suppressNext: boolean;
}

export function initialFadeCounter(): FadeCounter {
  return { turnsSincePush: 0, suppressNext: false };
}

/** Call whenever a jump (push) or a return (pop) is about to navigate. */
export function armFadeCounter(): FadeCounter {
  return { turnsSincePush: 0, suppressNext: true };
}

/**
 * Call on every ordinary relocate/progress update (not the one a jump itself
 * causes). Returns the updated counter and whether the pill should still be
 * visible.
 */
export function advanceFadeCounter(
  counter: FadeCounter,
): { counter: FadeCounter; visible: boolean } {
  if (counter.suppressNext) {
    return { counter: { turnsSincePush: 0, suppressNext: false }, visible: true };
  }
  const turnsSincePush = counter.turnsSincePush + 1;
  return {
    counter: { turnsSincePush, suppressNext: false },
    visible: turnsSincePush < FADE_AFTER_PAGE_TURNS,
  };
}

export interface UseJumpHistoryResult {
  /**
   * Push the reader's current position before navigating away from it. Every
   * jump entry point (TOC, bookmarks, highlights, AI citations, footnote
   * "jump to source", and later the P1.6 scrubber and P1.2 search panel) calls
   * this immediately before its own `goTo` — never after, and never for an
   * ordinary page turn.
   *
   * `location` is typically `currentCfiRef.current` — a no-op when it is
   * null/undefined (nothing to return to yet). `label` is a short description
   * of that origin, e.g. the current chapter title.
   */
  pushJump(location: string | null | undefined, label: string): void;
  /** Pops the top entry and returns it (or `undefined` if empty) — the caller navigates to `entry.location` itself. */
  popJump(): JumpHistoryEntry | undefined;
  /** Call after every ordinary relocate/progress update so the pill can fade. */
  notifyLocationChanged(): void;
  /** Whether the return pill should currently be shown. */
  visible: boolean;
  /** Label of the entry a return would land on; `null` when the stack is empty. */
  label: string | null;
}

/**
 * The reader's single jump-history stack (P1.3). Owned here, at the top of
 * the reader page, because it has to outlive any one navigation source —
 * TOC, bookmarks/highlights, AI citations, and footnotes all share it, and it
 * has to reset on a book change independent of any of them re-mounting.
 */
export function useJumpHistory(bookId: string | undefined): UseJumpHistoryResult {
  const stackRef = useRef<JumpHistoryEntry[]>([]);
  const fadeRef = useRef<FadeCounter>(initialFadeCounter());
  const [ui, setUi] = useState<{ visible: boolean; label: string | null }>({
    visible: false,
    label: null,
  });

  // A new book means a new stack — a CFI/label from the last one wouldn't
  // resolve here anyway.
  useEffect(() => {
    stackRef.current = [];
    fadeRef.current = initialFadeCounter();
    setUi({ visible: false, label: null });
  }, [bookId]);

  const pushJump = useCallback((location: string | null | undefined, label: string) => {
    if (!location) return;
    stackRef.current = pushEntry(stackRef.current, { location, label });
    fadeRef.current = armFadeCounter();
    setUi({ visible: true, label });
  }, []);

  const popJump = useCallback((): JumpHistoryEntry | undefined => {
    const { stack, popped } = popEntry(stackRef.current);
    if (!popped) return undefined;
    stackRef.current = stack;
    fadeRef.current = armFadeCounter();
    setUi({ visible: stack.length > 0, label: topLabel(stack) });
    return popped;
  }, []);

  const notifyLocationChanged = useCallback(() => {
    if (stackRef.current.length === 0) return;
    const { counter, visible } = advanceFadeCounter(fadeRef.current);
    fadeRef.current = counter;
    setUi((prev) => (prev.visible === visible ? prev : { ...prev, visible }));
  }, []);

  return {
    pushJump,
    popJump,
    notifyLocationChanged,
    visible: ui.visible,
    label: ui.label,
  };
}
