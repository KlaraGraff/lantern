import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupChapterEndHint,
  installChapterEndHint,
  shouldShowChapterEndHint,
  type ChapterEndHintOptions,
} from "../src/components/chapter-end-hint.ts";
import { readerPreferenceSettingKeys } from "../src/pages/reader/useReaderSettingsSync.ts";

// A minimal DOM stand-in covering only what chapter-end-hint.ts touches:
// element creation (including the SVG-namespaced path), a `head` to receive
// the injected <style>, and a document-level querySelectorAll that matches
// simple `[attr]` selectors — the same shape `tests/passive-vocab.test.ts`
// uses for the same reason (this repo's test runner has no real DOM).
function createFakeDoc(options: { coarsePointer?: boolean } = {}) {
  const allElements: FakeElement[] = [];

  class FakeElement {
    tagName: string;
    attributes = new Map<string, string>();
    style: Record<string, string> = {};
    textContent = "";
    children: FakeElement[] = [];
    listeners: Record<string, ((event: unknown) => void)[]> = {};
    constructor(tagName: string) {
      this.tagName = tagName;
      allElements.push(this);
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    }
    hasAttribute(name: string) {
      return this.attributes.has(name);
    }
    append(...nodes: unknown[]) {
      for (const node of nodes) {
        if (node instanceof FakeElement) this.children.push(node);
      }
    }
    remove() {
      const index = allElements.indexOf(this);
      if (index !== -1) allElements.splice(index, 1);
    }
    addEventListener(type: string, handler: (event: unknown) => void) {
      (this.listeners[type] ??= []).push(handler);
    }
  }

  function matches(el: FakeElement, selector: string) {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (!match) return false;
    const [, attr, value] = match;
    if (!el.hasAttribute(attr)) return false;
    return value === undefined || el.getAttribute(attr) === value;
  }

  const body = new FakeElement("body");
  const head = new FakeElement("head");
  const doc = {
    body,
    head,
    defaultView: {
      matchMedia: (query: string) => ({
        matches: query.includes("coarse") ? (options.coarsePointer ?? false) : false,
      }),
    },
    createElement(tag: string) {
      return new FakeElement(tag);
    },
    createElementNS(_ns: string, tag: string) {
      return new FakeElement(tag);
    },
    querySelectorAll(selector: string) {
      return allElements.filter((el) => matches(el, selector));
    },
  };
  return { doc: doc as unknown as Document, allElements };
}

function baseOptions(doc: Document, overrides: Partial<ChapterEndHintOptions> = {}): ChapterEndHintOptions {
  return {
    doc,
    lookupCount: 3,
    words: [
      { id: "w1", word: "ephemeral" },
      { id: "w2", word: "lantern" },
      { id: "w3", word: "recap" },
    ],
    overflowLabel: null,
    text: {
      line: "You looked up 3 words in this chapter",
      expand: "Take a look ⌄",
      collapse: "Collapse ⌃",
      reason: "While it's still fresh, go over them right here.",
      openInReview: "Open this chapter in Review →",
      dismiss: "Don't show again",
    },
    color: { muted: "#71717b", rule: "rgba(0,0,0,.08)" },
    onReview: () => {},
    onDismiss: () => {},
    onWordClick: () => {},
    onExpandChange: () => {},
    ...overrides,
  };
}

test("a lookup count of zero installs nothing — the block does not render at all", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, { lookupCount: 0, words: [] }));
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 0);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end-style]").length, 0);
});

test("zero words still installs nothing even if a stray lookupCount disagreed with an empty words list", () => {
  // Belt and suspenders: `words` is what actually reaches the DOM, but
  // visibility is governed by `lookupCount` (see shouldShowChapterEndHint).
  // A caller that got the two out of sync should still render nothing once
  // the count says there is nothing to show.
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, { lookupCount: 0, words: [{ id: "w1", word: "orphan" }] }));
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 0);
});

