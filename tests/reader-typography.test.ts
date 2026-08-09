import assert from "node:assert/strict";
import test from "node:test";

import type { ReaderSettingsState } from "../src/components/ReaderSettings";
import {
  TYPOGRAPHY_BLANK_BLOCK_CLASS,
  TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS,
  TYPOGRAPHY_HANGING_INDENT_CLASS,
  TYPOGRAPHY_INLINE_DIV_CLASS,
  TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS,
  TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS,
  TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS,
  TYPOGRAPHY_STRUCTURAL_CLASS,
  getParagraphTypographyCSS,
  isDropCapFirstLetter,
  isPublisherAlignedValue,
  markTypographyIndentExceptions,
  stampPublisherTypography,
} from "../src/pages/reader/reader-typography.ts";

const settings: ReaderSettingsState = {
  theme: "paper", customTheme: { color: "#DDE8D8", opacity: 70 }, font: "palatino",
  cjkFont: "system",
  fontSize: 26, narrowFontShrink: true, readingMode: "scrolling", pageColumns: 2,
  pageTurnAnimation: "slide", showChapterProgress: true, showBookProgress: false,
  showPageNumbers: false, previousPageBinding: "key:ArrowLeft", nextPageBinding: "key:ArrowRight",
  lineSpacing: 1.8, charSpacing: 0, wordSpacing: 0, textJustification: false,
  paragraphSpacing: "original", firstLineIndent: false, margins: 0,
  showLookupMarkers: true, showNewVocabMarkers: true, showLearningMarkers: true,
};

const enabled = {
  ...settings,
  textJustification: true,
  paragraphSpacing: "comfortable",
  firstLineIndent: true,
} satisfies ReaderSettingsState;

test("publisher paragraph styles are untouched until a typography enhancement is chosen", () => {
  const css = getParagraphTypographyCSS(settings);
  assert.doesNotMatch(css, /text-align: justify !important/);
  assert.doesNotMatch(css, /margin-bottom: 0\.85em !important/);
  assert.doesNotMatch(css, /text-indent: 1\.5em !important/);
});

