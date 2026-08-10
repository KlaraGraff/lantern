import type { TocChapter } from "./foliate-types";

/**
 * The top bar's "chapter N of M" readout.
 *
 * The count follows the table of contents, not the spine: an EPUB's spine is a
 * list of XHTML files, and a book's front and back matter (titlepage, imprint,
 * endnotes, colophon, ...) are spine items and TOC entries just like chapters
 * are. Counting those makes the total disagree with the chapter numbers printed
 * in the book — Standard Ebooks' *Pride and Prejudice* has 61 chapters but 65
 * TOC entries, so chapter II used to read "chapter 4 of 65".
 *
 * EPUB already says which is which: `<body epub:type="frontmatter">` /
 * `bodymatter` / `backmatter`, plus the `landmarks` nav (or the EPUB 2 `guide`)
 * pointing at where the body starts. `bodyMatterRange` turns that evidence into
 * a span of spine sections; `chapterReadout` counts only the TOC entries inside
 * it. Books that carry none of it keep the old behaviour — every TOC entry
 * counts — because a wrong-looking count beats no count at all.
 */

export type SectionMatter = "frontmatter" | "bodymatter" | "backmatter";

/** Inclusive span of raw Foliate section indices holding the book's body. */
export interface BodyMatterRange {
  first: number;
  last: number;
}

export interface ChapterReadout {
  current: number;
  total: number;
}

const MATTER_TOKENS: readonly SectionMatter[] = ["frontmatter", "bodymatter", "backmatter"];

/**
 * `epub:type` values naming a page that is never a chapter, whichever end of the
 * spine it sits at. Books that label their sections structurally without also
 * saying `frontmatter` / `backmatter` are common enough that missing them costs
 * the whole trim: the walk stops at the first unclassified section, so a leading
 * `epub:type="cover"` alone leaves the count unchanged.
 *
 * Deliberately limited to pages with no readable body — no `preface`,
 * `foreword`, `prologue` or `introduction`. Those are arguably chapters, and a
 * book that considers them front matter can say so itself.
 */
const NON_CHAPTER_TOKENS: ReadonlySet<string> = new Set([
  "cover",
  "titlepage",
  "halftitlepage",
  "frontispiece",
  "toc",
  "landmarks",
  "imprint",
  "copyright-page",
  "colophon",
]);

/**
 * Reads the matter classification out of a raw `epub:type` attribute value.
 *
 * `end` says which end of the spine the section was probed from, which is what
 * lets a structural page type stand in for a missing `frontmatter` /
 * `backmatter`: a titlepage found while walking in from the front is front
 * matter. An explicit matter token always wins over it.
 */
export function parseSectionMatter(
  epubType: string | null | undefined,
  end?: "front" | "back",
): SectionMatter | undefined {
  if (!epubType) return undefined;
  const tokens = new Set(epubType.split(/\s+/u).filter(Boolean));
  const declared = MATTER_TOKENS.find((token) => tokens.has(token));
  if (declared) return declared;
  if (!end) return undefined;
  return [...tokens].some((token) => NON_CHAPTER_TOKENS.has(token))
    ? (end === "front" ? "frontmatter" : "backmatter")
    : undefined;
}

/**
 * How far into either end of the spine front or back matter can plausibly
 * reach — the caller's probe budget, and the point past which a `bodymatter`
 * landmark stops being believable. A landmark 40 sections in is not describing
 * a titlepage-and-imprint run; trimming to it would blank the readout across
 * most of the book.
 */
export const MAX_MATTER_SECTIONS = 12;

/**
 * Narrows the spine to the run of body-matter sections.
 *
 * `matter` only has to describe the sections actually probed — the caller walks
 * inward from each end and stops as soon as a section is not front/back matter,
 * which is where the body starts. `landmarkBodyStart` is the section the
 * `bodymatter` landmark points at; it can only push the start later, never
 * earlier, so a book that marks its front matter one way and not the other
 * still gets trimmed.
 *
 * The two ends are not symmetric: the front has both signals, the back only has
 * `<body epub:type>` (no landmark marks where back matter begins) and only as
 * far as the caller probed. A book trailing more back matter than that keeps
 * counting the remainder, which overshoots the true chapter count rather than
 * undershooting it — the same direction as the old whole-TOC behaviour.
 *
 * Returns `null` when the evidence trims nothing (or everything), which tells
 * the caller to fall back to counting the whole TOC.
 */
export function bodyMatterRange(input: {
  sectionCount: number;
  matter?: ReadonlyMap<number, SectionMatter>;
  landmarkBodyStart?: number;
}): BodyMatterRange | null {
  const { sectionCount, matter, landmarkBodyStart } = input;
  if (!Number.isInteger(sectionCount) || sectionCount <= 0) return null;

  let first = 0;
  while (first < sectionCount && matter?.get(first) === "frontmatter") first += 1;
  if (typeof landmarkBodyStart === "number"
    && Number.isInteger(landmarkBodyStart)
    && landmarkBodyStart > first
    && landmarkBodyStart < sectionCount
    && landmarkBodyStart <= MAX_MATTER_SECTIONS) {
    first = landmarkBodyStart;
  }

  let last = sectionCount - 1;
  while (last >= first && matter?.get(last) === "backmatter") last -= 1;

  // Everything is front or back matter: the book declares no body at all, so
  // the classification is not trustworthy enough to hide the readout.
  if (last < first) return null;
  if (first === 0 && last === sectionCount - 1) return null;
  return { first, last };
}

/** True when this TOC entry is known to sit outside the body matter. */
function outsideBody(chapter: TocChapter | undefined, range: BodyMatterRange): boolean {
  const section = chapter?.sectionIndex;
  // An unresolved target is not evidence of anything — keep it counted rather
  // than silently dropping a chapter whose href we failed to resolve.
  if (section === undefined) return false;
  return section < range.first || section > range.last;
}

/**
 * Indices into `chapters` of the entries that count as one chapter each: the
 * leaves of the TOC tree (a parent with children is a container, not a reading
 * unit), minus anything the body-matter range excludes.
 */
function selectReadingUnits(
  chapters: readonly TocChapter[],
  range?: BodyMatterRange | null,
): { units: number[]; applied: BodyMatterRange | null } {
  const leaves = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter, index }) => (
      chapters[index + 1]?.depth <= chapter.depth || index === chapters.length - 1
    ))
    .map(({ index }) => index);
  if (!range) return { units: leaves, applied: null };
  const inBody = leaves.filter((index) => !outsideBody(chapters[index], range));
  // A TOC whose entries all fall outside the detected body means the two
  // disagree; trust the TOC and drop the range entirely.
  return inBody.length > 0
    ? { units: inBody, applied: range }
    : { units: leaves, applied: null };
}

export function readingUnitIndices(
  chapters: readonly TocChapter[],
  range?: BodyMatterRange | null,
): number[] {
  return selectReadingUnits(chapters, range).units;
}

export function chapterReadout(
  chapters: readonly TocChapter[],
  currentChapterIndex: number,
  range?: BodyMatterRange | null,
): ChapterReadout | null {
  const { units, applied } = selectReadingUnits(chapters, range);
  if (units.length === 0) return null;
  const currentIndex = Math.max(0, currentChapterIndex);
  // Standing on the titlepage or the colophon is not "chapter 1" or "chapter
  // 61". Say nothing rather than name a chapter the reader is not in.
  if (applied && outsideBody(chapters[currentIndex], applied)) return null;
  const position = units.findIndex((index) => index >= currentIndex);
  return {
    current: (position < 0 ? units.length - 1 : position) + 1,
    total: units.length,
  };
}
