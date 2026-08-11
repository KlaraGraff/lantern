import type { SidePanel } from "./side-panel";

/**
 * The reader's four panels named as one set.
 *
 * A wide viewport docks two of them at the same time — the TOC or search on the
 * left, AI or traces on the right — which is why the reader keeps three
 * independent open flags rather than one. A phone has room for exactly one, and
 * this type exists solely so something can say *which* one.
 */
export type ReaderPanelId = "toc" | "search" | "traces" | "ai";

export interface ReaderPanelState {
  tocOpen: boolean;
  searchOpen: boolean;
  sidePanel: SidePanel;
}

/**
 * The single panel a narrow viewport shows over the page, or null for none.
 *
 * The reader enforces the exclusivity itself — opening any panel closes the
 * others while narrow — so at most one of these flags is ever set and the order
 * below is a tiebreaker that should not be reachable. It is written down anyway
 * because "should not" is not "cannot": React commits the closing state one
 * render after the opening one, and that in-between frame has to resolve to one
 * panel rather than two stacked on top of each other.
 */
export function narrowPanel(state: ReaderPanelState): ReaderPanelId | null {
  if (state.tocOpen) return "toc";
  if (state.searchOpen) return "search";
  return state.sidePanel;
}

/**
 * Whether a panel's shell should paint at all.
 *
 * On a wide viewport the answer is just "is it open" — two panels dock side by
 * side and neither hides the other. Narrow adds the second clause, and it is
 * the one worth writing down: every narrow shell is `absolute inset-0 z-50`, so
 * a panel that is open but is *not* the one `narrowPanel` picked would paint
 * over the winner, later in DOM order, wearing none of the ⟨ bar that the
 * winner gets. `narrowPanel` deciding the tiebreak is only half the invariant;
 * this is the half that makes the render obey it.
 */
export function panelShellVisible(open: boolean, narrow: boolean, covering: boolean): boolean {
  if (!open) return false;
  return !narrow || covering;
}

/**
 * Closing every panel is one operation, not three, because on a narrow screen
 * the reader only ever has one to close and cannot be asked to know which.
 */
export const ALL_PANELS_CLOSED: ReaderPanelState = {
  tocOpen: false,
  searchOpen: false,
  sidePanel: null,
};

/**
 * Whether a panel that just took over the screen should hand it back when the
 * reader picks something out of it.
 *
 * All four panels answer yes, and they answer it for the same reason: the point
 * of tapping a chapter, a search hit, a note or a cited passage is to look at
 * the page it names, and a panel covering the whole screen means the reader
 * cannot. On a wide viewport the panel is docked beside the page instead, the
 * destination is visible the moment it is chosen, and closing the panel would
 * throw away the list the reader is working through — so nothing closes there.
 *
 * Stated as a function of the layout rather than inlined at each call site so
 * that the four panels cannot drift apart on it.
 */
export function closesOnNavigate(narrow: boolean): boolean {
  return narrow;
}
