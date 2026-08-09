import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CARD_SNAPSHOT_BYTES, serializeCardSnapshot } from "../src/components/vocab/cardSnapshot.ts";

// The bug this exists for: the learning card produces up to 11 word
// modules, but only two of them ever left the card — everything else the
// model produced (and the reader paid for) was discarded when the card
// closed. `serializeCardSnapshot` is the guard between "capture everything"
// and "never let one runaway response bloat every sync payload carrying
// this row".

test("a plain result serialises to JSON", () => {
  const result = { modules: { word_info: { summary: "clear" } } };
  assert.equal(serializeCardSnapshot(result), JSON.stringify(result));
});

test("null and undefined both mean nothing to store", () => {
  assert.equal(serializeCardSnapshot(null), null);
  assert.equal(serializeCardSnapshot(undefined), null);
});

test("a value that cannot serialise (a cycle) stores null rather than throwing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(serializeCardSnapshot(cyclic), null);
});

test("anything under the byte guard is kept verbatim", () => {
  const result = { modules: { word_info: { summary: "a".repeat(1000) } } };
  const json = serializeCardSnapshot(result);
  assert.ok(json);
  assert.ok(new TextEncoder().encode(json!).length <= MAX_CARD_SNAPSHOT_BYTES);
});

test("a result whose JSON exceeds the byte guard is refused, not truncated", () => {
  // One module heading plus a summary long enough alone to blow the guard.
  const result = { modules: { word_info: { summary: "x".repeat(MAX_CARD_SNAPSHOT_BYTES + 1) } } };
  assert.equal(serializeCardSnapshot(result), null);
});

test("the guard counts encoded bytes, not characters — multi-byte text is never let through on a character count alone", () => {
  // Each of these characters is 3 bytes in UTF-8; a character-count guard
  // set to MAX_CARD_SNAPSHOT_BYTES would wrongly admit this.
  const wide = "讲".repeat(Math.floor(MAX_CARD_SNAPSHOT_BYTES / 2));
  const result = { modules: { word_info: { summary: wide } } };
  const json = JSON.stringify(result);
  assert.ok(new TextEncoder().encode(json).length > MAX_CARD_SNAPSHOT_BYTES);
  assert.equal(serializeCardSnapshot(result), null);
});

// The refresh stamp. "Regenerate" now rebuilds the whole card, so the panel's
// date label has to distinguish the card that came with the word from the one
// that replaced it — and the collect path has to keep writing exactly the
// bytes it always wrote, or every card already in the database changes shape.

test("no timestamp means the bytes are exactly what a collect stored", () => {
  const result = { modules: { word_info: { summary: "clear" } } };
  assert.equal(serializeCardSnapshot(result), JSON.stringify(result));
});

test("a timestamp rides along inside the stored card", () => {
  const result = { modules: { word_info: { summary: "clear" } } };
  const json = serializeCardSnapshot(result, 1_770_000_000_000);
  assert.ok(json);
  assert.deepEqual(JSON.parse(json!), { ...result, refreshedAt: 1_770_000_000_000 });
});

test("stamping does not mutate the card it was handed", () => {
  // The same result object is still on screen in the reader's card.
  const result: Record<string, unknown> = { modules: {} };
  serializeCardSnapshot(result, 1_770_000_000_000);
  assert.deepEqual(result, { modules: {} });
});

test("a stamped card is measured against the byte guard after stamping", () => {
  // Just under the guard before the timestamp is added, over it afterwards:
  // the stamp must not be the thing that smuggles a blob past the limit.
  const filler = "x".repeat(MAX_CARD_SNAPSHOT_BYTES - 40);
  const result = { modules: { word_info: { summary: filler } } };
  assert.ok(serializeCardSnapshot(result));
  assert.equal(serializeCardSnapshot(result, 1_770_000_000_000), null);
});
