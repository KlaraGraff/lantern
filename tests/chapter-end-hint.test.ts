import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupChapterEndHint,
  installChapterEndHint,
  shouldShowChapterEndHint,
  type ChapterEndHintOptions,
} from "../src/components/chapter-end-hint.ts";

// A minimal DOM stand-in covering only what chapter-end-hint.ts touches:
// element creation (including the SVG-namespaced path), a `head` to receive
// the injected <style>, and a document-level querySelectorAll that matches
// simple `[attr]` selectors — the same shape `tests/passive-vocab.test.ts`
// uses for the same reason (this repo's test runner has no real DOM).
function createFakeDoc() {
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
    text: { line: "You looked up 3 words in this chapter.", action: "Go over them →", dismiss: "Don't show again" },
    color: { muted: "#71717b", rule: "rgba(0,0,0,.08)" },
    onReview: () => {},
    onDismiss: () => {},
    ...overrides,
  };
}

test("a lookup count of zero installs nothing", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, { lookupCount: 0 }));
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end]").length, 0);
  assert.equal(doc.querySelectorAll("[data-lantern-chapter-end-style]").length, 0);
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

test("the dismiss control is a real button with an accessible name", () => {
  const { doc } = createFakeDoc();
  installChapterEndHint(baseOptions(doc, {
    text: { line: "line", action: "action", dismiss: "Don't show again" },
  }));
  const [dismiss] = doc.querySelectorAll("[data-lantern-chapter-end-dismiss]") as unknown as {
    tagName: string;
    getAttribute(name: string): string | null;
  }[];
  assert.ok(dismiss, "the dismiss control must exist once a line is installed");
  assert.equal(dismiss.tagName, "button");
  assert.equal(dismiss.getAttribute("aria-label"), "Don't show again");
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
