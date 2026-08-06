import assert from "node:assert/strict";
import test from "node:test";

import {
  canApplyXrayLoad,
  canReuseXrayCache,
  classifyXrayLoadError,
  didXrayNavigationSucceed,
  isEmptyXrayResult,
  setBoundedCacheEntry,
  shouldOfferXrayUpdate,
  xrayCacheKey,
} from "../src/components/xray-card.ts";

test("only the latest load generation may update the card", () => {
  const firstNetworkLoad = 1;
  const laterCacheHit = 2;
  assert.equal(canApplyXrayLoad(laterCacheHit, firstNetworkLoad), false);
  assert.equal(canApplyXrayLoad(laterCacheHit, laterCacheHit), true);
});

test("navigation closes only after an explicit success acknowledgement", () => {
  assert.equal(didXrayNavigationSucceed(true), true);
  assert.equal(didXrayNavigationSucceed(false), false);
  assert.equal(didXrayNavigationSucceed(undefined), false);
});

test("safe cards offer an update only after reading progress advances", () => {
  assert.equal(shouldOfferXrayUpdate({ scope: "safe", progress: 34 }, 35), true);
  assert.equal(shouldOfferXrayUpdate({ scope: "safe", progress: 34 }, 34), false);
  assert.equal(shouldOfferXrayUpdate({ scope: "wholeBook", progress: 34 }, 80), false);
});

test("whole-book cache keys cannot collide by casing or whitespace", () => {
  assert.equal(xrayCacheKey("book", " Genly Ai "), xrayCacheKey("book", "genly ai"));
  assert.notEqual(xrayCacheKey("book-a", "genly"), xrayCacheKey("book-b", "genly"));
});

test("safe cache reuse requires the same exact reading boundary", () => {
  assert.equal(canReuseXrayCache("epubcfi(/6/8)", "epubcfi(/6/8)"), true);
  assert.equal(canReuseXrayCache("epubcfi(/6/8)", "epubcfi(/6/4)"), false);
  assert.equal(canReuseXrayCache("textloc:v2:800:810", "textloc:v2:200:210"), false);
});

test("an unknown result with an explanation is not a blank protocol result", () => {
  const base = { kind: "unknown" as const, facts: [], relations: [], relationPaths: [] };
  assert.equal(isEmptyXrayResult({ ...base, summary: "" }), true);
  assert.equal(isEmptyXrayResult({ ...base, summary: "Not enough read context." }), false);
});

test("the safe cache evicts the oldest entry once it exceeds its bound", () => {
  const cache = new Map<string, number>();
  setBoundedCacheEntry(cache, "a", 1, 2);
  setBoundedCacheEntry(cache, "b", 2, 2);
  setBoundedCacheEntry(cache, "c", 3, 2);
  assert.deepEqual([...cache.keys()], ["b", "c"]);
  assert.equal(cache.size, 2);
});

test("any AI provider/credential failure is classified distinctly from a generic failure, and carries its code through", () => {
  for (const code of [
    "AI_NOT_CONFIGURED",
    "AI_KEYS_DISABLED",
    "AI_ALL_KEYS_INVALID",
    "AI_NO_USABLE_KEYS",
    "AI_KEYS_COOLING_DOWN",
  ]) {
    const presentation = classifyXrayLoadError(code);
    assert.equal(presentation.kind, "ai");
    assert.equal(presentation.aiErrorCode, code);
  }
});

test("index lifecycle errors from ai_xray each get their own presentation, not the generic one", () => {
  assert.equal(classifyXrayLoadError("XRAY_INDEX_BUILDING").kind, "indexBuilding");
  assert.equal(classifyXrayLoadError("XRAY_INDEX_FAILED").kind, "indexFailed");
  assert.equal(classifyXrayLoadError("XRAY_INDEX_UNSUPPORTED").kind, "indexUnsupported");
});

test("an unrecognized failure falls back to the generic presentation", () => {
  assert.equal(classifyXrayLoadError("XRAY_PROTOCOL_INVALID").kind, "generic");
  assert.equal(classifyXrayLoadError("BOOK_NOT_FOUND").kind, "generic");
});

test("re-inserting an existing key refreshes its recency instead of duplicating it", () => {
  const cache = new Map<string, number>();
  setBoundedCacheEntry(cache, "a", 1, 2);
  setBoundedCacheEntry(cache, "b", 2, 2);
  setBoundedCacheEntry(cache, "a", 1, 2);
  setBoundedCacheEntry(cache, "c", 3, 2);
  // "a" was most-recently touched, so "b" (now the oldest) is evicted, not "a".
  assert.deepEqual([...cache.keys()], ["a", "c"]);
});
