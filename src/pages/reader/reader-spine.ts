/**
 * The 3px spine down the reader's left edge (design §11, 「书脊」): one segment
 * per top-level chapter, sized by where the chapter starts in the book, and
 * filled by how far into the book the reader is.
 *
 * Filled from book progress, not reading history: a chapter behind the reader
 * counts as reached. Where a format gives no section fractions, the spine is a
 * single segment for the whole book.
 */
export interface SpineChapter {
  title: string;
  depth: number;
  sectionIndex?: number;
}

export interface SpineSegment {
  /** Where the segment starts and ends, as fractions of the whole book. */
  start: number;
  end: number;
  /** 0–1: how much of the segment the reader has passed. */
  fill: number;
  current: boolean;
  /** The chapter's title, or empty for the single whole-book segment. */
  title: string;
}

/** Below this, a chapter would be a hairline the eye cannot separate from its neighbours. */
const MIN_SEGMENT = 0.004;

export function spineSegments(
  chapters: readonly SpineChapter[],
  sectionFractions: readonly number[],
  /** Book progress, 0–100, as the reader keeps it. */
  progress: number,
): SpineSegment[] {
  const at = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress / 100 : 0));
  const starts: { start: number; title: string }[] = [];
  for (const chapter of chapters) {
    if (chapter.depth !== 0 || chapter.sectionIndex === undefined) continue;
    const start = sectionFractions[chapter.sectionIndex];
    if (!Number.isFinite(start) || start < 0 || start >= 1) continue;
    const previous = starts[starts.length - 1];
    // Out of order or too close to the last: the TOC and the spine disagree
    // about order, or two entries share a section. Keep the first.
    if (previous && start - previous.start < MIN_SEGMENT) continue;
    starts.push({ start, title: chapter.title });
  }
  if (starts.length === 0) {
    return [{ start: 0, end: 1, fill: at, current: true, title: "" }];
  }
  // Front matter before the first chapter belongs to it.
  starts[0] = { ...starts[0], start: 0 };
  return starts.map(({ start, title }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].start : 1;
    const fill = Math.round(Math.min(1, Math.max(0, (at - start) / (end - start))) * 1000) / 1000;
    const current = at >= start && (at < end || (end === 1 && at === 1));
    return { start, end, fill, current, title };
  });
}