test("the setting being off is a suppression the caller can check without touching the DOM", () => {
  // The setting lives one layer up, in useFoliateAnnotations.ts, which reads it
  // through this predicate before ever calling installChapterEndHint — so
  // "off" is tested here as "the predicate says no", not as a DOM assertion.
  assert.equal(shouldShowChapterEndHint(false, 5), false);
  assert.equal(shouldShowChapterEndHint(true, 0), false);
  assert.equal(shouldShowChapterEndHint(true, 5), true);
});

test("installing twice leaves exactly one line, not two stacked on top of each other", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  installChapterEndHint(baseOptions(doc, { lookupCount: 7 }));
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 1);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end-style]").length, 1);
});

test("cleanup removes both the line and its injected style", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 1);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end-style]").length, 1);
  cleanupChapterEndHint(doc);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 0);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end-style]").length, 0);
});

test("the collapsed state starts with the panel hidden and only the toggle, line and dismiss clickable", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const clickable = allElements.filter((el) => el.listeners.click?.length);
  // toggle + dismiss + 3 word chips + review link = 6, but the panel starts
  // hidden — chips and the review link exist in the DOM already (this module
  // has no lazy-render), only their *visibility* is deferred via display:none.
  const toggle = clickable.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄");
  assert.ok(toggle, "the collapsed row shows the expand toggle");
  assert.equal(toggle!.getAttribute("aria-expanded"), "false");
});

test("expanding flips the toggle label, aria-expanded, and fires onExpandChange(true, root)", () => {
  const { doc, allElements } = createFakeDoc();
  let expandChangeCalls: Array<[boolean, unknown]> = [];
  installChapterEndHint(baseOptions(doc, {
    onExpandChange: (expanded, root) => { expandChangeCalls.push([expanded, root]); },
  }));
  const toggle = allElements.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄")!;
  toggle.listeners.click![0]({ preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(toggle.textContent, "Collapse ⌃");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.deepEqual(expandChangeCalls.length, 1);
  assert.equal(expandChangeCalls[0][0], true);
  const root = allElements.find((el) => el.hasAttribute("data-lantern-chapter-end"));
  assert.equal(expandChangeCalls[0][1], root);
});

// The bug: in paginated mode the section document is laid out in CSS columns,
// so expanding grew the body, the renderer re-columnised, and the panel flowed
// into the next column while the row's header stayed put — the row expanded
// into visibly nothing. Both spellings, because WebKit is the only engine this
// runs on and the unprefixed property is the one that is easy to lose in a
// refactor without anyone noticing until they open a book.
test("the row refuses to be split across columns, so an expanded panel cannot be orphaned onto the next page", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const root = allElements.find((el) => el.hasAttribute("data-lantern-chapter-end"))!;
  assert.equal(root.style.breakInside, "avoid");
  assert.equal(root.style.WebkitColumnBreakInside, "avoid");
});

// Clicking a chip opens the word card, which records a lookup, which makes the
// reader re-apply annotations — and that tears this line down and builds it
// again. Rebuilt collapsed, looking at a second word cost an expand and a
// re-find every time.
test("a line rebuilt while the reader had it open comes back open", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const toggle = allElements.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄")!;
  toggle.listeners.click![0]({ preventDefault: () => {}, stopPropagation: () => {} });

  let expandChanges = 0;
  installChapterEndHint(baseOptions(doc, { onExpandChange: () => { expandChanges += 1; } }));
  const rebuilt = doc.querySelectorAll("[data-lantern-chapter-end]") as unknown as { children: { style: Record<string, string>; getAttribute(name: string): string | null; textContent: string }[] }[];
  assert.equal(rebuilt.length, 1);
  const [, panel] = rebuilt[0].children;
  assert.equal(panel.style.display, "block", "the rebuilt panel must still be open");
  const rebuiltToggle = allElements.filter((el) => el.tagName === "button" && el.textContent === "Collapse ⌃").at(-1)!;
  assert.equal(rebuiltToggle.getAttribute("aria-expanded"), "true");
  // Restoring is not the reader pressing the toggle: the caller scrolls the
  // row into view on a real expand, and doing that on a rebuild would yank the
  // page out from under someone who is reading a word card.
  assert.equal(expandChanges, 0);
});

