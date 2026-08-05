import assert from "node:assert/strict";
import test from "node:test";

import { learningCardFailure } from "../src/components/learning-card/config.ts";
import { isAiRetryableError, isAiSettingsError } from "../src/utils/aiError.ts";

/**
 * A failed card has to tell the reader where the problem is. Before this, every
 * failure printed a sentence and stopped there — a reader who had not set up a
 * provider yet got a dead end on their very first lookup, while translate and
 * explain both offered a way into settings.
 */

test("routes an unconfigured provider to settings instead of to a retry", () => {
  const { key, aiCode } = learningCardFailure("AI_NOT_CONFIGURED");

  assert.equal(key, "ai.notConfigured");
  assert.equal(isAiSettingsError(aiCode), true);
  assert.equal(isAiRetryableError(aiCode), false);
});

test("offers both a retry and settings while keys are cooling down", () => {
  const { aiCode } = learningCardFailure("AI_KEYS_COOLING_DOWN");

  assert.equal(isAiSettingsError(aiCode), true);
  assert.equal(isAiRetryableError(aiCode), true);
});

test("offers a plain retry when the stream broke mid-answer", () => {
  const { key, aiCode } = learningCardFailure("AI_STREAM_FAILED: connection reset");

  assert.equal(key, "ai.requestFailed");
  assert.equal(isAiSettingsError(aiCode), false);
  assert.equal(isAiRetryableError(aiCode), true);
});

test("still explains a card-protocol failure in the reader's own words", () => {
  assert.deepEqual(learningCardFailure("LEARNING_CARD_PROTOCOL_EMPTY"), {
    key: "learningCard.modelSaidNothing",
    aiCode: null,
  });
  assert.deepEqual(learningCardFailure("LEARNING_CARD_ALL_MODULES_DISABLED"), {
    key: "learningCard.allModulesDisabled",
    aiCode: null,
  });
});

test("blames the route, not the model, when a card never reached one", () => {
  // Both markers in one message: the route failed first, so pointing the reader
  // at the model's formatting would send them to the wrong screen.
  const { key, aiCode } = learningCardFailure(
    "AI_NOT_CONFIGURED while preparing LEARNING_CARD_PROTOCOL_EMPTY",
  );

  assert.equal(aiCode, "AI_NOT_CONFIGURED");
  assert.equal(key, "ai.notConfigured");
});

test("prints an error it does not recognize verbatim rather than guessing", () => {
  assert.deepEqual(learningCardFailure("sqlite: database is locked"), {
    key: null,
    aiCode: null,
  });
});
