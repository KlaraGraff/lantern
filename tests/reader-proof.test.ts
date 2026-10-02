import assert from "node:assert/strict";
import test from "node:test";
import { inspectReader, readerIsReady, intersects, type ReaderEvidence } from "../harness/reader-proof.ts";

const body: ReaderEvidence = {
  foreground: true, focused: true, bookLoaded: true, viewWidth: 800, viewHeight: 600,
  contentDocuments: 1, visibleTextRects: 3,
  textSample: "Compatibility chapter Lantern opens this deflated chapter", animationFrames: 2,
};

test("reader proof requires visible body layout and actual animation frames", () => {
  assert.equal(readerIsReady(body), true);
  for (const missing of [
    { foreground: false }, { bookLoaded: false }, { viewWidth: 0 }, { viewHeight: 0 },
    { contentDocuments: 0 }, { visibleTextRects: 0 }, { textSample: "" }, { animationFrames: 0 },
    { textSample: "Read to here? Mark as finished" },
  ]) assert.equal(readerIsReady({ ...body, ...missing }), false, JSON.stringify(missing));
});


test("offscreen or cached iframe bounds cannot count as visible reader text", () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
  const reader = { left: 100, top: 100, right: 900, bottom: 700 };
  const inside = { left: 120, top: 120, right: 800, bottom: 650 };
  assert.equal(intersects(viewport, reader, inside), true);
  assert.equal(intersects(viewport, reader, { left: 1100, top: 100, right: 1800, bottom: 650 }), false);
  assert.equal(intersects(viewport, reader, { left: 0, top: 0, right: 50, bottom: 50 }), false);
  assert.equal(intersects(viewport, reader, { left: 120, top: 120, right: 120, bottom: 650 }), false);
});

test("inspection rejects hidden and offscreen iframe content even with text rectangles", (t) => {
  let frameVisible = true;
  let textVisible = true;
  let frameLeft = 100;
  const textNode = { textContent: body.textSample, parentElement: { checkVisibility: () => textVisible } };
  const doc = {
    body: {},
    defaultView: { frameElement: {
      checkVisibility: () => frameVisible,
      getBoundingClientRect: () => ({ left: frameLeft, top: 100, right: frameLeft + 500, bottom: 600 }),
    } },
    createTreeWalker: () => {
      let read = false;
      return { nextNode: () => { if (read) return null; read = true; return textNode; } };
    },
    createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [
      { left: 10, top: 10, right: 300, bottom: 40, width: 290, height: 30 },
    ] }),
  };
  const view = {
    book: {}, checkVisibility: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 }),
    renderer: { getContents: () => [{ doc }] },
  };
  const globals = {
    document: { visibilityState: "visible", hasFocus: () => true, querySelector: () => view },
    innerWidth: 1000, innerHeight: 800, NodeFilter: { SHOW_TEXT: 4 },
  };
  for (const [name, value] of Object.entries(globals)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  }
  assert.equal(readerIsReady(inspectReader(2)), true);
  frameVisible = false;
  assert.equal(readerIsReady(inspectReader(2)), false);
  frameVisible = true;
  textVisible = false;
  assert.equal(readerIsReady(inspectReader(2)), false);
  textVisible = true;
  frameLeft = 1200;
  assert.equal(readerIsReady(inspectReader(2)), false);
});