test("a line the reader collapsed again is rebuilt collapsed", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const toggle = allElements.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄")!;
  const click = { preventDefault: () => {}, stopPropagation: () => {} };
  toggle.listeners.click![0](click);
  toggle.listeners.click![0](click);

  installChapterEndHint(baseOptions(doc));
  const rebuiltToggle = allElements.filter((el) => el.tagName === "button" && el.textContent === "Take a look ⌄").at(-1)!;
  assert.equal(rebuiltToggle.getAttribute("aria-expanded"), "false");
});

test("one document being left open says nothing about another's", () => {
  const first = createFakeDoc();
  installChapterEndHint(baseOptions(first.doc));
  const toggle = first.allElements.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄")!;
  toggle.listeners.click![0]({ preventDefault: () => {}, stopPropagation: () => {} });

  const second = createFakeDoc();
  installChapterEndHint(baseOptions(second.doc));
  const other = second.allElements.find((el) => el.tagName === "button" && el.textContent === "Take a look ⌄")!;
  assert.equal(other.getAttribute("aria-expanded"), "false");
});

test("clicking a word chip calls onWordClick with that word's id and its own button", () => {
  const { doc, allElements } = createFakeDoc();
  const clicks: Array<[string, unknown]> = [];
  installChapterEndHint(baseOptions(doc, {
    onWordClick: (id, chipElement) => { clicks.push([id, chipElement]); },
  }));
  const chip = allElements.find((el) => el.tagName === "button" && el.textContent === "lantern")!;
  chip.listeners.click![0]({ preventDefault: () => {}, stopPropagation: () => {} });
  assert.deepEqual(clicks, [["w2", chip]]);
});

test("word chips are capped by the caller, not by this module — an overflow label renders once, verbatim", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, {
    words: [{ id: "w1", word: "one" }, { id: "w2", word: "two" }],
    overflowLabel: "+3",
  }));
  const overflow = allElements.filter((el) => el.tagName === "i" && el.textContent === "+3");
  assert.equal(overflow.length, 1);
});

test("no overflow label means no overflow marker at all", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, { overflowLabel: null }));
  assert.equal(allElements.filter((el) => el.tagName === "i").length, 0);
});

test("word chips are outlined, never filled — no background colour, only a border", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const chips = allElements.filter((el) => el.tagName === "button" && ["ephemeral", "lantern", "recap"].includes(el.textContent));
  assert.equal(chips.length, 3);
  for (const chip of chips) {
    assert.equal(chip.style.background, "transparent", `${chip.textContent} chip must not carry a fill`);
    assert.ok(chip.style.border?.includes("rgba(0,0,0,.08)"), `${chip.textContent} chip must be outlined in the theme's rule colour`);
  }
});

test("clicking the review link calls onReview", () => {
  const { doc, allElements } = createFakeDoc();
  let reviewed = 0;
  installChapterEndHint(baseOptions(doc, { onReview: () => { reviewed += 1; } }));
  const link = allElements.find((el) => el.tagName === "button" && el.textContent === "Open this chapter in Review →")!;
  link.listeners.click![0]({ preventDefault: () => {}, stopPropagation: () => {} });
  assert.equal(reviewed, 1);
});

test("on a fine pointer (mouse/trackpad) the dismiss control sits in the collapsed row, hover-revealed", () => {
  const { doc, allElements } = createFakeDoc({ coarsePointer: false });
  installChapterEndHint(baseOptions(doc));
  const dismiss = allElements.find((el) => el.hasAttribute("data-lantern-chapter-end-dismiss"))!;
  assert.ok(dismiss.hasAttribute("data-lantern-chapter-end-dismiss-hover"), "fine-pointer dismiss must be hover-revealed");
});

