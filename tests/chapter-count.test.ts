import assert from "node:assert/strict";
import test from "node:test";

import {
  bodyMatterRange,
  chapterReadout,
  MAX_MATTER_SECTIONS,
  parseSectionMatter,
  readingUnitIndices,
  type SectionMatter,
} from "../src/pages/reader/chapter-count.ts";
import type { TocChapter } from "../src/pages/reader/foliate-types.ts";

const flat = (titles: readonly string[], startSection = 0): TocChapter[] =>
  titles.map((title, index) => ({
    title,
    href: `${title}.xhtml`,
    targetHref: `${title}.xhtml`,
    depth: 0,
    sectionIndex: startSection + index,
  }));

/**
 * Standard Ebooks' *Pride and Prejudice*: 65 spine sections and 65 flat TOC
 * entries — titlepage, imprint, 61 roman-numbered chapters, colophon,
 * uncopyright. The book prints 61 chapters, so that is what the top bar has to
 * say.
 */
const PRIDE_AND_PREJUDICE: TocChapter[] = flat([
  "titlepage",
  "imprint",
  ...Array.from({ length: 61 }, (_, i) => `chapter-${i + 1}`),
  "colophon",
  "uncopyright",
]);

const PRIDE_AND_PREJUDICE_MATTER = new Map<number, SectionMatter>([
  [0, "frontmatter"],
  [1, "frontmatter"],
  [63, "backmatter"],
  [64, "backmatter"],
]);

const prideRange = () => bodyMatterRange({
  sectionCount: 65,
  matter: PRIDE_AND_PREJUDICE_MATTER,
  landmarkBodyStart: 2,
});

test("parseSectionMatter reads the matter token out of a multi-token epub:type", () => {
  assert.equal(parseSectionMatter("bodymatter z3998:fiction"), "bodymatter");
  assert.equal(parseSectionMatter("frontmatter"), "frontmatter");
  assert.equal(parseSectionMatter("backmatter"), "backmatter");
  assert.equal(parseSectionMatter("z3998:roman"), undefined);
  assert.equal(parseSectionMatter(""), undefined);
  assert.equal(parseSectionMatter(null), undefined);
});

test("a structural page type stands in for a missing frontmatter/backmatter", () => {
  // The gap this closes: a book that says only `epub:type="cover"` on its first
  // section used to stop the walk at section 0 and lose the whole trim.
  assert.equal(parseSectionMatter("cover", "front"), "frontmatter");
  assert.equal(parseSectionMatter("titlepage", "front"), "frontmatter");
  assert.equal(parseSectionMatter("colophon", "back"), "backmatter");
  assert.equal(parseSectionMatter("copyright-page", "back"), "backmatter");
  // The end decides, because the same page type can only be at one end anyway.
  assert.equal(parseSectionMatter("toc", "back"), "backmatter");
  // Without an end there is nothing to stand in for.
  assert.equal(parseSectionMatter("cover"), undefined);
});

test("an explicit matter token beats the structural page type", () => {
  // A `toc` the book itself calls bodymatter is the book's call, not ours.
  assert.equal(parseSectionMatter("bodymatter toc", "front"), "bodymatter");
  assert.equal(parseSectionMatter("backmatter colophon", "front"), "backmatter");
});

test("readable front matter is left to the book to classify", () => {
  // A preface or a prologue is arguably a chapter; a book that disagrees can
  // say `frontmatter` itself.
  assert.equal(parseSectionMatter("preface", "front"), undefined);
  assert.equal(parseSectionMatter("foreword", "front"), undefined);
  assert.equal(parseSectionMatter("prologue", "front"), undefined);
  assert.equal(parseSectionMatter("epilogue", "back"), undefined);
});

test("bodyMatterRange trims the front and back matter off the spine", () => {
  assert.deepEqual(prideRange(), { first: 2, last: 62 });
});

test("the landmarks nav alone can move the body start", () => {
  // A book that marks nothing on <body> but does point `bodymatter` at the
  // first chapter.
  assert.deepEqual(
    bodyMatterRange({ sectionCount: 10, landmarkBodyStart: 3 }),
    { first: 3, last: 9 },
  );
});

test("the landmarks nav never pulls the body start earlier than epub:type does", () => {
  // A stale or lazy landmark pointing at the imprint must not undo the trim
  // the section types already earned.
  assert.deepEqual(
    bodyMatterRange({
      sectionCount: 10,
      matter: new Map<number, SectionMatter>([[0, "frontmatter"], [1, "frontmatter"]]),
      landmarkBodyStart: 1,
    }),
    { first: 2, last: 9 },
  );
});

test("a bodymatter landmark deep into the spine is not believed", () => {
  // Front matter is a handful of files. A landmark pointing 40 sections in is
  // describing something else; trimming to it would blank the readout for
  // almost the whole book instead of counting it slightly wrong.
  assert.equal(
    bodyMatterRange({ sectionCount: 60, landmarkBodyStart: 40 }),
    null,
  );
  assert.deepEqual(
    bodyMatterRange({ sectionCount: 60, landmarkBodyStart: MAX_MATTER_SECTIONS }),
    { first: MAX_MATTER_SECTIONS, last: 59 },
  );
});

