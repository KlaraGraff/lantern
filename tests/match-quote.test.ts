import assert from "node:assert/strict";
import test from "node:test";

import { MATCH_THRESHOLD, matchQuote } from "../src/pages/reader/matchQuote.ts";

test("an exact hit scores a perfect 1 and reports its own offsets", () => {
  const text = "Before it. The word appears here. After it.";
  const found = matchQuote(text, { exact: "The word appears here." });
  assert.ok(found);
  assert.equal(text.slice(found.start, found.end), "The word appears here.");
  assert.equal(found.score, 1);
});

test("a sentence the renderer spells slightly differently is still found", () => {
  // The extractor wrote a straight apostrophe and dropped the footnote marker
  // the rendered page carries; neither difference should lose the sentence.
  const text = "Nothing here. He said the bank’s vault was empty.¹ Nothing after.";
  const found = matchQuote(text, { exact: "He said the bank's vault was empty." });
  assert.ok(found);
  assert.ok(found.score < 1, "an inexact hit should not claim a perfect score");
  assert.ok(found.score > MATCH_THRESHOLD);
  assert.ok(text.slice(found.start, found.end).includes("vault was empty"));
});

test("two copies of the same sentence are told apart by what surrounds them", () => {
  const text = [
    "The river was cold that morning.",
    "She went to the bank.",
    "Filler that belongs to neither passage sits in between here.",
    "The money was gone by then.",
    "She went to the bank.",
  ].join(" ");
  const second = text.lastIndexOf("She went to the bank.");

  const found = matchQuote(text, {
    exact: "She went to the bank.",
    prefix: "The money was gone by then.",
  });
  assert.ok(found);
  assert.equal(found.start, second);
});

test("the suffix disambiguates just as the prefix does", () => {
  const text = [
    "She went to the bank.",
    "The teller was new.",
    "Filler that belongs to neither passage sits in between here.",
    "She went to the bank.",
    "The current was strong.",
  ].join(" ");
  const second = text.lastIndexOf("She went to the bank.");

  const found = matchQuote(text, {
    exact: "She went to the bank.",
    suffix: "The current was strong.",
  });
  assert.ok(found);
  assert.equal(found.start, second);
});

test("a sentence that is simply not on the page comes back as not found", () => {
  const text = "A chapter about beekeeping, hives, smoke, and patient hands.";
  assert.equal(matchQuote(text, { exact: "The submarine surfaced at dawn." }), null);
});

test("a quote missing its context still anchors — an edge of a chunk has none", () => {
  const text = "Opening line of the section. The sentence we want. And then some more.";
  const found = matchQuote(text, {
    exact: "The sentence we want.",
    prefix: "",
    suffix: "",
  });
  assert.ok(found);
  assert.equal(found.score, 1);
});

test("wrong context costs a match points without throwing it away", () => {
  // A quote whose surroundings do not line up is still the best thing on the
  // page, so it wins — but it must score below the same quote found where the
  // context agrees, or the context contributes nothing to ranking.
  const text = "The river was cold. She went to the bank. The current was strong.";
  const quote = "She went to the bank.";

  const agreeing = matchQuote(text, {
    exact: quote,
    prefix: "The river was cold.",
    suffix: "The current was strong.",
  });
  const disagreeing = matchQuote(text, {
    exact: quote,
    prefix: "Entirely unrelated words about beekeeping and hives.",
    suffix: "More unrelated words about smoke and patient hands.",
  });

  assert.ok(agreeing);
  assert.ok(disagreeing);
  assert.equal(agreeing.start, disagreeing.start);
  assert.ok(disagreeing.score < agreeing.score);
});

test("the position hint separates candidates nothing else can separate", () => {
  const sentence = "She went to the bank.";
  const filler = "Filler that belongs to neither passage sits in between here. ";
  const text = `${sentence} ${filler}${sentence}`;
  const second = text.lastIndexOf(sentence);

  const near = matchQuote(text, { exact: sentence, hint: second });
  assert.ok(near);
  assert.equal(near.start, second);

  const early = matchQuote(text, { exact: sentence, hint: 0 });
  assert.ok(early);
  assert.equal(early.start, 0);
});

test("an empty quote or an empty page is not a match", () => {
  assert.equal(matchQuote("some text", { exact: "" }), null);
  assert.equal(matchQuote("", { exact: "some text" }), null);
});
