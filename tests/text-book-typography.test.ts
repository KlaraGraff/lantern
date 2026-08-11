import assert from "node:assert/strict";
import test from "node:test";

import type { ParagraphSpacing } from "../src/components/ReaderSettings";
import {
  getTextBookParagraphStyle,
  isCjkText,
  type TextBookParagraphSettings,
} from "../src/components/text-book-typography.ts";

function settingsWith(overrides: Partial<TextBookParagraphSettings> = {}): TextBookParagraphSettings {
  return {
    textJustification: false,
    paragraphSpacing: "original" as ParagraphSpacing,
    firstLineIndent: false,
    ...overrides,
  };
}

test("isCjkText recognizes CJK scripts and rejects Latin text", () => {
  assert.equal(isCjkText("这是一段中文。"), true);
  assert.equal(isCjkText("これは日本語です"), true);
  assert.equal(isCjkText("이것은 한국어입니다"), true);
  assert.equal(isCjkText("This is plain English."), false);
});

test("first-line indent uses the Latin measure for non-CJK paragraphs", () => {
  const style = getTextBookParagraphStyle(settingsWith({ firstLineIndent: true }), {
    isCjk: false,
    noIndent: false,
  });
  assert.equal(style.textIndent, "1.5em");
});

test("first-line indent uses the wider CJK measure for CJK paragraphs", () => {
  const style = getTextBookParagraphStyle(settingsWith({ firstLineIndent: true }), {
    isCjk: true,
    noIndent: false,
  });
  assert.equal(style.textIndent, "2em");
});

test("the chapter-opening paragraph (or one right after a heading) never indents", () => {
  const style = getTextBookParagraphStyle(settingsWith({ firstLineIndent: true }), {
    isCjk: false,
    noIndent: true,
  });
  assert.equal(style.textIndent, undefined);
});

test("noIndent only suppresses the indent -- justification and spacing are untouched", () => {
  const style = getTextBookParagraphStyle(
    settingsWith({ firstLineIndent: true, textJustification: true, paragraphSpacing: "comfortable" }),
    { isCjk: false, noIndent: true },
  );
  assert.equal(style.textIndent, undefined);
  assert.equal(style.textAlign, "justify");
  assert.equal(style.marginBottom, "0.85em");
});

test("CJK paragraphs stay on manual hyphenation even when justification is on", () => {
  const style = getTextBookParagraphStyle(settingsWith({ textJustification: true }), {
    isCjk: true,
    noIndent: false,
  });
  assert.equal(style.hyphens, "manual");
  assert.equal(style.WebkitHyphens, "manual");
  assert.equal((style as Record<string, unknown>).hyphenateLimitChars, undefined);
});

test("non-CJK justified paragraphs get auto hyphenation bounded by the limit properties", () => {
  const style = getTextBookParagraphStyle(settingsWith({ textJustification: true }), {
    isCjk: false,
    noIndent: false,
  });
  const vendorStyle = style as Record<string, unknown>;
  assert.equal(style.hyphens, "auto");
  assert.equal(style.WebkitHyphens, "auto");
  // Strings, not numbers: React appends `px` to numeric style values outside
  // its `unitlessNumbers` list, which has no `hyphenate*` entry, and CSSOM then
  // drops `-webkit-hyphenate-limit-before: 3px` — leaving `hyphens: auto`
  // running with no minimum at all.
  assert.equal(vendorStyle.WebkitHyphenateLimitBefore, "3");
  assert.equal(vendorStyle.WebkitHyphenateLimitAfter, "3");
  assert.equal(vendorStyle.WebkitHyphenateLimitLines, "2");
  assert.equal(vendorStyle.hyphenateLimitChars, "6 3 3");
  assert.equal(vendorStyle.hyphenateLimitLines, "2");
});

test("text-wrap: pretty rides with justification, in both scripts, and never without it", () => {
  // Same rule as the EPUB reader (see reader-typography.test.ts) — the two
  // readers must not disagree about how a justified paragraph is set.
  for (const isCjk of [false, true]) {
    const on = getTextBookParagraphStyle(settingsWith({ textJustification: true }), { isCjk, noIndent: false });
    assert.equal(on.textWrap, "pretty");
  }
  assert.equal(getTextBookParagraphStyle(settingsWith(), { isCjk: false, noIndent: false }).textWrap, undefined);
});

test("hyphenation stays off entirely when justification is off", () => {
  const style = getTextBookParagraphStyle(settingsWith(), { isCjk: false, noIndent: false });
  assert.equal(style.hyphens, undefined);
  assert.equal(style.WebkitHyphens, undefined);
});

test("paragraphSpacing 'original' produces no marginBottom override", () => {
  const style = getTextBookParagraphStyle(settingsWith({ paragraphSpacing: "original" }), {
    isCjk: false,
    noIndent: false,
  });
  assert.equal(style.marginBottom, undefined);
});

test("every non-original paragraphSpacing value maps to a concrete gap", () => {
  const cases: Array<[ParagraphSpacing, string]> = [
    ["none", "0"],
    ["compact", "0.45em"],
    ["comfortable", "0.85em"],
    ["loose", "1.25em"],
  ];
  for (const [paragraphSpacing, expected] of cases) {
    const style = getTextBookParagraphStyle(settingsWith({ paragraphSpacing }), {
      isCjk: false,
      noIndent: false,
    });
    assert.equal(style.marginBottom, expected);
  }
});
