/**
 * Click-cycle modes for the bottom-right progress readout (P1.5). Persisted
 * per book, the same way `toc-state.ts` persists TOC UI state — see
 * `progressReadoutSettingKey` below and its use with `getBookSettings`/
 * `set_book_settings_bulk` in `Reader.tsx`.
 */
export type ProgressReadoutMode = "page" | "chapterTime" | "bookTime" | "hidden";

/** Click order: page number → chapter time left → book time left → hidden → (loops). */
export const PROGRESS_READOUT_MODES: readonly ProgressReadoutMode[] = [
  "page",
  "chapterTime",
  "bookTime",
  "hidden",
];

export const progressReadoutSettingKey = "progress_readout_mode";

/** Falls back to the default ("page") for anything unrecognized, including
 * `undefined` from a book with no saved preference yet. */
export function parseProgressReadoutMode(value: string | undefined): ProgressReadoutMode {
  return (PROGRESS_READOUT_MODES as readonly string[]).includes(value ?? "")
    ? (value as ProgressReadoutMode)
    : "page";
}

/**
 * Which mode a book with no saved preference starts in. The three global
 * "progress display" toggles keep their authority over the new click-cycle:
 * with all of them off the reader asked for no progress metrics at all, so the
 * readout starts hidden. It stays clickable, so one click brings it back
 * without a trip to settings.
 */
export function defaultProgressReadoutMode(metrics: {
  showChapterProgress: boolean;
  showBookProgress: boolean;
  showPageNumbers: boolean;
}): ProgressReadoutMode {
  return metrics.showChapterProgress || metrics.showBookProgress || metrics.showPageNumbers
    ? "page"
    : "hidden";
}

export function nextProgressReadoutMode(mode: ProgressReadoutMode): ProgressReadoutMode {
  const index = PROGRESS_READOUT_MODES.indexOf(mode);
  return PROGRESS_READOUT_MODES[(index + 1) % PROGRESS_READOUT_MODES.length];
}
