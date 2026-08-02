import assert from "node:assert/strict";
import test from "node:test";

// reader-interaction.ts reads these off the global, the way a webview provides
// them. Stubbed before import so the module sees them.
(globalThis as { Node?: unknown }).Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };

const { contextForRange } = await import("../src/components/reader-interaction.ts") as {
  contextForRange: (range: unknown, fallback: string) => string;
};

interface FakeNode {
  nodeType: number;
  tagName?: string;
  textContent: string | null;
  parentElement: FakeNode | null;
  parentNode: FakeNode | null;
}

const PASSAGE = "He had a penchant for spoiling his grandchildren with trips to the fairground.";

/** A text node inside `tags`, innermost first, under a document node. */
const nest = (tags: string[]): FakeNode => {
  const document: FakeNode = {
    nodeType: 9,
    // A document node reports no textContent, which is what made the walk
    // falling off the top of the tree return the fallback.
    textContent: null,
    parentElement: null,
    parentNode: null,
  };
  let parent = document;
  for (const tagName of [...tags].reverse()) {
    const element: FakeNode = {
      nodeType: 1,
      tagName,
      textContent: PASSAGE,
      parentElement: parent.nodeType === 1 ? parent : null,
      parentNode: parent,
    };
    parent = element;
  }
  return {
    nodeType: 3,
    textContent: "spoiling",
    parentElement: parent,
    parentNode: parent,
  };
};

const rangeIn = (node: FakeNode) => ({
  commonAncestorContainer: node,
  toString: () => "spoiling",
});

test("a lookup in an EPUB reads the paragraph, whose tag name is lower case", () => {
  // EPUB content is parsed as application/xhtml+xml, so tagName keeps the
  // source casing. Matching it case-sensitively sent the model the bare word.
  assert.equal(contextForRange(rangeIn(nest(["html", "body", "p"])), "spoiling"), PASSAGE);
  assert.equal(
    contextForRange(rangeIn(nest(["html", "body", "div", "p", "em"])), "spoiling"),
    PASSAGE,
  );
});

test("an HTML document still reads the same paragraph", () => {
  assert.equal(contextForRange(rangeIn(nest(["HTML", "BODY", "P"])), "spoiling"), PASSAGE);
  assert.equal(
    contextForRange(rangeIn(nest(["HTML", "BODY", "DIV", "P", "LANTERN-MARK"])), "spoiling"),
    PASSAGE,
  );
});

test("text with no block ancestor at all falls back to the selection", () => {
  assert.equal(contextForRange(rangeIn(nest(["html", "body"])), "spoiling"), "spoiling");
});
