import assert from "node:assert/strict";
import test from "node:test";

// epubcfi.js reads these off the global, the way it does inside the reader.
(globalThis as { NodeFilter?: unknown }).NodeFilter = {
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
};

const { fromRange, skipTransparent, TRANSPARENT_ATTRIBUTE } = await import(
  "../public/foliate-js/epubcfi.js"
) as {
  fromRange: (range: unknown, filter?: unknown) => string;
  skipTransparent: unknown;
  TRANSPARENT_ATTRIBUTE: string;
};

interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  ownerDocument?: { documentElement: FakeNode };
  id?: string;
  hasAttribute?: (name: string) => boolean;
}

const text = (value: string): FakeNode => ({
  nodeType: 3,
  nodeValue: value,
  childNodes: [],
  parentNode: null,
});

const element = (children: FakeNode[], attributes: string[] = []): FakeNode => {
  const node: FakeNode = {
    nodeType: 1,
    childNodes: children,
    parentNode: null,
    hasAttribute: (name: string) => attributes.includes(name),
  };
  for (const child of children) child.parentNode = node;
  return node;
};

/** `<html><body><p>…</p></body></html>`, with `documentElement` wired up. */
const document = (paragraph: FakeNode[]) => {
  const root = element([element([element(paragraph)])]);
  const wire = (node: FakeNode) => {
    node.ownerDocument = { documentElement: root };
    node.childNodes.forEach(wire);
  };
  wire(root);
  return root;
};

const range = (container: FakeNode, start: number, end: number) => ({
  startContainer: container,
  startOffset: start,
  endContainer: container,
  endOffset: end,
  collapsed: false,
});

const SENTENCE = "He had a penchant for spoiling his grandchildren";
const BEFORE = "He had a ";
const WORD = "penchant";
const AFTER = " for spoiling his grandchildren";
const TARGET = "spoiling";

test("a transparent marker leaves the CFI of the text around it unchanged", () => {
  const plainText = text(SENTENCE);
  document([plainText]);
  const plain = fromRange(
    range(plainText, SENTENCE.indexOf(TARGET), SENTENCE.indexOf(TARGET) + TARGET.length),
    skipTransparent,
  );

  // The same sentence with one word wrapped, as the reader marks it.
  const tail = text(AFTER);
  document([
    text(BEFORE),
    element([text(WORD)], [TRANSPARENT_ATTRIBUTE]),
    tail,
  ]);
  const marked = fromRange(
    range(tail, AFTER.indexOf(TARGET), AFTER.indexOf(TARGET) + TARGET.length),
    skipTransparent,
  );

  assert.equal(marked, plain);
});

test("without the filter the same marker moves the CFI — which is what it guards", () => {
  const plainText = text(SENTENCE);
  document([plainText]);
  const plain = fromRange(
    range(plainText, SENTENCE.indexOf(TARGET), SENTENCE.indexOf(TARGET) + TARGET.length),
  );

  const tail = text(AFTER);
  document([
    text(BEFORE),
    element([text(WORD)], [TRANSPARENT_ATTRIBUTE]),
    tail,
  ]);
  const marked = fromRange(
    range(tail, AFTER.indexOf(TARGET), AFTER.indexOf(TARGET) + TARGET.length),
  );

  assert.notEqual(marked, plain);
});

test("a marker inside the addressed text does not move it either", () => {
  const plainText = text(SENTENCE);
  document([plainText]);
  const plain = fromRange(range(plainText, 0, BEFORE.length), skipTransparent);

  const head = text(BEFORE);
  document([
    head,
    element([text(WORD)], [TRANSPARENT_ATTRIBUTE]),
    text(AFTER),
  ]);
  const marked = fromRange(range(head, 0, BEFORE.length), skipTransparent);

  assert.equal(marked, plain);
});