test("a book labelled only with structural page types still gets trimmed", () => {
  // End to end over the shape the probe produces: sections carrying no
  // frontmatter/backmatter token at all, only `cover` / `titlepage` /
  // `colophon`. Before the structural fallback the front walk stopped at
  // section 0 and the whole trim was lost.
  const declared = ["cover", "titlepage", "", "", "", "colophon"];
  const matter = new Map<number, SectionMatter>();
  for (let index = 0; index < declared.length; index += 1) {
    const kind = parseSectionMatter(declared[index], "front");
    if (kind !== "frontmatter") break;
    matter.set(index, kind);
  }
  for (let step = 0; step < declared.length; step += 1) {
    const index = declared.length - 1 - step;
    const kind = parseSectionMatter(declared[index], "back");
    if (kind !== "backmatter" || matter.has(index)) break;
    matter.set(index, kind);
  }
  const range = bodyMatterRange({ sectionCount: declared.length, matter });
  assert.deepEqual(range, { first: 2, last: 4 });

  const chapters = flat(["Cover", "Titlepage", "I", "II", "III", "Colophon"]);
  assert.deepEqual(chapterReadout(chapters, 3, range), { current: 2, total: 3 });
  assert.equal(chapterReadout(chapters, 5, range), null);
});

test("bodyMatterRange declines when the book says nothing", () => {
  assert.equal(bodyMatterRange({ sectionCount: 12 }), null);
  assert.equal(bodyMatterRange({ sectionCount: 0, landmarkBodyStart: 0 }), null);
});

test("bodyMatterRange declines when every section claims to be front or back matter", () => {
  const matter = new Map<number, SectionMatter>([
    [0, "frontmatter"],
    [1, "frontmatter"],
    [2, "backmatter"],
  ]);
  assert.equal(bodyMatterRange({ sectionCount: 3, matter }), null);
});

test("Pride and Prejudice counts 61 chapters, not 65 TOC entries", () => {
  const range = prideRange();
  assert.equal(readingUnitIndices(PRIDE_AND_PREJUDICE, range).length, 61);
});

test("chapter II reads as chapter 2 of 61", () => {
  // TOC index 3 is chapter-2.xhtml: titlepage, imprint, I, II.
  assert.deepEqual(
    chapterReadout(PRIDE_AND_PREJUDICE, 3, prideRange()),
    { current: 2, total: 61 },
  );
});

test("chapter XXI reads as chapter 21 of 61", () => {
  assert.deepEqual(
    chapterReadout(PRIDE_AND_PREJUDICE, 22, prideRange()),
    { current: 21, total: 61 },
  );
});

test("the last chapter reads as chapter 61 of 61", () => {
  assert.deepEqual(
    chapterReadout(PRIDE_AND_PREJUDICE, 62, prideRange()),
    { current: 61, total: 61 },
  );
});

test("standing on front or back matter names no chapter at all", () => {
  const range = prideRange();
  // The titlepage is not chapter 1 and the colophon is not chapter 61; saying
  // either would be a worse lie than saying nothing.
  assert.equal(chapterReadout(PRIDE_AND_PREJUDICE, 0, range), null);
  assert.equal(chapterReadout(PRIDE_AND_PREJUDICE, 1, range), null);
  assert.equal(chapterReadout(PRIDE_AND_PREJUDICE, 63, range), null);
  assert.equal(chapterReadout(PRIDE_AND_PREJUDICE, 64, range), null);
});

test("a book with no matter information keeps the old whole-TOC count", () => {
  assert.deepEqual(
    chapterReadout(PRIDE_AND_PREJUDICE, 3, null),
    { current: 4, total: 65 },
  );
});

test("an unopened book reports nothing", () => {
  assert.equal(chapterReadout([], -1, null), null);
});

test("a TOC entry whose href never resolved still counts", () => {
  // Resolution failure is not evidence that the entry is front matter; dropping
  // it would silently shrink the book.
  const chapters: TocChapter[] = [
    { title: "titlepage", depth: 0, sectionIndex: 0 },
    { title: "I", depth: 0, sectionIndex: 1 },
    { title: "II", depth: 0, targetHref: "broken.xhtml" },
    { title: "III", depth: 0, sectionIndex: 3 },
  ];
  const range = bodyMatterRange({
    sectionCount: 4,
    matter: new Map<number, SectionMatter>([[0, "frontmatter"]]),
  });
  assert.deepEqual(chapterReadout(chapters, 1, range), { current: 1, total: 3 });
});

test("a TOC that lies entirely outside the detected body wins over the detection", () => {
  // Nothing resolvable inside the range means the two disagree; the TOC is the
  // thing the reader can see, so it is the one to trust.
  const chapters = flat(["I", "II", "III"], 10);
  assert.deepEqual(
    chapterReadout(chapters, 1, { first: 0, last: 5 }),
    { current: 2, total: 3 },
  );
});

test("nested TOC sections stay inside their parent chapter", () => {
  const chapters: TocChapter[] = [
    { title: "Titlepage", depth: 0, sectionIndex: 0 },
    { title: "Part One", depth: 0, sectionIndex: 1 },
    { title: "Chapter 1", depth: 1, sectionIndex: 1 },
    { title: "Chapter 2", depth: 1, sectionIndex: 2 },
    { title: "Colophon", depth: 0, sectionIndex: 3 },
  ];
  const range = bodyMatterRange({
    sectionCount: 4,
    matter: new Map<number, SectionMatter>([[0, "frontmatter"], [3, "backmatter"]]),
  });
  // "Part One" is a container, not a reading unit — only its two leaves count.
  assert.deepEqual(readingUnitIndices(chapters, range), [2, 3]);
  assert.deepEqual(chapterReadout(chapters, 3, range), { current: 2, total: 2 });
});
