import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import {
  DOCK_MORPH_EASING,
  DOCK_MORPH_FADE_MS,
  DOCK_MORPH_MS,
  dockMorphFrames,
  shouldMorph,
  type MorphRect,
} from "./dock-morph.ts";

/** Past the move and both fades, so a stand-in can never outlive its animation. */
const MORPH_FALLBACK_MS = DOCK_MORPH_MS + 2 * DOCK_MORPH_FADE_MS + 200;

const rectOf = (element: HTMLElement): MorphRect => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
};

const pinTo = (element: HTMLElement, rect: MorphRect) => {
  element.setAttribute("aria-hidden", "true");
  element.inert = true;
  Object.assign(element.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    zIndex: "70",
    pointerEvents: "none",
    boxSizing: "border-box",
  });
};

interface PendingMorph {
  from: MorphRect;
  /** A copy of what the answer card showed, left in its place to fade. */
  words: HTMLElement;
  /** The right card was already on screen: it is landed on, not revealed. */
  targetShown: boolean;
}

/**
 * The 「停靠」 move (`dock-morph.ts`) from an answer card into the right card.
 *
 * `prepare` is called in the click that docks, while the answer card is still
 * on screen: it reads the card's box and keeps a copy of what it shows. The
 * move starts on the commit that opens the right card, before paint, so the
 * right card is never seen in its place before the box arrives there.
 */
export function useDockMorph(targetRef: RefObject<HTMLElement | null>, narrow: boolean) {
  const pendingRef = useRef<PendingMorph | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const prepare = useCallback((source: HTMLElement | null | undefined, targetShown: boolean) => {
    pendingRef.current = null;
    // The visible card is the dialog inside the positioned wrapper.
    const card = (source?.firstElementChild as HTMLElement | null) ?? source ?? null;
    const from = card ? rectOf(card) : null;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!card || !shouldMorph({ from, narrow, reducedMotion }) || !from) return;
    const words = card.cloneNode(true) as HTMLElement;
    words.removeAttribute("id");
    words.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    pendingRef.current = { from, words, targetShown };
  }, [narrow]);

  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const target = targetRef.current;
    if (!target) return;
    cleanupRef.current?.();

    // Hold the right card invisible where it will stand, without its own
    // slide-in, so the box lands on the place it really takes.
    const hideTarget = !pending.targetShown;
    if (hideTarget) {
      target.style.transition = "none";
      target.style.opacity = "0";
    }
    const to = rectOf(target);
    const frames = dockMorphFrames(pending.from, to);
    const restoreTarget = () => {
      if (!hideTarget) return;
      target.style.opacity = "";
      // Shown at once, under the box, and only then given its transition
      // back, so nothing of the card's own slide replays.
      void target.offsetWidth;
      target.style.transition = "";
    };
    if (!frames) {
      restoreTarget();
      return;
    }

    const targetStyle = getComputedStyle(target);
    const box = document.createElement("div");
    pinTo(box, to);
    Object.assign(box.style, {
      transformOrigin: "0 0",
      borderRadius: targetStyle.borderRadius,
      backgroundColor: targetStyle.backgroundColor,
      boxShadow: targetStyle.boxShadow,
    });
    const { words, from } = pending;
    pinTo(words, from);
    // Above the box: the answer is read where it was until it has faded.
    words.style.zIndex = "71";
    document.body.append(box, words);

    let done = false;
    let timer = 0;
    let frame = 0;
    const finish = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      box.remove();
      words.remove();
      restoreTarget();
      if (cleanupRef.current === finish) cleanupRef.current = null;
    };
    cleanupRef.current = finish;

    const fade = { duration: DOCK_MORPH_FADE_MS, easing: "ease-out", fill: "forwards" } as const;
    const leave = words.animate([{ opacity: 1 }, { opacity: 0 }], fade);
    const move = box.animate(frames, { duration: DOCK_MORPH_MS, easing: DOCK_MORPH_EASING, fill: "forwards" });
    // Held on the first frame until the frame that is painted: opening the
    // right card can keep the page busy for a few frames, and a move timed
    // from the click would be half over before it is first seen.
    leave.pause();
    move.pause();
    frame = window.requestAnimationFrame(() => {
      leave.play();
      move.play();
      timer = window.setTimeout(finish, MORPH_FALLBACK_MS);
    });
    move.finished
      .then(() => {
        if (done) return;
        restoreTarget();
        // The box now covers the right card exactly; fading it lets the
        // card's own content come up through it.
        return box.animate([{ opacity: 1 }, { opacity: 0 }], fade).finished;
      })
      .catch(() => {})
      .finally(finish);
  });

  useEffect(() => () => cleanupRef.current?.(), []);

  return prepare;
}
