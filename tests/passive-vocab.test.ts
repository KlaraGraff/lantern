import assert from "node:assert/strict";
import test from "node:test";
import {
  PASSIVE_VOCAB_DEFAULT_LIMIT,
  clampPassiveVocabLimit,
  cleanupPassiveVocabAnnotations,
  formatPassiveVocabSummary,
  installPassiveVocabAnnotations,
  parsePassiveVocabSettings,
  passiveVocabGlossShifts,
  passiveVocabLabel,
  passiveVocabStage,
  passiveVocabSummaryParts,
  rollbackPassiveVocabSettings,
  selectPassiveVocab,
  updatePassiveVocabSettings,
  type PassiveVocabDomAnnotation,
} from "../src/components/passive-vocab.ts";

/** What the assertions below need off a node the fake document handed back. */
interface FakeLike {
  textContent: string;
  getAttribute(name: string): string | null;
}

// A minimal DOM stand-in covering only what passive-vocab.ts touches: element
// creation/attributes/style, a document-level querySelectorAll that matches
// simple `[attr]` and `[attr=value]` selectors, and a fake Range that reports
// a caller-supplied bounding rect.
function createFakeDoc(options: { innerWidth?: number; innerHeight?: number } = {}) {
  const allElements: FakeElement[] = [];

  class FakeElement {
    tagName: string;
    attributes = new Map<string, string>();
    style: Record<string, string> & { setProperty(name: string, value: string): void };
    id = "";
    className = "";
    textContent = "";
    scrollHeight = 20;
    rectHeight = 0;
    children: FakeElement[] = [];
    childNodes: FakeElement[] = [];
    constructor(tagName: string) {
      this.tagName = tagName;
      const style = {} as Record<string, string> & { setProperty(name: string, value: string): void };
      style.setProperty = (name, value) => { style[name] = value; };
      this.style = style;
      allElements.push(this);
    }
    replaceWith() {
      this.remove();
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
      const at = allElements.indexOf(this);
      if (at >= 0) allElements.splice(at, 1);
    }
    /** Only ever asked about the marker attribute, and markers never nest. */
    closest(selector: string) {
      return matches(this, selector) ? this : null;
    }
    getBoundingClientRect() {
      return { height: this.rectHeight, top: 100, bottom: 120, left: 40 } as DOMRect;
    }
  }

  // Handles `[attr]`, `[attr="value"]`, and the two chained together.
  function matches(el: FakeElement, selector: string) {
    const parts = selector.match(/\[[^\]]+\]/g);
    if (!parts || parts.join("") !== selector) return false;
    return parts.every((part) => {
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
      if (!match) return false;
      const [, attr, value] = match;
      if (!el.hasAttribute(attr)) return false;
      return value === undefined || el.getAttribute(attr) === value;
    });
  }

  const body = new FakeElement("body");
  const head = new FakeElement("head");
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const doc = {
    body,
    head,
    documentElement: { clientWidth: options.innerWidth ?? 400, clientHeight: options.innerHeight ?? 800 },
    defaultView: { innerWidth: options.innerWidth ?? 400, innerHeight: options.innerHeight ?? 800 },
    createElement(tag: string) {
      return new FakeElement(tag);
    },
    createDocumentFragment() {
      return new FakeElement("#fragment");
    },
    querySelectorAll(selector: string) {
      return allElements.filter((el) => matches(el, selector));
    },
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler);
    },
  };
  /** Fires whatever `installMarkerBehaviour` registered, the way the DOM would. */
  function dispatch(type: string, event: Record<string, unknown>) {
    for (const handler of [...(listeners.get(type) ?? [])]) {
      handler({ preventDefault() {}, stopPropagation() {}, ...event });
    }
  }
  return { doc: doc as unknown as Document, FakeElement, allElements, listeners, dispatch };
}

