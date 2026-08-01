import assert from "node:assert/strict";
import test from "node:test";

import {
  chunkForSynthesis,
  planSources,
  segmentSentences,
  sentenceIndexAt,
  timeSentences,
  type WordTiming,
} from "../src/components/speech/routing.ts";
import {
  DEFAULT_SPEECH_SETTINGS,
  type SpeechSettings,
  type SpeechSourceId,
} from "../src/components/speech/types.ts";

function settings(source: SpeechSourceId): SpeechSettings {
  return { ...DEFAULT_SPEECH_SETTINGS, source };
}

test("automatic asks the dictionary for a word before any synthesizer", () => {
  assert.deepEqual(planSources("word", settings("auto")), ["dictionary", "edge", "system"]);
  assert.deepEqual(planSources("phrase", settings("auto")), ["dictionary", "edge", "system"]);
});

// The corpus holds entries, never paragraphs, so the round trip would be spent
// learning something already known.
test("automatic skips the dictionary for a passage", () => {
  assert.deepEqual(planSources("passage", settings("auto")), ["edge", "system"]);
});

// The custom provider is billed per use. A source picked on the user's behalf
// must never be one that spends their money.
test("automatic never routes to the paid provider", () => {
  for (const kind of ["word", "phrase", "passage"] as const) {
    assert.ok(!planSources(kind, settings("auto")).includes("custom"));
  }
});

test("an explicitly picked source is used, with system voices behind it", () => {
  assert.deepEqual(planSources("passage", settings("edge")), ["edge", "system"]);
  assert.deepEqual(planSources("passage", settings("custom")), ["custom", "system"]);
  assert.deepEqual(planSources("word", settings("dictionary")), ["dictionary", "system"]);
});

// Pinning the dictionary cannot make it read a paragraph it has no audio for.
test("the dictionary source falls straight through for a passage", () => {
  assert.deepEqual(planSources("passage", settings("dictionary")), ["system"]);
});

test("system voices are the last resort of every plan", () => {
  for (const source of ["auto", "dictionary", "system", "edge", "custom"] as const) {
    for (const kind of ["word", "phrase", "passage"] as const) {
      const plan = planSources(kind, settings(source));
      assert.equal(plan.at(-1), "system", `${source}/${kind} ended at ${plan.at(-1)}`);
    }
  }
});

test("sentences are split with their offsets into the source text", () => {
  const text = "The lantern threw its light. The boat came about.";
  const spans = segmentSentences(text);
  assert.equal(spans.length, 2);
  assert.equal(text.slice(spans[0].start, spans[0].end).trim(), "The lantern threw its light.");
  assert.equal(text.slice(spans[1].start, spans[1].end).trim(), "The boat came about.");
});

// Measured against the platform segmenter, which breaks after "Mr." on its own.
// A title splitting off is visible as a flickering highlight and audible when a
// chunk boundary lands there, cutting the audio inside a name.
test("a title does not end a sentence", () => {
  const spans = segmentSentences("Mr. Darcy said nothing. Elizabeth did.");
  assert.equal(spans.length, 2);
  assert.ok(spans[0].text.startsWith("Mr. Darcy"), spans[0].text);
  assert.ok(spans[1].text.startsWith("Elizabeth"), spans[1].text);
});

test("offsets stay usable after a merged title", () => {
  const text = "Mr. Darcy said nothing. Elizabeth did.";
  for (const span of segmentSentences(text)) {
    assert.equal(text.slice(span.start, span.end), span.text);
  }
});

// The platform already gets these right; the merge must not undo that.
test("decimals and lowercase abbreviations are left to the platform", () => {
  assert.equal(segmentSentences("It costs 3.5 dollars. Yes.").length, 2);
  assert.equal(segmentSentences("e.g. this one. And that.").length, 2);
});

// "No." meaning "number" cannot be told apart from someone saying no, so the
// list deliberately omits it rather than merging a real sentence away.
test("a word that can end a sentence is not treated as an abbreviation", () => {
  assert.equal(segmentSentences("I asked and he said no. She left.").length, 2);
});

