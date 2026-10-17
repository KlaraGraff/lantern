import type { CSSProperties } from "react";

/**
 * The cover → reader transition (design v2 §6: 「封面长成阅读页」, 260ms,
 * `view-transition-name: book`). `BrowserRouter` has no view-transition
 * support of its own — React Router only offers it on data routers — so the
 * transition is started here and told by the reader route when its first
 * frame has committed.
 */
export const BOOK_TRANSITION_NAME = "book";

/** Worn by whatever the reader route paints first: the lazy-chunk fallback, then its loading screen. */
export const BOOK_TRANSITION_TARGET: CSSProperties = { viewTransitionName: BOOK_TRANSITION_NAME };

let namedCover: HTMLElement | null = null;
let routeCommitted: (() => void) | null = null;

/**
 * Marks the cover the next transition grows out of. Only one element may carry
 * the name at a time — two abort the transition — so naming one clears the last.
 */
export function nameBookCover(cover: HTMLElement | null): void {
  if (namedCover && namedCover !== cover) namedCover.style.viewTransitionName = "";
  namedCover = cover;
  if (cover) cover.style.viewTransitionName = BOOK_TRANSITION_NAME;
}

type TransitionDocument = Document & {
  startViewTransition?: (update: () => Promise<void>) => {
    ready: Promise<void>;
    finished: Promise<void>;
    updateCallbackDone: Promise<void>;
  };
};

/**
 * Runs a navigation into the reader as a view transition where the webview has
 * them, and as a plain navigation where it does not.
 */
export function transitionIntoReader(navigate: () => void): void {
  const doc = document as TransitionDocument;
  // A hidden document aborts every transition, so there is nothing to animate.
  if (typeof doc.startViewTransition !== "function" || doc.hidden) {
    nameBookCover(null);
    navigate();
    return;
  }
  const transition = doc.startViewTransition(() => new Promise<void>((resolve) => {
    routeCommitted = resolve;
    navigate();
    // The page is frozen until this resolves. A route that never reports in
    // must not leave it that way.
    window.setTimeout(resolve, 400);
  }));
  // A skipped transition (the window hidden mid-way, a second one started)
  // rejects all three promises. The navigation has happened regardless.
  transition.ready.catch(() => {});
  transition.updateCallbackDone.catch(() => {});
  transition.finished.catch(() => {}).finally(() => {
    routeCommitted = null;
    nameBookCover(null);
  });
}

/** Called from a layout effect on the reader route's first commit. */
export function readerRouteCommitted(): void {
  routeCommitted?.();
  routeCommitted = null;
}