function fakeRange(rect: { left: number; top: number; width: number }) {
  return {
    collapsed: false,
    getBoundingClientRect: () => ({ left: rect.left, top: rect.top, width: rect.width, height: 0 } as DOMRect),
    extractContents: () => ({}),
    insertNode: () => {},
  } as unknown as Range;
}

test("passive vocabulary settings default safely and accept only known choices", () => {
  assert.deepEqual(parsePassiveVocabSettings({}), { enabled: false, style: "ruby", limit: PASSIVE_VOCAB_DEFAULT_LIMIT });
  assert.deepEqual(parsePassiveVocabSettings({
    passive_vocab_enabled: "true",
    passive_vocab_style: "margin",
    passive_vocab_limit: "6",
  }), { enabled: true, style: "margin", limit: 6 });
  // Anything outside the range the settings screen offers is pulled back into
  // it rather than annotating a whole page or nothing at all.
  assert.equal(parsePassiveVocabSettings({ passive_vocab_limit: "0" }).limit, 1);
  assert.equal(parsePassiveVocabSettings({ passive_vocab_limit: "99" }).limit, 10);
  assert.equal(parsePassiveVocabSettings({ passive_vocab_limit: "not a number" }).limit, PASSIVE_VOCAB_DEFAULT_LIMIT);
  assert.equal(clampPassiveVocabLimit(Number.NaN), PASSIVE_VOCAB_DEFAULT_LIMIT);
});

// The three stages are the whole feature: an annotation that never steps back
// is decoration, and one that steps back at the wrong tier lies to the reader
// about their own progress.
test("mastery decides which of the three stages a word is in", () => {
  assert.equal(passiveVocabStage(null), "definition");
  assert.equal(passiveVocabStage("new"), "definition");
  assert.equal(passiveVocabStage("learning"), "definition");
  assert.equal(passiveVocabStage("familiar"), "marker");
  assert.equal(passiveVocabStage("mastered"), "none");
});

test("the limit caps definitions, and words past it show nothing rather than a marker", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "mastered", definition: "finished learning" },
    { cfi: "epubcfi(/6/6)", mastery: "new", definition: "unseen" },
    { cfi: "epubcfi(/6/4)", mastery: "learning", definition: "active practice" },
    { cfi: "epubcfi(/6/8)", mastery: "learning", definition: "second active word" },
    { cfi: "epubcfi(/6/10)", mastery: "familiar", definition: "nearly known" },
  ];
  // A gloss of the length the save path now produces goes over the word whole;
  // the clamp is a guard rail for legacy blobs, not the thing that shortens it.
  assert.equal(passiveVocabLabel("to move gradually toward"), "to move gradually toward");
  assert.equal(passiveVocabLabel("逐渐向某处移动"), "逐渐向某处移动");
  // Width, not character count: a full-width character costs two columns, so
  // sixteen Chinese characters fill the same budget as thirty-two Latin ones.
  assert.equal(passiveVocabLabel("一".repeat(20)), `${"一".repeat(15)}…`);
  // The card's own contextual line has to survive the guard rail whole — this
  // is 30 columns, and a 28-column ceiling clamped it to "…（做…".
  assert.equal(passiveVocabLabel("非常仔细、一丝不苟地（做某事）"), "非常仔细、一丝不苟地（做某事）");
  assert.ok(passiveVocabLabel("Meaning in this context: to tell a story in order").endsWith("…"));

  const tight = selectPassiveVocab(words, 1);
  // Learning beats new, CFI breaks the tie, and the two words past the cap are
  // absent entirely — not demoted to a marker they have not earned.
  assert.deepEqual([...tight], [["epubcfi(/6/10)", "marker"], ["epubcfi(/6/4)", "definition"]]);
  assert.equal(tight.has("epubcfi(/6/8)"), false);
  assert.equal(tight.has("epubcfi(/6/6)"), false);
  // A mastered word is gone at every limit, and never takes up a slot.
  assert.equal(selectPassiveVocab(words, 10).has("epubcfi(/6/2)"), false);

  const roomy = selectPassiveVocab(words, 3);
  assert.equal(roomy.get("epubcfi(/6/4)"), "definition");
  assert.equal(roomy.get("epubcfi(/6/8)"), "definition");
  assert.equal(roomy.get("epubcfi(/6/6)"), "definition");
  assert.equal(roomy.get("epubcfi(/6/10)"), "marker");
});

