/**
 * How long an action waits to see whether another click is coming. One click
 * yields to two, and two yield to three, so each count has to outlive the next.
 */
export const CLICK_COUNT_GRACE_MS = 240;

/**
 * The wait a click count needs when a later count can still claim the gesture.
 *
 * The system's own multi-click interval is around 500ms, and it is the system —
 * not us — that decides whether a third press arrives as `detail === 3`. With
 * the shorter grace window the two clocks disagree: a third click 300ms after
 * the second still counts as a triple-click, but our double-click card has
 * already opened, so the gesture ends with the card and the selection menu both
 * on screen. Outliving the system window is what makes the third click able to
 * call the card off.
 */
export const MULTI_CLICK_GRACE_MS = 450;

/**
 * How long the action for `clickCount` waits before it commits.
 *
 * Only the double-click has to wait out the system window, and only while a
 * triple-click can take the gesture away from it. Single clicks never lose to a
 * third press — a double-click already cancelled them by then — and when
 * triple-click select is off there is no third-click gesture to lose to, so
 * both keep the short wait.
 */
export function clickCountGraceMs(clickCount: number, tripleClickQuickSelect: boolean): number {
  return clickCount === 2 && tripleClickQuickSelect
    ? MULTI_CLICK_GRACE_MS
    : CLICK_COUNT_GRACE_MS;
}
