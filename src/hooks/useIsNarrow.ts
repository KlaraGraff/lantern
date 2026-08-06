import { useSyncExternalStore } from "react";

/**
 * Tailwind's `md:` is `min-width: 48rem`, so this asks the same question the
 * stylesheet asks and the two can never disagree about where the layout flips.
 */
const DESKTOP_QUERY = "(min-width: 48rem)";

let desktopQuery: MediaQueryList | null = null;
function getDesktopQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  desktopQuery ??= window.matchMedia(DESKTOP_QUERY);
  return desktopQuery;
}

const subscribeToWidth = (onChange: () => void) => {
  const query = getDesktopQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};

/**
 * The same answer without subscribing, for the one-shot reads: an initial
 * `useState`, or an effect that must not re-run when the window is dragged
 * across the breakpoint.
 */
export const isNarrowNow = () => getDesktopQuery()?.matches === false;

/**
 * Its first consumer, and the reason this is a hook rather than a `hidden md:`
 * pair: which container the sidebar lives in is a JavaScript decision, because
 * the two containers hold the *same* component and only one of them may be
 * mounted: two copies would mean two copies of its rename/create/drag state,
 * and a right-click menu that opens in the invisible one. It also makes the
 * desktop guarantee literal — above `md:` none of the drawer's nodes exist at
 * all, rather than existing and being hidden.
 */
export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribeToWidth, isNarrowNow, () => false);
}