test("a familiar word keeps its marker no matter how tight the limit is", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "learning", definition: "one" },
    { cfi: "epubcfi(/6/4)", mastery: "learning", definition: "two" },
    { cfi: "epubcfi(/6/6)", mastery: "familiar", definition: "three" },
    { cfi: "epubcfi(/6/8)", mastery: "familiar", definition: "four" },
  ];
  const stages = selectPassiveVocab(words, 1);
  assert.equal(stages.get("epubcfi(/6/6)"), "marker");
  assert.equal(stages.get("epubcfi(/6/8)"), "marker");
  // A hairline under a word the reader nearly knows costs almost nothing;
  // capping it would make stage two vanish on any page with fresh lookups.
  assert.equal([...stages.values()].filter((stage) => stage === "definition").length, 1);
});

// The setting says "how many definitions one screen may show", and it used to
// be handed the whole book's vocabulary in a single call — so the first three
// words in the book took the entire allowance and every later page was bare.
test("the limit is spent per screen, not once for the whole book", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "new", definition: "first", screen: 0 },
    { cfi: "epubcfi(/6/4)", mastery: "new", definition: "second", screen: 0 },
    { cfi: "epubcfi(/6/6)", mastery: "new", definition: "third", screen: 1 },
    { cfi: "epubcfi(/6/8)", mastery: "new", definition: "fourth", screen: 1 },
    { cfi: "epubcfi(/6/10)", mastery: "new", definition: "fifth", screen: 9 },
  ];
  const stages = selectPassiveVocab(words, 1);
  // One per screen — three screens, three glosses — and never two from one.
  assert.equal([...stages.values()].filter((stage) => stage === "definition").length, 3);
  assert.equal(stages.get("epubcfi(/6/2)"), "definition");
  assert.equal(stages.has("epubcfi(/6/4)"), false);
  assert.equal(stages.get("epubcfi(/6/6)"), "definition");
  assert.equal(stages.has("epubcfi(/6/8)"), false);
  assert.equal(stages.get("epubcfi(/6/10)"), "definition");
});

test("teaching order and tie-breaking are decided within a screen, not across the book", () => {
  const words = [
    // Later in the book, but the only "learning" word on its own screen.
    { cfi: "epubcfi(/6/20)", mastery: "learning", definition: "later screen", screen: 5 },
    { cfi: "epubcfi(/6/2)", mastery: "new", definition: "earliest", screen: 0 },
    { cfi: "epubcfi(/6/4)", mastery: "learning", definition: "same screen, in learning", screen: 0 },
  ];
  const stages = selectPassiveVocab(words, 1);
  // Screen 0 goes to the word in active learning, and screen 5's word is not
  // competing with it at all.
  assert.equal(stages.get("epubcfi(/6/4)"), "definition");
  assert.equal(stages.has("epubcfi(/6/2)"), false);
  assert.equal(stages.get("epubcfi(/6/20)"), "definition");
});

// A word whose position has not been measured yet must still be annotatable;
// the fallback is the old single-bucket behaviour, not silence.
test("words with no measured screen share one bucket", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "new", definition: "first" },
    { cfi: "epubcfi(/6/4)", mastery: "new", definition: "second" },
  ];
  assert.equal([...selectPassiveVocab(words, 1).values()].filter((s) => s === "definition").length, 1);
});

// Markers are explicitly uncapped, so screens have nothing to do with them.
test("markers are never bucketed or capped by screen", () => {
  const words = Array.from({ length: 6 }, (_, index) => ({
    cfi: `epubcfi(/6/${index})`,
    mastery: "familiar",
    definition: "nearly known",
    screen: 0,
  }));
  const stages = selectPassiveVocab(words, 1);
  assert.equal([...stages.values()].filter((stage) => stage === "marker").length, 6);
});