test("on a coarse pointer (touch) the dismiss control moves into the expanded panel and is always visible", () => {
  const { doc, allElements } = createFakeDoc({ coarsePointer: true });
  installChapterEndHint(baseOptions(doc));
  const dismiss = allElements.find((el) => el.hasAttribute("data-lantern-chapter-end-dismiss"))!;
  assert.equal(
    dismiss.hasAttribute("data-lantern-chapter-end-dismiss-hover"),
    false,
    "touch dismiss must not be hidden behind a hover reveal nobody on touch can trigger",
  );
});

test("the dismiss control is a real button with an accessible name", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const [dismiss] = doc.querySelectorAll("[data-lantern-chapter-end-dismiss]") as unknown as {
    tagName: string;
    getAttribute(name: string): string | null;
  }[];
  assert.ok(dismiss, "the dismiss control must exist once a line is installed");
  assert.equal(dismiss.tagName, "button");
  assert.equal(dismiss.getAttribute("aria-label"), "Don't show again");
});

// The crash this guards against: foliate-js installs its own click listener on
// every section document that intercepts anything inside an `a[href]` and runs
// it through `view.goTo()`, without consulting `defaultPrevented`. So an
// anchor here meant one press both ran our handler *and* moved the renderer —
// and "go review" tears that renderer down, which took the whole app with it.
// Two independent guarantees keep it dead: nothing we inject is an anchor, and
// nothing we inject lets a click escape to the document at all.
test("nothing the line injects is an anchor foliate would hijack", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  for (const el of allElements) {
    assert.notEqual(el.tagName, "a", "the line must contain no anchors");
    assert.equal(el.getAttribute("href"), null, `${el.tagName} must carry no href`);
  }
});

test("every clickable control stops its click before it reaches the document", () => {
  const { doc, allElements } = createFakeDoc();
  let reviewed = 0;
  let dismissed = 0;
  installChapterEndHint(baseOptions(doc, {
    onReview: () => { reviewed += 1; },
    onDismiss: () => { dismissed += 1; },
  }));

  const clickable = allElements.filter((el) => el.listeners.click?.length);
  // toggle + review link + dismiss + 3 word chips = 6.
  assert.equal(clickable.length, 6);

  for (const el of clickable) {
    let prevented = 0;
    let stopped = 0;
    const event = {
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    };
    for (const handler of el.listeners.click) handler(event);
    assert.equal(prevented, 1, `${el.tagName} "${el.textContent}" must preventDefault`);
    assert.equal(stopped, 1, `${el.tagName} "${el.textContent}" must stopPropagation`);
  }

  assert.equal(reviewed, 1);
  assert.equal(dismissed, 1);
});

test("no node the module produces carries the accent purple used elsewhere in the app", () => {
  const { doc, allElements } = createFakeDoc();
  installChapterEndHint(baseOptions(doc));
  const forbidden = ["#7c3aed", "#c084fc", "accent"];
  for (const el of allElements) {
    const haystacks = [
      el.textContent,
      ...Object.values(el.style),
      ...[...el.attributes.values()],
    ].map((value) => value.toLowerCase());
    for (const needle of forbidden) {
      assert.ok(
        haystacks.every((value) => !value.includes(needle)),
        `${el.tagName} must not carry "${needle}"`,
      );
    }
  }
});

// Three ways this line can stop appearing — simply not opening it (no state
// change at all), "don't show again" in the collapsed row or expanded panel,
// and the same toggle in Reading settings — and all three have to mean the
// same thing to the backend: one boolean, one storage key. Two independently
// maintained keys that happen to read "off" the same way today would still be
// two settings a future change could silently split apart.
test("the settings-panel toggle and the inline dismiss write the exact same settings key", () => {
  assert.equal(readerPreferenceSettingKeys.chapterEndReviewHint, "chapter_end_review_hint");
});
