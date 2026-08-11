import assert from "node:assert/strict";
import test from "node:test";
import { resolveFrontToken } from "../src/components/learning-card/mobileCardStack.ts";

// `resolveFrontToken` is the arithmetic half of `useIsFrontMobileCard`: given
// every currently-mounted card's `{ token -> stackIndex }` registration, which
// token is the phone's one bottom sheet showing. No React tree needed to
// exercise it — a plain `Map` stands in for the registry.

test("nothing registered shows nothing", () => {
  assert.equal(resolveFrontToken(new Map()), null);
});

test("one registered card is the front card", () => {
  assert.equal(resolveFrontToken(new Map([["a", 0]])), "a");
});

test("the highest stackIndex wins, regardless of registration order", () => {
  const entries = new Map([
    ["opened-first", 0],
    ["opened-third", 2],
    ["opened-second", 1],
  ]);
  assert.equal(resolveFrontToken(entries), "opened-third");
});

test("closing the front card falls back to whichever is now highest", () => {
  // Three cards open, in order; the third (front) card closes.
  const allThreeOpen = new Map([
    ["first", 0],
    ["second", 1],
    ["third", 2],
  ]);
  assert.equal(resolveFrontToken(allThreeOpen), "third");

  const afterThirdCloses = new Map(allThreeOpen);
  afterThirdCloses.delete("third");
  // The reader sees the second card again, not a blank sheet.
  assert.equal(resolveFrontToken(afterThirdCloses), "second");
});

test("a tie resolves to whichever entry is seen last in iteration", () => {
  // Only transient in practice (see the doc comment on `resolveFrontToken`),
  // but the resolution rule itself needs to be pinned down regardless.
  const tied = new Map([
    ["old-registration", 3],
    ["new-registration", 3],
  ]);
  assert.equal(resolveFrontToken(tied), "new-registration");
});