test("optimistic settings writes roll back only the failed state, never a newer edit", () => {
  const original = { enabled: false, style: "ruby" as const, limit: 3 };
  const enable = updatePassiveVocabSettings(original, { enabled: true });
  assert.deepEqual(enable.values, {
    passive_vocab_enabled: "true",
    passive_vocab_style: "ruby",
    passive_vocab_limit: "3",
  });
  assert.deepEqual(rollbackPassiveVocabSettings(enable.next, enable), original);
  const newer = { ...enable.next, style: "margin" as const };
  assert.deepEqual(rollbackPassiveVocabSettings(newer, enable), newer);
  // The stepper hands over raw arithmetic, so the clamp has to live here too.
  assert.equal(updatePassiveVocabSettings(original, { limit: 0 }).next.limit, 1);
  assert.equal(updatePassiveVocabSettings(original, { limit: 11 }).next.limit, 10);
});

test("margin gloss inherits the reader theme colour instead of a hardcoded one", () => {
  const { doc } = createFakeDoc();
  const annotations: PassiveVocabDomAnnotation[] = [{ cfi: "epubcfi(/6/2)", label: "gloss" }];
  const rects = new Map([["epubcfi(/6/2)", { left: 10, top: 0, width: 20 }]]);
  installPassiveVocabAnnotations({
    doc,
    annotations,
    resolveRange: (cfi) => fakeRange(rects.get(cfi)!),
    style: "margin",
  });
  const notes = doc.querySelectorAll("[data-passive-vocab-margin-label]") as unknown as { style: Record<string, string> }[];
  assert.equal(notes.length, 1);
  assert.equal(notes[0].style.color, "inherit");
});

test("spread margin notes go to the outside edge of the word's physical page", () => {
  const { doc } = createFakeDoc({ innerWidth: 400 });
  const annotations: PassiveVocabDomAnnotation[] = [
    { cfi: "epubcfi(/6/2)", label: "left-page word" },
    { cfi: "epubcfi(/6/4)", label: "right-page word" },
  ];
  const rects = new Map([
    ["epubcfi(/6/2)", { left: 10, top: 0, width: 20 }], // left physical page
    ["epubcfi(/6/4)", { left: 300, top: 0, width: 20 }], // right physical page
  ]);
  installPassiveVocabAnnotations({
    doc,
    annotations,
    resolveRange: (cfi) => fakeRange(rects.get(cfi)!),
    style: "margin",
    spread: true,
  });
  const leftRail = doc.querySelectorAll('[data-passive-vocab-margin-rail="left"]') as unknown as { children: { textContent: string }[] }[];
  const rightRail = doc.querySelectorAll('[data-passive-vocab-margin-rail="right"]') as unknown as { children: { textContent: string }[] }[];
  assert.equal(leftRail.length, 1);
  assert.equal(rightRail.length, 1);
  assert.equal(leftRail[0].children.some((c) => c.textContent === "left-page word"), true);
  assert.equal(rightRail[0].children.some((c) => c.textContent === "right-page word"), true);
});

test("single-page margin notes balance load across rails instead of always picking one side", () => {
  const { doc } = createFakeDoc({ innerWidth: 400, innerHeight: 800 });
  // Same rect for both, so the old x-position-only heuristic would have put
  // both notes on the same side; balancing must split them.
  const annotations: PassiveVocabDomAnnotation[] = [
    { cfi: "epubcfi(/6/2)", label: "first" },
    { cfi: "epubcfi(/6/4)", label: "second" },
  ];
  installPassiveVocabAnnotations({
    doc,
    annotations,
    resolveRange: () => fakeRange({ left: 10, top: 0, width: 20 }),
    style: "margin",
    spread: false,
  });
  const leftRail = doc.querySelectorAll('[data-passive-vocab-margin-rail="left"]') as unknown as { children: unknown[] }[];
  const rightRail = doc.querySelectorAll('[data-passive-vocab-margin-rail="right"]') as unknown as { children: unknown[] }[];
  assert.equal(leftRail.length, 1);
  assert.equal(rightRail.length, 1);
  assert.equal(leftRail[0].children.length, 1);
  assert.equal(rightRail[0].children.length, 1);
});

