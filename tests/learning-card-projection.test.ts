import assert from "node:assert/strict";
import test from "node:test";
import {
  cardVocabFields,
  moduleText,
  projection,
} from "../src/components/learning-card/projection.ts";
import { condenseGloss, isShortGloss } from "../src/components/vocab/gloss.ts";
import type { LearningCardResult } from "../src/components/learning-card/types.ts";

// The bug this exists for: these rules used to be private helpers inside
// `LearningCardController`, so the vocabulary panel's "regenerate" — which now
// rebuilds the whole card rather than one line of it — could only reuse them
// by copying them. Two copies of "which module becomes the gloss" is how a
// regenerated word ends up described differently from a collected one.

const card = (modules: LearningCardResult["modules"]): LearningCardResult => ({
  version: 1,
  kind: "word",
  sourceText: "gregarious",
  modules,
});

test("the gloss is offered by the contextual meaning first, then the word entry", () => {
  assert.equal(
    cardVocabFields(card({
      context_meaning: { summary: "sociable, in this sentence" },
      word_info: { summary: "fond of company" },
    })).gloss,
    "sociable, in this sentence",
  );
  assert.equal(
    cardVocabFields(card({ word_info: { summary: "fond of company" } })).gloss,
    "fond of company",
  );
  assert.equal(cardVocabFields(card({ usage: { summary: "warm" } })).gloss, null);
});

test("only the summary line is ever offered as the gloss", () => {
  // `definition` is one short line printed above the word in the book. A
  // module's headings, lists and examples belong to the long form.
  assert.equal(
    cardVocabFields(card({
      context_meaning: { heading: "in this sentence", details: ["a", "b"] },
    })).gloss,
    null,
  );
});

test("the long form is the contextual meaning, whole", () => {
  const fields = cardVocabFields(card({
    context_meaning: { heading: "in this sentence", summary: "sociable", details: ["not the herd sense"] },
    word_info: { summary: "fond of company" },
  }));
  assert.equal(fields.contextExplanation, "in this sentence\nsociable\nnot the herd sense");
});

test("with no contextual meaning the word entry stands in as the long form", () => {
  // Better a general entry than an empty column — the panel prints this under
  // "in this sentence", and a blank there reads as a failed save.
  assert.equal(
    cardVocabFields(card({ word_info: { summary: "fond of company" } })).contextExplanation,
    "fond of company",
  );
});

test("a card with neither module contributes nothing rather than an empty string", () => {
  assert.deepEqual(cardVocabFields(card({})), { gloss: null, contextExplanation: null });
  assert.deepEqual(
    cardVocabFields(card({ context_meaning: {}, word_info: {} })),
    { gloss: null, contextExplanation: null },
  );
});

test("the lookup record keeps the word entry over the contextual meaning", () => {
  // The opposite preference to the vocabulary gloss, and deliberately so: a
  // cached lookup is reused for the same word in other sentences.
  const result = projection(card({
    context_meaning: { summary: "sociable, in this sentence" },
    word_info: { summary: "fond of company" },
  }));
  assert.equal(result.definition, "fond of company");
  assert.equal(result.contextExplanation, "sociable, in this sentence");
});

test("a card written to the two-part contract needs no second model call", () => {
  // `context_meaning.summary` is the bare sense and the explanation sits in
  // `details`, so the gloss the card offers already fits above the word: it is
  // stored as-is, and the reader sees the same words in the book and in the
  // card. When the summary was a whole sentence it never fit, and every save
  // paid for a separate `ai_vocab_gloss` call that wrote a second, differently
  // worded answer for the same word.
  const fields = cardVocabFields(card({
    context_meaning: {
      summary: "极其仔细、一丝不苟",
      details: ["这里指桌面上的纸张被安排得非常精确，不容打扰。", "比 neatly 更强，带着近乎苛求的认真。"],
    },
  }));
  assert.equal(isShortGloss(fields.gloss), true);
  assert.equal(condenseGloss(fields.gloss), "极其仔细、一丝不苟");
  // The explanation is not lost — it is the long form, in reading order.
  assert.match(fields.contextExplanation ?? "", /^极其仔细、一丝不苟\n这里指/);
});

test("a summary that ignores the contract still fails the fit test", () => {
  // The guard that sends the save down the fallback chain rather than letting
  // a paragraph land above a word.
  assert.equal(
    isShortGloss(cardVocabFields(card({
      context_meaning: { summary: "这里指“极其仔细、一丝不苟地”，形容桌面上的纸张被安排得非常精确、不容打扰。" },
    })).gloss),
    false,
  );
});

test("moduleText flattens a module in the order it is drawn", () => {
  assert.equal(
    moduleText({
      heading: "gregarious · adjective",
      summary: "fond of company",
      details: ["formal-ish"],
      items: [{ title: "flocking", text: "of animals", examples: [{ source: "a gregarious herd", target: "群居的兽群" }] }],
      quote: "A gregarious creature by any measure.",
    }),
    [
      "gregarious · adjective",
      "fond of company",
      "formal-ish",
      "flocking",
      "of animals",
      "a gregarious herd",
      "群居的兽群",
      "A gregarious creature by any measure.",
    ].join("\n"),
  );
  assert.equal(moduleText(undefined), "");
  assert.equal(moduleText({}), "");
});
