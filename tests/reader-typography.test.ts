import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  getParagraphTypographyCSS,
  TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS,
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
  assert.doesNotMatch(css, /:has\s*\(/);
  assert.match(css, /:lang\(zh\)/);
  assert.match(css, /text-indent: 2em !important/);
  assert.match(css, /hyphens: auto/);
  assert.match(css, /hyphens: manual/);
  assert.doesNotMatch(css, /:lang\(ru\)/);
});
