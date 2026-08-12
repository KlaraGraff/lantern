/**
 * Pure decision logic for the one-time tap-zone guide overlay, kept free of
 * React and Tauri for the same reason as `onboarding-state.ts`: the repo's
 * unit tests run under plain `node:test` with no component harness, so
 * anything worth a test has to be extractable like this.
 */

/** A single settings key, `"true"` once the guide has been shown and
 * dismissed. Any other value (including absent) means "still owed." Same
 * shape as `auto_analysis_intro_shown`: said once, never again. */
export const ZONE_GUIDE_SHOWN_KEY = "reader_zone_guide_shown";

export interface ZoneGuideConditions {
  /** Below the reader breakpoint — the only place tap zones exist. */
  narrow: boolean;
  /** The reader's resolved reading mode for the open book. */
  readingMode: string;
  /** The book has actually rendered; a guide over a spinner teaches nothing. */
  bookReady: boolean;
  /** The stored `ZONE_GUIDE_SHOWN_KEY` value — `undefined` when the row does
   * not exist yet. Callers that have not finished loading settings should
   * pass `"true"`: better to miss one frame of guide than to flash it at
   * someone who dismissed it weeks ago. */
  shownFlag: string | undefined;
}

/**
 * Whether the tap-zone guide still needs showing.
 *
 * Paginated only, deliberately: the guide's outer columns teach tap-to-turn,
 * which scrolled mode does not have. Someone who reads scrolled and later
 * switches to paginated meets the guide at that switch — their first real
 * encounter with the zones — rather than on a screen where two of its three
 * columns would be false.
 */
export function shouldShowZoneGuide({
  narrow,
  readingMode,
  bookReady,
  shownFlag,
}: ZoneGuideConditions): boolean {
  return (
    narrow
    && bookReady
    && readingMode === "paginated"
    && shownFlag !== "true"
  );
}
