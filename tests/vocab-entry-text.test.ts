import assert from "node:assert/strict";
import test from "node:test";

import {
  entryClipboardText,
  glossOf,
  parseDefinition,
  truncateMiddle,
} from "../src/components/vocab/entry-text.ts";
import type { DictionaryWord } from "../src/hooks/useDictionary.ts";

function word(overrides: Partial<DictionaryWord> = {}): DictionaryWord {
  return {
    id: "1",
    book_id: "b1",
    word: "recounted",
    definition: "",
    context_sentence: null,
    context_explanation: null,
    cfi: null,
    mastery: "new",
    review_count: 0,
    next_review_at: null,
    review_interval_days: 0,
    last_reviewed_at: null,
    last_review_rating: null,
    created_at: 0,
    updated_at: 0,
    book_title: null,
    ...overrides,
  };
}

test("short titles are left alone", () => {
  assert.equal(truncateMiddle("Embracing Hope"), "Embracing Hope");
});

// The tail of a title is often what distinguishes it from its siblings, so it
// must survive truncation.
test("long titles keep both ends", () => {
  const result = truncateMiddle("Man's Search for Meaning and Other Essays", 20);
  assert.ok(result.length <= 20, result);
  assert.ok(result.startsWith("Man's"), result);
  assert.ok(result.endsWith("Essays"), result);
  assert.ok(result.includes("…"), result);
});

test("a leading phonetic is stripped from the definition", () => {
  const { pronunciation, definition } = parseDefinition("/rɪˈkaʊntɪd/ verb. 讲述、叙述");
  assert.equal(pronunciation, "/rɪˈkaʊntɪd/");
  // The play button already covers pronunciation; the row should show a gloss.
  assert.equal(definition, "讲述、叙述");
});

test("a definition without a phonetic is untouched", () => {
  const { pronunciation, definition } = parseDefinition("讲述、叙述");
  assert.equal(pronunciation, null);
  assert.equal(definition, "讲述、叙述");
});

test("paragraphs after the first are preserved", () => {
  const { definition } = parseDefinition("/x/ noun. 讲述\n\n更多说明");
  assert.equal(definition, "讲述\n\n更多说明");
});

test("the gloss is the first meaningful line, without markdown markers", () => {
  assert.equal(glossOf("## 讲述、叙述\n更多"), "讲述、叙述");
  assert.equal(glossOf("\n\n- 讲述"), "讲述");
  assert.equal(glossOf(""), "");
});

// Words saved from the selection menu store an empty definition, so the row has
// to degrade to just the word rather than rendering an empty gloss.
test("an empty definition yields an empty gloss", () => {
  assert.equal(glossOf(parseDefinition("").definition), "");
});

test("copying an entry includes the expanded content, not just the row", () => {
  const text = entryClipboardText(
    word({
      definition: "/x/ verb. 讲述、叙述",
      context_sentence: "he recounted his experiences",
      context_explanation: "此处指复述经历",
    }),
    "Embracing Hope",
  );
  assert.ok(text.includes("recounted"));
  assert.ok(text.includes("讲述、叙述"));
  assert.ok(text.includes('"he recounted his experiences"'));
  assert.ok(text.includes("此处指复述经历"));
  assert.ok(text.includes("Embracing Hope"));
  // The phonetic was parsed off, so it should not reappear in the clipboard.
  assert.ok(!text.includes("/x/"));
});

test("copying an entry skips sections that have no content", () => {
  const text = entryClipboardText(word(), "Embracing Hope");
  assert.equal(text, "recounted\n\nEmbracing Hope");
});