test("margin notes clamp at the viewport bottom and surface the drop as a +N badge", () => {
  const { doc } = createFakeDoc({ innerWidth: 400, innerHeight: 60 });
  const annotations: PassiveVocabDomAnnotation[] = Array.from({ length: 4 }, (_, i) => ({
    cfi: `epubcfi(/6/${i})`,
    label: `word ${i}`,
  }));
  installPassiveVocabAnnotations({
    doc,
    annotations,
    // All words on the same physical (left) page in a spread, forcing them
    // to stack on the same rail so the clamp is exercised.
    resolveRange: () => fakeRange({ left: 0, top: 0, width: 20 }),
    style: "margin",
    spread: true,
  });
  const notes = doc.querySelectorAll("[data-passive-vocab-margin-label]");
  const badges = doc.querySelectorAll("[data-passive-vocab-margin-overflow]") as unknown as { textContent: string }[];
  assert.ok(notes.length < annotations.length, "some notes must be dropped rather than overflowing the viewport");
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, `+${annotations.length - notes.length}`);
});

// The summary line under the master switch is the only place the three
// settings are stated in one sentence, so its "off" form matters as much as
// its "on" one: listing a style and a density while the feature is off would
// read as if it were still annotating pages.
test("the settings summary states style and limit only while it is on", () => {
  const translate = (key: string, params?: { count: number }) => (
    params ? `${key.replace("settings.passiveVocab.", "")}(${params.count})` : key.replace("settings.passiveVocab.", "")
  );
  assert.equal(
    formatPassiveVocabSummary({ enabled: true, style: "ruby", limit: 3 }, translate),
    "summaryOn · styleRuby · summaryLimit(3)",
  );
  assert.equal(
    formatPassiveVocabSummary({ enabled: true, style: "margin", limit: 7 }, translate),
    "summaryOn · styleMargin · summaryLimit(7)",
  );
  assert.deepEqual(
    passiveVocabSummaryParts({ enabled: false, style: "margin", limit: 1 }),
    [{ key: "settings.passiveVocab.summaryOff" }],
  );
  assert.equal(
    formatPassiveVocabSummary({ enabled: false, style: "margin", limit: 1 }, translate),
    "summaryOff",
  );
});

test("every summary key the formatter can emit is a distinct key", () => {
  const emitted = new Set<string>();
  for (const enabled of [true, false]) {
    for (const style of ["ruby", "margin"] as const) {
      for (const limit of [1, 3, 10]) {
        for (const part of passiveVocabSummaryParts({ enabled, style, limit })) emitted.add(part.key);
      }
    }
  }
  // 1 off + 1 on + 2 styles + 1 limit.
  assert.equal(emitted.size, 5);
});

test("a marker carries its gloss in an attribute, keeping the paragraph's own text intact", () => {
  const { doc } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [{ cfi: "epubcfi(/6/2)", label: "fruit garden", stage: "marker" }],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  const markers = doc.querySelectorAll("[data-passive-vocab-marker]") as unknown as FakeLike[];
  assert.equal(markers.length, 1);
  assert.equal(markers[0].getAttribute("data-passive-vocab-marker-label"), "fruit garden");
  assert.equal(markers[0].getAttribute("role"), "button");
  assert.equal(markers[0].getAttribute("aria-expanded"), "false");
  // No <rt>, no rail note: stage two adds nothing the reader has to read past.
  assert.equal(doc.querySelectorAll("[data-passive-vocab-ruby-text]").length, 0);
  assert.equal(doc.querySelectorAll("[data-passive-vocab-margin-label]").length, 0);
});

