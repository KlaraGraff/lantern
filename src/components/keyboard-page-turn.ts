export type KeyboardPageTurnDirection = "previous" | "next";

export interface KeyboardPageTurnRepeaterOptions {
  turn(direction: KeyboardPageTurnDirection): void;
  /** Foliate's native slide lasts 300ms, so repeats must not outrun it. */
  minRepeatIntervalMs?: number;
  now?(): number;
}

export interface KeyboardPageTurnRepeater {
  handle(direction: KeyboardPageTurnDirection, repeated: boolean): void;
  reset(): void;
}

/**
 * Lets a held page-turn key progress at the pace the reader can render, while
 * rejecting the much faster browser key-repeat stream that would otherwise
 * accumulate delayed turns after the key is released.
 */
export function createKeyboardPageTurnRepeater({
  turn,
  minRepeatIntervalMs = 350,
  now = () => performance.now(),
}: KeyboardPageTurnRepeaterOptions): KeyboardPageTurnRepeater {
  let lastTurnAt = Number.NEGATIVE_INFINITY;

  const reset = () => {
    lastTurnAt = Number.NEGATIVE_INFINITY;
  };

  const handle = (direction: KeyboardPageTurnDirection, repeated: boolean) => {
    const timestamp = now();
    if (repeated && timestamp - lastTurnAt < minRepeatIntervalMs) return;
    lastTurnAt = timestamp;
    turn(direction);
  };

  return { handle, reset };
}
