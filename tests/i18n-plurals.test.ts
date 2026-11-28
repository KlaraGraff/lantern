import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import i18next from "i18next";

const en = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")) as Record<string, string>;

const i18n = i18next.createInstance();
await i18n.init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Issue #17: a single form read "1 books", "1 notes", "1 sessions".
test("English counts read as singular at one and plural otherwise", () => {
  const en1 = (key: string, count: number) => i18n.t(key, { lng: "en", count });
  assert.equal(en1("import.batchFailedCount", 1), "1 book failed to import");
  assert.equal(en1("import.batchFailedCount", 3), "3 books failed to import");
  assert.equal(en1("readingStats.sessionCount", 1), "1 session");
  assert.equal(en1("readingStats.sessionCount", 0), "0 sessions");
  assert.equal(en1("mcpApproval.remaining", 2), "2 more requests waiting");
  assert.equal(en1("vocab.merged.altDefinitions", 1), "1 other definition — different from the one above");
});

test("Chinese, which has no plural, mirrors one text under both suffixes", () => {
  const differing = Object.keys(zh)
    .filter((key) => key.endsWith("_one"))
    .filter((key) => zh[key] !== zh[`${key.slice(0, -"_one".length)}_other`]);
  assert.deepEqual(differing, []);
  assert.equal(i18n.t("import.batchFailedCount", { lng: "zh", count: 1 }), zh["import.batchFailedCount_other"].replace("{{count}}", "1"));
});

// Strings whose count is never below 2 where they are shown, so a single
// plural form is right. Anything else that puts a plural noun after {{count}}
// needs _one/_other.
const neverSingular: Record<string, string> = {
  "vocab.merged.bookCount": "shown only when a word is merged from more than one book",
  "vocab.merged.sourceCount": "shown only when a word is merged from more than one source",
  "vocab.merged.masterySharedHint": "shown only when more than one book shares the word",
  "vocab.merged.masterySharedHintMixed": "shown only when more than one source shares the word",
  "vocab.review.mergedBanner": "shown only when the word was saved in more than one book",
  "vocab.review.mergedBannerMixed": "shown only when the word was saved in more than one place",
  "settings.learner.explanationStyleSample.pointCount": "a fixed 5 or 7",
  "indexManager.aliases.bridgeLeadMany": "two candidates use bridgeLeadTwo",
  "learningCard.memory.repeat": "shown from the second lookup on",
  "reviewBoard.pile.repeatLookupsInBook.reasonSolo": "a solo pile without glances needs at least two cards",
  "reviewBoard.pile.repeatLookupsInBook.reasonSoloMixed": "two counts in one string, passed as text; not covered here",
  "bookDifficulty.why.similar": "needs at least MIN_BASELINE_BOOKS (2) finished books",
  "bookDifficulty.why.harder": "needs at least MIN_BASELINE_BOOKS (2) finished books",
};

test("no English string puts a plural noun after a count that can be one", () => {
  const plural = /\{\{count\}\}\s+(?:[a-z-]+\s+)?[a-z]+s\b|\b(?:these|those)\s+\{\{count\}\}/i;
  const offenders = Object.entries(en)
    .filter(([key]) => !/_(?:zero|one|two|few|many|other)$/.test(key) && !(`${key}_one` in en))
    .filter(([key, value]) => plural.test(value) && !(key in neverSingular))
    .map(([key, value]) => `${key}: ${value}`);
  assert.deepEqual(offenders, []);
});