test("typography enhancements target eligible paragraphs and exclude structural exceptions", () => {
  const css = getParagraphTypographyCSS(enabled);
  assert.match(css, /text-align: justify !important/);
  assert.match(css, /margin-bottom: 0\.85em !important/);
  assert.match(css, new RegExp(TYPOGRAPHY_STRUCTURAL_CLASS));
  assert.match(css, new RegExp(TYPOGRAPHY_MEDIA_PARAGRAPH_CLASS));
  assert.match(css, new RegExp(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  // `:has()` needs Safari 15.4; the reader's floor is Safari 15, so the
  // inline-only-div test lives in JS (TYPOGRAPHY_INLINE_DIV_CLASS) instead.
  assert.doesNotMatch(css, /:has\s*\(/);
  assert.match(css, /:lang\(zh\)/);
  assert.match(css, /text-indent: 2em !important/);
  assert.match(css, /hyphens: auto/);
  assert.match(css, /hyphens: manual/);
  assert.doesNotMatch(css, /:lang\(ru\)/);
});

test("the paragraph gap spares blockquotes and blank scene-break blocks", () => {
  const css = getParagraphTypographyCSS(enabled);
  const gapRule = css.slice(0, css.indexOf("margin-bottom"));
  const gapSelector = gapRule.slice(gapRule.lastIndexOf("}") + 1);
  // A quote block's own margins separate it from the prose; rewriting them
  // makes the quote run into the next sentence. It still justifies like a
  // paragraph — only the gap rule lets it go.
  assert.doesNotMatch(gapSelector, /blockquote/);
  assert.match(css, /blockquote/);
  // An empty <p> is a scene break made of nothing but its own margin, so any
  // gap value — zero included — would erase the break along with the space.
  assert.match(gapSelector, new RegExp(`:not\\(\\.${TYPOGRAPHY_BLANK_BLOCK_CLASS}\\)`));
});

test("every :not() argument is a single class, so Safari 15 keeps the whole rule", () => {
  // A complex selector inside :not() (`:not(li p)`, `:not(blockquote *)`) is
  // Selectors 4, which the reader's Safari 15 floor lacks — and an argument it
  // cannot parse invalidates the *entire* selector, not just that clause. The
  // failure is silent: justification and indent would simply stop working
  // there. The shape exclusions are stamped as classes in JS for this reason.
  const css = getParagraphTypographyCSS(enabled);
  for (const [, argument] of css.matchAll(/:not\(([^)]*)\)/g)) {
    assert.match(
      argument.trim(),
      /^\.[A-Za-z0-9_-]+$/,
      `:not() argument must be a single class, got "${argument.trim()}"`,
    );
  }
});

test("the paragraph selector covers div/li/dd/blockquote, not just p", () => {
  const css = getParagraphTypographyCSS(enabled);
  const justifyBlock = css.slice(0, css.indexOf("}") + 1);
  // A bare `div` would sweep in every wrapper in the book; only divs the JS
  // pass proved to hold nothing but inline content are eligible.
  assert.match(justifyBlock, new RegExp(`div\\.${TYPOGRAPHY_INLINE_DIV_CLASS}:not\\(`));
  assert.doesNotMatch(justifyBlock, /(^|[\s,])div:not\(/);
  for (const base of ["p", "li", "dd", "blockquote"]) {
    assert.match(justifyBlock, new RegExp(`(^|[\\s,])${base}:not\\(`, "m"));
  }
});

test("blocks the publisher centred or right-aligned are excluded from justify and indent", () => {
  const css = getParagraphTypographyCSS(enabled);
  const justifyBlock = css.slice(0, css.indexOf("}") + 1);
  assert.match(justifyBlock, new RegExp(`:not\\(\\.${TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS}\\)`));
  // The old guess list is gone: it could only ever catch an inline `style`
  // attribute and silently justified anything centred from a class or an
  // external stylesheet.
  assert.doesNotMatch(css, /:not\(\.center\)/);
  assert.doesNotMatch(css, /:not\(\.title\)/);
  assert.doesNotMatch(css, /:not\(\.heading\)/);
  assert.doesNotMatch(css, /\[align="center"\]/);
  assert.doesNotMatch(css, /style\*="text-align/);
});

test("a publisher hanging indent keeps justification but never gets our first-line indent", () => {
  const css = getParagraphTypographyCSS(enabled);
  const justifyBlock = css.slice(0, css.indexOf("}") + 1);
  assert.doesNotMatch(justifyBlock, new RegExp(`\\.${TYPOGRAPHY_HANGING_INDENT_CLASS}`));
  assert.match(
    css,
    new RegExp(`:not\\(\\.${TYPOGRAPHY_HANGING_INDENT_CLASS}\\)[\\s\\S]*text-indent: 1\\.5em`),
  );
});

test("first-line indent excludes the no-indent class from its own selector, not from justify/spacing", () => {
  const css = getParagraphTypographyCSS(enabled);
  // The base rule block (justify/spacing) is the first `{...}` in the
  // output; it must not exclude the no-indent class -- that exclusion is
  // specific to the indent rule that follows it.
  const justifyBlock = css.slice(0, css.indexOf("}") + 1);
  assert.match(justifyBlock, /text-align: justify !important/);
  assert.doesNotMatch(justifyBlock, new RegExp(`:not\\(\\.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS}\\)`));
  // The indent rule itself must be scoped to exclude it.
  assert.match(css, new RegExp(`:not\\(\\.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS}\\)[\\s\\S]*text-indent: 1\\.5em`));
});

test("list, table and opt-out paragraphs are reset to zero indent, not merely skipped", () => {
  const css = getParagraphTypographyCSS(enabled);
  // `text-indent` is inherited, so keeping a nested `<p>` out of the indent
  // rule is not enough on its own — the shapes have to be reset outright, and
  // the reset has to come after the rule it is undoing.
  assert.match(css, new RegExp(`\\.${TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS} \\{`));
  const indentRule = css.slice(css.indexOf("text-indent: 1.5em"));
  assert.match(indentRule, /text-indent: 0 !important/);
});

test("the shapes that must never indent are marked, containers included", () => {
  // The marking pass is what puts those shapes in reach of the reset rule
  // above; the stylesheet itself only ever names the class.
  const { doc, elements } = makeFakeDoc([
    ["p"],
    ["p", { neverIndent: true }],
    ["li", { neverIndent: true }],
    ["p", { structural: true }],
  ]);
  markTypographyIndentExceptions(doc);
  // elements[0] opens the section, so it is excepted for that reason instead.
  assert.ok(elements[1].classes.has(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  // A container is never a paragraph candidate, but still has to be reset —
  // otherwise the `<p>` inside it inherits the container's indent.
  assert.ok(elements[2].classes.has(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  assert.ok(elements[3].classes.has(TYPOGRAPHY_STRUCTURAL_CLASS));
  assert.ok(!elements[0].classes.has(TYPOGRAPHY_STRUCTURAL_CLASS));
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
  // 3 + 3 = a 6-character floor. The previous 5/4 (10 5 4) floor was so high
  // that hyphenation never fired at all.
  assert.match(css, /-webkit-hyphenate-limit-before: 3;/);
  assert.match(css, /-webkit-hyphenate-limit-after: 3;/);
  assert.match(css, /-webkit-hyphenate-limit-lines: 2;/);
  assert.match(css, /hyphenate-limit-chars: 6 3 3;/);
  assert.match(css, /hyphenate-limit-lines: 2;/);
  assert.doesNotMatch(css, /hyphenate-limit-chars: 10 5 4;/);
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

test("isPublisherAlignedValue treats centre/right/end as intent and start/left/justify as none", () => {
  assert.equal(isPublisherAlignedValue("center"), true);
  assert.equal(isPublisherAlignedValue("right"), true);
  assert.equal(isPublisherAlignedValue("end"), true);
  assert.equal(isPublisherAlignedValue("start"), false);
  assert.equal(isPublisherAlignedValue("left"), false);
  assert.equal(isPublisherAlignedValue("justify"), false);
});

// --- Minimal DOM double -----------------------------------------------------
// Enough of Document/Element/CSSStyleDeclaration for the marker passes, plus a
// shared log so the read/write ordering is observable.

type LogEntry = "read" | "write";

interface FakeOptions {
  textAlign?: string;
  textIndent?: string;
  fontSize?: string;
  firstLetterFloat?: string;
  firstLetterFontSize?: string;
  firstLetterLineHeight?: string;
  hasNonInlineDescendant?: boolean;
  /** Sits inside a blockquote/pre/figure — excluded from paragraph treatment. */
  structural?: boolean;
  /** A list/table/quote shape or an opt-out class — never first-line indented. */
  neverIndent?: boolean;
}

interface FakeElement {
  localName: string;
  tagName: string;
  classes: Set<string>;
  properties: Map<string, string>;
  options: FakeOptions;
  previousElementSibling: FakeElement | null;
  classList: { toggle(name: string, force: boolean): void; add(name: string): void };
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): void };
  querySelector(selector: string): FakeElement | null;
}

function makeFakeDoc(specs: Array<[string, FakeOptions?]>) {
  const log: LogEntry[] = [];
  const elements: FakeElement[] = specs.map(([localName, options = {}]) => {
    const classes = new Set<string>();
    const properties = new Map<string, string>();
    const element: FakeElement = {
      localName,
      tagName: localName.toUpperCase(),
      classes,
      properties,
      options,
      previousElementSibling: null,
      classList: {
        toggle(name, force) {
          log.push("write");
          if (force) classes.add(name);
          else classes.delete(name);
        },
        add(name) {
          log.push("write");
          classes.add(name);
        },
      },
      style: {
        setProperty(name, value) {
          log.push("write");
          properties.set(name, value);
        },
        removeProperty(name) {
          log.push("write");
          properties.delete(name);
        },
      },
      querySelector: (selector: string) => {
        // Only the inline-content probe matters here; it is the one selector
        // that starts with `*:not(`.
        if (!selector.startsWith("*:not(")) return null;
        return options.hasNonInlineDescendant ? element : null;
      },
    };
    return element;
  });
  for (let index = 1; index < elements.length; index += 1) {
    elements[index].previousElementSibling = elements[index - 1];
  }
  const doc = {
    head: { querySelectorAll: () => [] as unknown[] },
    defaultView: {
      getComputedStyle: (element: FakeElement, pseudo?: string) => {
        log.push("read");
        const options = element.options;
        if (pseudo) {
          return {
            cssFloat: options.firstLetterFloat ?? "none",
            fontSize: options.firstLetterFontSize ?? "16px",
            lineHeight: options.firstLetterLineHeight ?? "normal",
          };
        }
        return {
          textAlign: options.textAlign ?? "start",
          textIndent: options.textIndent ?? "0px",
          fontSize: options.fontSize ?? "16px",
        };
      },
    },
    // markTypographyIndentExceptions runs three different queries against the
    // document. The fake has no tree, so each is dispatched to the elements
    // the spec explicitly opted in — anything else would silently hand every
    // query the whole list and make the exclusion tests meaningless.
    querySelectorAll: (selector: string) => {
      if (selector.includes("blockquote *")) {
        return selector.includes(".noindent")
          ? elements.filter((element) => element.options.neverIndent)
          : elements.filter((element) => element.options.structural);
      }
      return elements;
    },
  };
  return { doc: doc as unknown as Document, elements, log };
}

test("stampPublisherTypography reads every computed style before it writes a single class", () => {
  const { doc, log } = makeFakeDoc([
    ["p", { textAlign: "center" }],
    ["p", { textIndent: "-24px" }],
    ["p", { firstLetterFloat: "left", firstLetterLineHeight: "0.8" }],
  ]);
  stampPublisherTypography(doc);
  assert.ok(log.includes("read"));
  assert.ok(log.includes("write"));
  // Interleaving reads and writes makes each getComputedStyle force a whole-
  // document style recalculation (Readest measured 1210ms on Android for one
  // section). Two passes cost exactly one.
  assert.ok(
    log.lastIndexOf("read") < log.indexOf("write"),
    `reads and writes interleaved: ${log.join(",")}`,
  );
});

test("stampPublisherTypography marks the publisher's alignment, hanging indent and drop cap", () => {
  const { doc, elements } = makeFakeDoc([
    ["p", { textAlign: "center" }],
    ["p", { textAlign: "end" }],
    ["p", { textAlign: "justify", textIndent: "-24px" }],
    ["p", { textAlign: "left" }],
    ["p", { firstLetterFloat: "left", firstLetterLineHeight: "0.8" }],
  ]);
  stampPublisherTypography(doc);
  assert.ok(elements[0].classes.has(TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS));
  assert.ok(elements[1].classes.has(TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS));
  // A hanging indent keeps justification, so it must NOT be marked as aligned.
  assert.ok(!elements[2].classes.has(TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS));
  assert.ok(elements[2].classes.has(TYPOGRAPHY_HANGING_INDENT_CLASS));
  assert.ok(!elements[3].classes.has(TYPOGRAPHY_PUBLISHER_ALIGNED_CLASS));
  assert.ok(!elements[3].classes.has(TYPOGRAPHY_HANGING_INDENT_CLASS));
  assert.ok(elements[4].classes.has(TYPOGRAPHY_DROP_CAP_PARAGRAPH_CLASS));
  assert.equal(elements[4].properties.get("--lantern-drop-cap-line-height"), "0.8");
});

test("stampPublisherTypography marks only the divs that hold nothing but inline content", () => {
  const { doc, elements } = makeFakeDoc([
    ["div", { hasNonInlineDescendant: false }],
    ["div", { hasNonInlineDescendant: true }],
  ]);
  stampPublisherTypography(doc);
  assert.ok(elements[0].classes.has(TYPOGRAPHY_INLINE_DIV_CLASS));
  assert.ok(!elements[1].classes.has(TYPOGRAPHY_INLINE_DIV_CLASS));
});

test("the section's opening no-indent exception skips a wrapper div and lands on the real paragraph", () => {
  const { doc, elements } = makeFakeDoc([
    ["div", { hasNonInlineDescendant: true }],
    ["p"],
    ["p"],
  ]);
  markTypographyIndentExceptions(doc);
  assert.ok(!elements[0].classes.has(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  assert.ok(elements[1].classes.has(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
  assert.ok(!elements[2].classes.has(TYPOGRAPHY_NO_INDENT_PARAGRAPH_CLASS));
});
