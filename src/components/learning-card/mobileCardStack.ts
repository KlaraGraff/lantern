import { useId, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Which open learning card gets the phone's one bottom sheet.
 *
 * Desktop keeps every open card on screen at once, cascading new ones down
 * and to the right (`placement.ts`); a phone only has room for one sheet, so
 * coarse pointer needs an answer to "which card is that". The array that
 * orders them (`useLearningCards`, in `src/pages/reader/`) is out of this
 * file's reach — that hook owns the reader's state, this directory only owns
 * how a card presents itself — so there is no shared parent state to read
 * "am I the newest" from directly.
 *
 * What each `LearningCardController` instance does have is its own
 * `stackIndex` prop, which is exactly its position in that array on every
 * render (`useLearningCards` only ever appends to the end and filters in
 * place — see its own comments — so it never reorders). This module is the
 * one place instances compare notes: every mounted card registers its current
 * `stackIndex` here, and "front" is whichever registration currently holds
 * the highest index — the most recently opened card that is still open.
 *
 * That last clause matters: closing the front card does not blank the sheet.
 * It removes that one registration, the previously-second card's index is now
 * the highest on record, and the sheet shows it next. A phone reader who taps
 * a second word by accident does not lose the first lookup's answer to it —
 * closing the sheet just walks back through whatever is still open, the same
 * cards the desktop cascade would still be showing.
 */

const registry = new Map<string, number>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The token holding the highest registered index, or `null` when nothing is
 * registered. Ties (two tokens on the same index) resolve to whichever is
 * seen last while walking the map — in practice this only happens for one
 * render's width, while an instance whose `stackIndex` just changed has not
 * yet overwritten its old entry; the eventual state is always index-unique
 * because `stackIndex` values come from one array's positions.
 *
 * Exported on its own, apart from the hook below, so the resolution rule can
 * be tested as arithmetic on a plain map — no React tree required.
 */
export function resolveFrontToken(entries: ReadonlyMap<string, number>): string | null {
  let front: string | null = null;
  let max = -Infinity;
  for (const [token, index] of entries) {
    if (index >= max) {
      max = index;
      front = token;
    }
  }
  return front;
}

/**
 * True while this instance's `stackIndex` is the highest currently
 * registered — i.e. while it is the one the phone's bottom sheet should show.
 *
 * `active` gates registration rather than being checked by the caller before
 * calling the hook, so desktop can call this unconditionally (React's rule
 * against conditional hooks) while paying for none of it: inactive instances
 * never write to the registry and their snapshot is always `false`.
 */
export function useIsFrontMobileCard(stackIndex: number, active: boolean): boolean {
  const token = useId();

  useLayoutEffect(() => {
    if (!active) return;
    registry.set(token, stackIndex);
    notify();
    return () => {
      registry.delete(token);
      notify();
    };
  }, [token, stackIndex, active]);

  return useSyncExternalStore(subscribe, () => active && resolveFrontToken(registry) === token);
}