test("tapping a marker opens exactly one gloss, and tapping it again puts it away", () => {
  const { doc, dispatch } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [
      { cfi: "epubcfi(/6/2)", label: "first gloss", stage: "marker" },
      { cfi: "epubcfi(/6/4)", label: "second gloss", stage: "marker" },
    ],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  const markers = doc.querySelectorAll("[data-passive-vocab-marker]") as unknown as FakeLike[];
  assert.equal(markers.length, 2);
  const popovers = () => doc.querySelectorAll("[data-passive-vocab-popover]") as unknown as FakeLike[];

  dispatch("click", { target: markers[0] });
  assert.equal(popovers().length, 1);
  assert.equal(popovers()[0].textContent, "first gloss");
  assert.equal(markers[0].getAttribute("aria-expanded"), "true");

  // Opening the second one puts the first away instead of stacking two chips.
  dispatch("click", { target: markers[1] });
  assert.equal(popovers().length, 1);
  assert.equal(popovers()[0].textContent, "second gloss");
  assert.equal(markers[0].getAttribute("aria-expanded"), "false");

  dispatch("click", { target: markers[1] });
  assert.equal(popovers().length, 0);

  // A tap anywhere else is a page turn, so the gloss just closes.
  dispatch("click", { target: markers[0] });
  assert.equal(popovers().length, 1);
  dispatch("click", { target: null });
  assert.equal(popovers().length, 0);
});

test("cleanup unhooks the marker listeners so re-installing never stacks them", () => {
  const { doc, listeners } = createFakeDoc();
  const install = () => installPassiveVocabAnnotations({
    doc,
    annotations: [{ cfi: "epubcfi(/6/2)", label: "gloss", stage: "marker" }],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  install();
  install();
  install();
  assert.equal(listeners.get("click")?.size, 1);
  assert.equal(listeners.get("keydown")?.size, 1);
  cleanupPassiveVocabAnnotations(doc);
  assert.equal(listeners.get("click")?.size, 0);
  assert.equal(doc.querySelectorAll("[data-passive-vocab-style]").length, 0);
});

test("a page with no markers pays for no marker listeners", () => {
  const { doc, listeners } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [{ cfi: "epubcfi(/6/2)", label: "gloss", stage: "definition" }],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  assert.equal(listeners.get("click")?.size ?? 0, 0);
});

test("a page with no annotation at all pays for no stylesheet", () => {
  const { doc } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [],
    resolveRange: () => null,
    style: "ruby",
  });
  assert.equal(doc.querySelectorAll("[data-passive-vocab-style]").length, 0);
});

// The bug this covers: `<rt>` is sized to its base, so a gloss wider than the
// word it sits over was clipped to the word's width. The fix takes the
// annotation out of ruby layout — absolutely positioned, centred, and allowed
// to be as wide as it needs — and gives the base back the vertical room native
// ruby would have reserved.
test("the ruby gloss overflows its word instead of being clipped to it", () => {
  const { doc } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [{ cfi: "epubcfi(/6/2)", label: "逐渐向某处移动", stage: "definition" }],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  const sheets = doc.querySelectorAll("[data-passive-vocab-style]") as unknown as { textContent: string }[];
  assert.equal(sheets.length, 1);
  const css = sheets[0].textContent.replace(/\s+/g, " ");
  assert.match(css, /::before \{[^}]*position: absolute/);
  assert.match(css, /::before \{[^}]*white-space: nowrap/);
  assert.match(css, /::before \{[^}]*left: 50%/);
  assert.match(css, /translateX\(calc\(-50% \+ var\(--lantern-passive-vocab-shift, 0px\)\)\)/);
  // The base has to reserve the line-box room the absolute annotation no
  // longer takes, or the gloss would be drawn over the line above — but with
  // `margin`, never `padding`. Padding is inside the border box, so it grew
  // the word's own rectangle upwards and every marker painted from that
  // rectangle (the正文 underline) floated a line above its word.
  assert.match(css, /ruby\[data-passive-vocab-root\] \{[^}]*margin-top/);
  assert.doesNotMatch(css, /ruby\[data-passive-vocab-root\] \{[^}]*padding-top/);
  // Anchored to the bottom of that reserved strip, i.e. just above its own
  // word, rather than the top of it, i.e. against the previous line. The `calc`
  // adds back a deliberate hair of air so the two do not touch.
  assert.match(css, /::before \{[^}]*bottom: calc\(100% \+ [\d.]+em\)/);
  assert.match(css, /ruby\[data-passive-vocab-root\] \{[^}]*position: relative/);
  // `bottom: 100%` anchors to the wrapper's border box, and an inline-block's
  // border box *is* a line box — at the reader's line height it stands a third
  // of an em taller than the word on each side, which pushes the gloss further
  // from its own word than from the line above. Collapsing the wrapper's line
  // height to 1 removes that half-leading; the word itself does not move.
  assert.match(css, /ruby\[data-passive-vocab-root\] \{[^}]*line-height: 1;/);
});

