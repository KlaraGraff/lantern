/**
 * Pure fraction/tick math for the P1.6 scrubber. Kept separate from
 * `ProgressScrubber.tsx` so the positioning logic can be unit tested without
 * mounting a component or touching a pointer event.
 */

export interface ScrubberTick {
  /** 0-1 position along the whole book. */
  fraction: number;
  label: string;
}

export interface ChapterForTicks {
  title: string;
  /** Raw Foliate section index this chapter starts at — chapters without one
   * (disabled TOC entries) are skipped. */
  sectionIndex?: number;
}

/**
 * Converts TOC chapters into scrubber tick marks using `view.getSectionFractions()`
 * (per-raw-section start fraction). A chapter with no `sectionIndex`, or whose
 * index has no corresponding fraction, is dropped rather than mis-plotted.
 */
export function chaptersToTicks(
  chapters: readonly ChapterForTicks[],
  sectionFractions: readonly number[],
): ScrubberTick[] {
  const ticks: ScrubberTick[] = [];
  for (const chapter of chapters) {
    if (chapter.sectionIndex === undefined) continue;
    const fraction = sectionFractions[chapter.sectionIndex];
    if (!Number.isFinite(fraction)) continue;
    ticks.push({ fraction, label: chapter.title });
  }
  return ticks.sort((a, b) => a.fraction - b.fraction);
}

export function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(1, Math.max(0, fraction));
}

/** Maps a pointer's clientX to a 0-1 fraction of the track's bounding rect. */
export function fractionFromPointerX(
  clientX: number,
  rect: { left: number; width: number },
): number {
  if (rect.width <= 0) return 0;
  return clampFraction((clientX - rect.left) / rect.width);
}

/** The tick at or immediately before `fraction` — the chapter currently under
 * the cursor/thumb. Falls back to the first tick before any chapter starts. */
export function chapterAtFraction(
  ticks: readonly ScrubberTick[],
  fraction: number,
): ScrubberTick | undefined {
  let current: ScrubberTick | undefined;
  for (const tick of ticks) {
    if (tick.fraction > fraction) break;
    current = tick;
  }
  return current ?? ticks[0];
}
