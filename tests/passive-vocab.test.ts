import assert from "node:assert/strict";
import test from "node:test";
import {
  installPassiveVocabAnnotations,
  parsePassiveVocabSettings,
  passiveVocabCount,
  passiveVocabLabel,
  rollbackPassiveVocabSettings,
  selectPassiveVocab,
  shouldShowPassiveVocab,
  updatePassiveVocabSettings,
  type PassiveVocabDomAnnotation,
} from "../src/components/passive-vocab.ts";

// A minimal DOM stand-in covering only what passive-vocab.ts touches: element
// creation/attributes/style, a document-level querySelectorAll that matches
// simple `[attr]` and `[attr=value]` selectors, and a fake Range that reports
// a caller-supplied bounding rect.
function createFakeDoc(options: { innerWidth?: number; innerHeight?: number } = {}) {
  const allElements: FakeElement[] = [];

  class FakeElement {
    tagName: string;
    attributes = new Map<string, string>();
    style: Record<string, string> = {};
    id = "";
    className = "";
    textContent = "";
    scrollHeight = 20;
    rectHeight = 0;
    children: FakeElement[] = [];
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
      // Tests don't need real detach semantics; cleanup isn't exercised here.
    }
    getBoundingClientRect() {
      return { height: this.rectHeight } as DOMRect;
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
  const doc = {
    body,
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
  };
  return { doc: doc as unknown as Document, FakeElement, allElements };
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
  assert.deepEqual(parsePassiveVocabSettings({}), { enabled: false, style: "ruby", density: "medium" });
  assert.deepEqual(parsePassiveVocabSettings({
    passive_vocab_enabled: "true",
    passive_vocab_style: "margin",
    passive_vocab_density: "high",
  }), { enabled: true, style: "margin", density: "high" });
});

test("passive vocabulary density deterministically prioritises active learning over CFI order", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "mastered", definition: "finished learning" },
    { cfi: "epubcfi(/6/6)", mastery: "new", definition: "unseen" },
    { cfi: "epubcfi(/6/4)", mastery: "learning", definition: "active practice" },
    { cfi: "epubcfi(/6/8)", mastery: "learning", definition: "second active word" },
  ];
  assert.equal(passiveVocabLabel("to move gradually toward"), "to move gradual…");
  assert.equal(passiveVocabCount(words.length, "low"), 1);
  assert.deepEqual([...selectPassiveVocab(words, "low")], ["epubcfi(/6/4)"]);
  assert.deepEqual([...selectPassiveVocab(words, "medium")], ["epubcfi(/6/4)", "epubcfi(/6/8)"]);
  assert.deepEqual([...selectPassiveVocab(words, "high")], [
    "epubcfi(/6/4)", "epubcfi(/6/8)", "epubcfi(/6/6)", "epubcfi(/6/2)",
  ]);
  const selected = selectPassiveVocab(words, "low");
  assert.equal(shouldShowPassiveVocab("epubcfi(/6/4)", "low", selected), true);
  assert.equal(shouldShowPassiveVocab("epubcfi(/6/2)", "low", selected), false);
});

test("optimistic settings writes roll back only the failed state, never a newer edit", () => {
  const original = { enabled: false, style: "ruby" as const, density: "medium" as const };
  const enable = updatePassiveVocabSettings(original, { enabled: true });
  assert.deepEqual(enable.values, {
    passive_vocab_enabled: "true",
    passive_vocab_style: "ruby",
    passive_vocab_density: "medium",
  });
  assert.deepEqual(rollbackPassiveVocabSettings(enable.next, enable), original);
  const newer = { ...enable.next, style: "margin" as const };
  assert.deepEqual(rollbackPassiveVocabSettings(newer, enable), newer);
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
