import assert from "node:assert/strict";
import test from "node:test";

import {
  canApplyXrayLoad,
  canReuseXrayCache,
  didXrayNavigationSucceed,
  isEmptyXrayResult,
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
