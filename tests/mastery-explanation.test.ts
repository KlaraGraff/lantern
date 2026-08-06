import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import {
  isMasteryReasonCode,
  MASTERY_REASON_CODES,
  masteryBecauseExplanation,
  masteryTransitionDirection,
  parseMasteryDetail,
  timelineEventExplanation,
} from "../src/components/vocab/mastery-explanation.ts";

const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(path.join(i18nDir, "zh.json"), "utf8")) as Record<string, string>;

function assertTranslated(key: string) {
  assert.ok(key in en, `missing from en.json: ${key}`);
  assert.ok(key in zh, `missing from zh.json: ${key}`);
}

test("parseMasteryDetail: null and empty input degrade to null, not a throw", () => {
  assert.equal(parseMasteryDetail(null), null);
  assert.equal(parseMasteryDetail(undefined), null);
  assert.equal(parseMasteryDetail(""), null);
});

test("parseMasteryDetail: malformed JSON degrades to null instead of throwing", () => {
  assert.equal(parseMasteryDetail("{not json"), null);
  assert.equal(parseMasteryDetail("[1,2,3]"), null);
  assert.equal(parseMasteryDetail("\"just a string\""), null);
  assert.equal(parseMasteryDetail("42"), null);
});

test("parseMasteryDetail: a well-formed object parses through", () => {
  assert.deepEqual(parseMasteryDetail('{"reason":"exposure_promotion","book_title":"Emma"}'), {
    reason: "exposure_promotion",
    book_title: "Emma",
  });
});

test("masteryBecauseExplanation: a null mastery_reason yields no sentence", () => {
  assert.equal(masteryBecauseExplanation(null), null);
  assert.equal(masteryBecauseExplanation(undefined), null);
});

test("masteryBecauseExplanation: malformed JSON yields no sentence, does not throw", () => {
  assert.equal(masteryBecauseExplanation("{broken"), null);
});

test("masteryBecauseExplanation: a reason code that can never be auto-sourced yields no sentence", () => {
  // user_override / review_* are only ever recorded with source "manual" or
  // "review" — mastery_reason should never carry them, but if it somehow did,
  // silently showing nothing is correct, not an error state to surface.
  assert.equal(masteryBecauseExplanation('{"reason":"user_override"}'), null);
  assert.equal(masteryBecauseExplanation('{"reason":"review_promotion","rating":"good"}'), null);
});

test("masteryBecauseExplanation: an unrecognized reason code yields no sentence", () => {
  assert.equal(masteryBecauseExplanation('{"reason":"future_reason_code_v9"}'), null);
});

test("masteryBecauseExplanation: full detail picks the interpolated key and carries its params", () => {
  const explanation = masteryBecauseExplanation(
    '{"reason":"exposure_promotion","book_title":"Emma","distinct_days":3,"exposures":4}',
  );
  assert.deepEqual(explanation, {
    key: "vocab.mastery.because.exposure_promotion.detail",
    params: { bookTitle: "Emma", days: 3, exposures: 4 },
  });
});

test("masteryBecauseExplanation: a partial detail falls back to the reason-only key", () => {
  const explanation = masteryBecauseExplanation('{"reason":"exposure_promotion","book_title":"Emma"}');
  assert.equal(explanation?.key, "vocab.mastery.because.exposure_promotion.plain");
});

test("timelineEventExplanation: each known reason code maps to a distinct key", () => {
  const keys = new Set<string>();
  for (const reason of MASTERY_REASON_CODES) {
    const explanation = timelineEventExplanation(reason, null, "learning", "familiar");
    keys.add(explanation.key);
  }
  assert.equal(keys.size, MASTERY_REASON_CODES.length, "two reason codes collided on the same key");
});

test("timelineEventExplanation: an unrecognized reason code still produces a row, via the generic fallback", () => {
  const explanation = timelineEventExplanation("some_future_reason", null, "new", "learning");
  assert.equal(explanation.key, "vocab.mastery.timeline.generic");
  assert.deepEqual(explanation.params, { from: "new", to: "learning" });
});

test("timelineEventExplanation: malformed detail degrades to the reason-only variant instead of throwing", () => {
  const explanation = timelineEventExplanation("exposure_promotion", "{not json", "learning", "familiar");
  assert.equal(explanation.key, "vocab.mastery.timeline.exposure_promotion.plain");
  assert.deepEqual(explanation.params, { from: "learning", to: "familiar" });
});

test("timelineEventExplanation: full detail is preferred over the plain fallback", () => {
  const explanation = timelineEventExplanation(
    "repeat_lookup_demotion",
    '{"book_title":"Wuthering Heights","lookup_count":3}',
    "familiar",
    "learning",
  );
  assert.deepEqual(explanation, {
    key: "vocab.mastery.timeline.repeat_lookup_demotion.detail",
    params: { bookTitle: "Wuthering Heights", lookupCount: 3, from: "familiar", to: "learning" },
  });
});

test("timelineEventExplanation: user_override never needs a plain variant (no required fields)", () => {
  const explanation = timelineEventExplanation("user_override", "{}", "new", "learning");
  assert.equal(explanation.key, "vocab.mastery.timeline.user_override.detail");
});

test("masteryTransitionDirection: familiar sits between learning and mastered", () => {
  assert.equal(masteryTransitionDirection("learning", "familiar"), "up");
  assert.equal(masteryTransitionDirection("familiar", "mastered"), "up");
  assert.equal(masteryTransitionDirection("familiar", "learning"), "down");
  assert.equal(masteryTransitionDirection("mastered", "familiar"), "down");
  assert.equal(masteryTransitionDirection("new", "new"), "flat");
});

test("masteryTransitionDirection: an unrecognized tier name ranks as flat, not a throw", () => {
  assert.equal(masteryTransitionDirection("not_a_tier", "learning"), "flat");
});

test("isMasteryReasonCode rejects arbitrary strings", () => {
  assert.equal(isMasteryReasonCode("exposure_promotion"), true);
  assert.equal(isMasteryReasonCode("not_a_reason"), false);
  assert.equal(isMasteryReasonCode(42), false);
});

// Every key this module can hand back to a component must actually resolve in
// both locales — a key the code can construct but the JSON never defines
// would render as the literal key string in production.
test("every key this module can produce exists in both locale files", () => {
  for (const reason of MASTERY_REASON_CODES) {
    assertTranslated(`vocab.mastery.timeline.${reason}.detail`);
  }
  assertTranslated("vocab.mastery.timeline.generic");
  for (const reason of ["exposure_promotion", "lookup_demotion", "repeat_lookup_demotion"]) {
    assertTranslated(`vocab.mastery.because.${reason}.detail`);
    assertTranslated(`vocab.mastery.because.${reason}.plain`);
  }
  for (const reason of ["exposure_promotion", "lookup_demotion", "repeat_lookup_demotion", "review_promotion", "review_demotion"]) {
    assertTranslated(`vocab.mastery.timeline.${reason}.plain`);
  }
});
