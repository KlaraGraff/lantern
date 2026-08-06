import { useSyncExternalStore } from "react";

/**
 * Mirrors `@custom-variant touch (@media (pointer: coarse))` from `index.css`,
 * so a component that needs the same decision in JavaScript (which presentation
 * to render, not just which classes to apply) asks the same question the
 * stylesheet asks and the two can never disagree. This is about the input
 * device, not the viewport: a mouse-driven window narrowed to phone width
 * stays "fine", and a large iPad under a finger stays "coarse".
 */
const COARSE_POINTER_QUERY = "(pointer: coarse)";

let coarsePointerQuery: MediaQueryList | null = null;
function getCoarsePointerQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  coarsePointerQuery ??= window.matchMedia(COARSE_POINTER_QUERY);
  return coarsePointerQuery;
}

const subscribe = (onChange: () => void) => {
  const query = getCoarsePointerQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};

const getSnapshot = () => getCoarsePointerQuery()?.matches === true;

export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
