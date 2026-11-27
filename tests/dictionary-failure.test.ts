import assert from "node:assert/strict";
import test from "node:test";
import { dictionaryFailureOf } from "../src/components/dictionary-failure.ts";

test("no network and nothing offline is the case that offers the download", () => {
  assert.equal(dictionaryFailureOf("DICTIONARY_OFFLINE_MISSING"), "offline_missing");
});

test("no network with the offline dictionary already there or queued says offline", () => {
  assert.equal(dictionaryFailureOf("DICTIONARY_UNAVAILABLE"), "offline");
});

test("a genuine not-found is not a failure the card explains", () => {
  assert.equal(dictionaryFailureOf("DICTIONARY_NOT_FOUND"), null);
  assert.equal(dictionaryFailureOf(new Error("anything else")), null);
});