// The bug this covers: the正文 markers are stroked over every rectangle in the
// CFI range's `getClientRects()`, and an `<rt>` inside the wrapper is inside
// that range. One annotated word came back as three rectangles — the word plus
// two for the gloss — so a rule was drawn under the gloss as well, which reads
// as a stray line floating above the word. A pseudo-element gloss generates a
// box but no node, so the range sees the word and nothing else.
test("the ruby gloss adds no node inside the wrapper, so the word's own rects stay clean", () => {
  const { doc } = createFakeDoc();
  installPassiveVocabAnnotations({
    doc,
    annotations: [{ cfi: "epubcfi(/6/2)", label: "一丝不苟地", stage: "definition" }],
    resolveRange: () => fakeRange({ left: 10, top: 100, width: 20 }),
    style: "ruby",
  });
  const wrappers = doc.querySelectorAll("[data-passive-vocab-root]") as unknown as FakeLike[];
  assert.equal(wrappers.length, 1);
  // The gloss is carried as an attribute and drawn by `content: attr(...)`.
  assert.equal(wrappers[0].getAttribute("data-passive-vocab-ruby-text"), "一丝不苟地");
  assert.equal(doc.querySelectorAll("rt").length, 0);
});

test("glosses on one line are nudged apart, and separate lines are left alone", () => {
  // Two overlapping boxes on the same line, one clear box below them.
  const shifts = passiveVocabGlossShifts([
    { left: 0, right: 60, top: 10, bottom: 24 },
    { left: 40, right: 100, top: 10, bottom: 24 },
    { left: 0, right: 60, top: 60, bottom: 74 },
  ]);
  assert.equal(shifts[0], 0);
  // 60 (previous right) + 4 (gap) - 40 (its own left) = 24.
  assert.equal(shifts[1], 24);
  assert.equal(shifts[2], 0);
});

test("a gloss that already clears its neighbour is not moved", () => {
  const shifts = passiveVocabGlossShifts([
    { left: 0, right: 30, top: 10, bottom: 24 },
    { left: 80, right: 120, top: 10, bottom: 24 },
  ]);
  assert.deepEqual(shifts, [0, 0]);
});

// A fake DOM, or a document being torn down, reports rects with missing
// coordinates. Centred-and-overlapping is a cosmetic flaw; NaN in a transform
// is a gloss that vanishes.
test("unmeasurable glosses are skipped rather than shifted by NaN", () => {
  const shifts = passiveVocabGlossShifts([
    { left: 0, right: Number.NaN, top: 10, bottom: 24 },
    { left: 10, right: 50, top: 10, bottom: 24 },
    { left: undefined as unknown as number, right: 20, top: 10, bottom: 24 },
  ]);
  assert.deepEqual(shifts, [0, 0, 0]);
});