test("a short text is one chunk, whitespace collapsed", () => {
  assert.deepEqual(chunkForSynthesis("  look   up \n", 2000), ["look up"]);
  assert.deepEqual(chunkForSynthesis("   ", 2000), []);
});

test("chunks respect the cap and never split mid-sentence", () => {
  const sentence = "This is a sentence of a fairly ordinary length. ";
  const text = sentence.repeat(80);
  const chunks = chunkForSynthesis(text, 200);

  assert.ok(chunks.length > 1, "expected the text to be split at all");
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `chunk of ${chunk.length} exceeds the cap`);
    assert.ok(/[.!?]$/u.test(chunk), `chunk does not end a sentence: ${JSON.stringify(chunk)}`);
  }
});

test("chunking loses no words", () => {
  const text = "One. Two two. Three three three. Four four four four. Five.";
  const chunks = chunkForSynthesis(text, 20);
  assert.equal(chunks.join(" "), text);
});

// Refusing to read it at all would be worse than reading it in pieces.
test("a single sentence longer than the cap is split rather than dropped", () => {
  const text = `${"word ".repeat(100)}end.`;
  const chunks = chunkForSynthesis(text, 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 50);
  assert.equal(chunks.join(" "), text.split(/\s+/u).join(" ").trim());
});

test("a word longer than the cap is cut instead of hanging the split", () => {
  const chunks = chunkForSynthesis("a".repeat(120), 50);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 20]);
});

function timing(text: string, offsetMs: number, durationMs = 200): WordTiming {
  return { text, offsetMs, durationMs };
}

test("each sentence starts when its first word is spoken", () => {
  const text = "The lantern threw its light. The boat came about.";
  const timed = timeSentences(text, [
    timing("The", 100),
    timing("lantern", 288),
    timing("threw", 775),
    timing("its", 975),
    timing("light", 1150),
    timing("The", 2487),
    timing("boat", 2675),
    timing("came", 2937),
    timing("about", 3175),
  ]);

  assert.equal(timed.length, 2);
  assert.equal(timed[0].startMs, 100);
  // The second "The" must be matched to the second sentence, not re-matched to
  // the first occurrence — the cursor is what keeps the timeline moving forward.
  assert.equal(timed[1].startMs, 2487);
});

test("the timeline never runs backwards when a word cannot be matched", () => {
  const text = "First one. Second one. Third one.";
  const timed = timeSentences(text, [timing("First", 0), timing("Third", 5000)]);
  const starts = timed.map((sentence) => sentence.startMs);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] >= starts[index - 1], `went backwards: ${starts.join(", ")}`);
  }
});

test("no timings at all still yields one entry per sentence", () => {
  const timed = timeSentences("One. Two. Three.", []);
  assert.equal(timed.length, 3);
  assert.deepEqual(timed.map((sentence) => sentence.startMs), [0, 0, 0]);
});

test("the spoken sentence is found by elapsed time", () => {
  const timed = timeSentences("One. Two. Three.", [
    timing("One", 0),
    timing("Two", 1000),
    timing("Three", 2000),
  ]);

  assert.equal(sentenceIndexAt(timed, 0), 0);
  assert.equal(sentenceIndexAt(timed, 999), 0);
  assert.equal(sentenceIndexAt(timed, 1000), 1, "a boundary belongs to the sentence starting there");
  assert.equal(sentenceIndexAt(timed, 1500), 1);
  assert.equal(sentenceIndexAt(timed, 99_000), 2, "past the end stays on the last sentence");
});

// Playback that has started must always be highlighting something, even if the
// first word's offset is later than the moment the audio began.
test("time before the first sentence highlights the first sentence", () => {
  const timed = timeSentences("One. Two.", [timing("One", 500), timing("Two", 1500)]);
  assert.equal(sentenceIndexAt(timed, 0), 0);
});

test("an empty timeline is safe to query", () => {
  assert.equal(sentenceIndexAt([], 1234), 0);
});
