import assert from "node:assert/strict";
import test from "node:test";

import {
  cachedLearningCardResult,
  learningCardCacheEnvelope,
  learningCardCacheSignature,
} from "../src/components/learning-card/cache.ts";
import { DEFAULT_CARD_DESIGN_CONFIG } from "../src/components/learning-card/config.ts";
import type { LearningCardResult } from "../src/components/learning-card/types.ts";

const wordCard = () => structuredClone(DEFAULT_CARD_DESIGN_CONFIG.cards.word);

const result: LearningCardResult = {
  version: 1,
  kind: "word",
  sourceText: "spoiling",
  modules: { context_meaning: { summary: "宠爱" } },
};

test("reuses a stored card when the card design is unchanged", () => {
  const signature = learningCardCacheSignature(wordCard());
  const stored = learningCardCacheEnvelope(result, signature);
  assert.deepEqual(
    cachedLearningCardResult(stored, "word", signature)?.modules,
    result.modules,
  );
});

test("drops a stored card once the card design changes", () => {
  const stored = learningCardCacheEnvelope(result, learningCardCacheSignature(wordCard()));

  const withoutModule = wordCard();
  withoutModule.modules[0].enabled = !withoutModule.modules[0].enabled;
  assert.equal(
    cachedLearningCardResult(stored, "word", learningCardCacheSignature(withoutModule)),
    null,
  );

  const denser = wordCard();
  denser.defaultDensity = denser.defaultDensity === "detailed" ? "compact" : "detailed";
  assert.equal(cachedLearningCardResult(stored, "word", learningCardCacheSignature(denser)), null);

  const moreExamples = wordCard();
  moreExamples.exampleCount += 1;
  assert.equal(
    cachedLearningCardResult(stored, "word", learningCardCacheSignature(moreExamples)),
    null,
  );
});

test("module order does not change the cache signature", () => {
  const reordered = wordCard();
  reordered.modules.reverse();
  assert.equal(learningCardCacheSignature(reordered), learningCardCacheSignature(wordCard()));
});

test("rejects stored cards of another kind, empty cards, and junk", () => {
  const signature = learningCardCacheSignature(wordCard());
  const stored = learningCardCacheEnvelope(result, signature);
  assert.equal(cachedLearningCardResult(stored, "phrase", signature), null);
  assert.equal(cachedLearningCardResult(null, "word", signature), null);
  assert.equal(cachedLearningCardResult("not json", "word", signature), null);
  assert.equal(cachedLearningCardResult(JSON.stringify(result), "word", signature), null);
  assert.equal(
    cachedLearningCardResult(
      learningCardCacheEnvelope({ ...result, modules: {} }, signature),
      "word",
      signature,
    ),
    null,
  );
});
