import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS,
  TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS,
  getParagraphTypographyCSS,
  isDropCapFirstLetter,
} from "../src/pages/reader/reader-typography.ts";

const settings: ReaderSettingsState = {
  theme: "paper", customTheme: { color: "#DDE8D8", opacity: 70 }, font: "palatino",
  fontSize: 26, narrowFontShrink: true, readingMode: "scrolling", pageColumns: 2,
  pageTurnAnimation: "slide", showChapterProgress: true, showBookProgress: false,
  showPageNumbers: false, previousPageBinding: "key:ArrowLeft", nextPageBinding: "key:ArrowRight",
  lineSpacing: 1.8, charSpacing: 0, wordSpacing: 0, textJustification: false,
  paragraphSpacing: "original", firstLineIndent: false, margins: 0,
  showLookupMarkers: true, showNewVocabMarkers: true, showLearningMarkers: true,
  showMasteredMarkers: false,
};

test("publisher paragraph styles are untouched until a typography enhancement is chosen", () => {
  const css = getParagraphTypographyCSS(settings);
  assert.doesNotMatch(css, /text-align: justify !important/);
  assert.doesNotMatch(css, /margin-bottom: 0\.85em !important/);
  assert.doesNotMatch(css, /text-indent: 1\.5em !important/);
});

test("typography enhancements target eligible paragraphs and exclude structural exceptions", () => {
  const css = getParagraphTypographyCSS({
    ...settings,
    textJustification: true,
    paragraphSpacing: "comfortable",
    firstLineIndent: true,
  });
  assert.match(css, /text-align: justify !important/);
  assert.match(css, /margin-bottom: 0\.85em !important/);
  assert.match(css, /p:not\(\s*blockquote p,\s*pre p,/);
  assert.match(css, /figure p/);
  assert.match(css, /center p/);
  assert.match(css, new RegExp(TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS));
  assert.match(css, new RegExp(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  assert.doesNotMatch(css, /:has\s*\(/);
  assert.match(css, /:lang\(zh\)/);
  assert.match(css, /text-indent: 2em !important/);
  assert.match(css, /hyphens: auto/);
  assert.match(css, /hyphens: manual/);
  assert.doesNotMatch(css, /:lang\(ru\)/);
});

test("first-line indent excludes the no-indent class from its own selector, not from justify/spacing", () => {
  const css = getParagraphTypographyCSS({
    ...settings,
    firstLineIndent: true,
    textJustification: true,
    paragraphSpacing: "comfortable",
  });
  // The base rule block (justify/spacing) is the first `{...}` in the
  // output; it must not exclude the no-indent class -- that exclusion is
  // specific to the indent rule that follows it.
  const justifyBlock = css.slice(0, css.indexOf("}") + 1);
  assert.match(justifyBlock, /text-align: justify !important/);
  assert.doesNotMatch(justifyBlock, new RegExp(`:not\\(\\.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS}\\)`));
  // The indent rule itself must be scoped to exclude it.
  assert.match(css, new RegExp(`:not\\(\\.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS}\\)[\\s\\S]*text-indent: 1\\.5em`));
});

test("justification always carries hyphenation, hard-bounded by the limit properties", () => {
  const css = getParagraphTypographyCSS({
    ...settings,
    textJustification: true,
  });
  assert.match(css, /text-align: justify !important/);
  // Both the prefixed (Safari 5.1+) and standard (recent WebKit) forms must
  // be present -- a future "redundant -webkit-" cleanup that dropped the
  // prefixed pair would silently widen hyphenation on older engines.
  assert.match(css, /-webkit-hyphens: auto; hyphens: auto;/);
  assert.match(css, /-webkit-hyphenate-limit-before: 5;/);
  assert.match(css, /-webkit-hyphenate-limit-after: 4;/);
  assert.match(css, /-webkit-hyphenate-limit-lines: 2;/);
  assert.match(css, /hyphenate-limit-chars: 10 5 4;/);
  assert.match(css, /hyphenate-limit-lines: 2;/);
});

test("CJK stays manual-hyphenation with none of the Latin limit properties", () => {
  const css = getParagraphTypographyCSS({ ...settings, textJustification: true });
  assert.match(css, /:lang\(zh\)[\s\S]*hyphens: manual/);
  // The CJK block is the last ":lang(zh)" rule in the output (the paragraph-
  // selector one that actually carries "hyphens: manual"); isolate just that
  // rule body so a leaked hyphenate-limit-* from the Latin branch would fail.
  const zhIndex = css.lastIndexOf(":lang(zh)");
  const cjkBlock = css.slice(zhIndex, css.indexOf("}", zhIndex) + 1);
  assert.match(cjkBlock, /hyphens: manual/);
  assert.doesNotMatch(cjkBlock, /hyphenate-limit/);
});

test("isDropCapFirstLetter detects a floated first letter regardless of size", () => {
  assert.equal(isDropCapFirstLetter("left", 16, 16), true);
});

test("isDropCapFirstLetter detects a large non-floated first letter", () => {
  assert.equal(isDropCapFirstLetter("none", 56, 16), true); // 3.5em drop cap
  assert.equal(isDropCapFirstLetter("none", 17, 16), false); // ordinary emphasis
});

test("isDropCapFirstLetter guards against a zero paragraph font size", () => {
  assert.equal(isDropCapFirstLetter("none", 56, 0), false);
});
