import { useCallback, useEffect, useRef, type RefObject } from "react";
import { freezeReader, type ShadowHost } from "./reader-freeze";

/** A little past `--motion-travel` (260ms), so the fallback never cuts a transition short. */
const DOCK_FALLBACK_MS = 320;

/**
 * Pinning or unpinning a card changes the page's width through one CSS
 * transition of the slot beside it. Reflowing on every frame of that would
 * re-columnize the chapter a dozen times, so the page is held still for the
 * transition (`freezeReader`) and reflows once when it ends.
 *
 * The release is guaranteed: on the slot's `transitionend`, or after a
 * fallback timeout when no transition runs (reduced motion, a hidden window,
 * a slot that did not actually change width).
 */
export function useDockTransition<T extends ShadowHost>(
  viewRef: RefObject<T | null>,
  viewerRef: RefObject<HTMLElement | null>,
) {
  const releaseRef = useRef<(() => void) | null>(null);

  const settle = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  /** Call before the slot's width changes, with the slot that will transition. */
  const dock = useCallback((slot: HTMLElement | null) => {
    // A pin pressed mid-transition keeps the freeze already in place: the
    // viewer is still at the width it had before the first one.
    if (releaseRef.current) return;
    const release = freezeReader(viewRef.current, viewerRef.current);
    let timer = 0;
    const done = (event?: TransitionEvent) => {
      if (event && (event.target !== slot || event.propertyName !== "width")) return;
      slot?.removeEventListener("transitionend", done);
      slot?.removeEventListener("transitioncancel", done);
      window.clearTimeout(timer);
      if (releaseRef.current === finish) releaseRef.current = null;
      release();
    };
    const finish = () => done();
    slot?.addEventListener("transitionend", done);
    slot?.addEventListener("transitioncancel", done);
    timer = window.setTimeout(finish, DOCK_FALLBACK_MS);
    releaseRef.current = finish;
  }, [viewRef, viewerRef]);

  useEffect(() => settle, [settle]);

  return dock;
}
