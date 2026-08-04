import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePassiveVocabSettings,
  passiveVocabCount,
  passiveVocabLabel,
  rollbackPassiveVocabSettings,
  selectPassiveVocab,
  shouldShowPassiveVocab,
  updatePassiveVocabSettings,
} from "../src/components/passive-vocab.ts";

test("passive vocabulary settings default safely and accept only known choices", () => {
  assert.deepEqual(parsePassiveVocabSettings({}), { enabled: false, style: "ruby", density: "medium" });
  assert.deepEqual(parsePassiveVocabSettings({
    passive_vocab_enabled: "true",
    passive_vocab_style: "margin",
    passive_vocab_density: "high",
  }), { enabled: true, style: "margin", density: "high" });
});

test("passive vocabulary density deterministically prioritises active learning over CFI order", () => {
  const words = [
    { cfi: "epubcfi(/6/2)", mastery: "mastered", definition: "finished learning" },
    { cfi: "epubcfi(/6/6)", mastery: "new", definition: "unseen" },
    { cfi: "epubcfi(/6/4)", mastery: "learning", definition: "active practice" },
    { cfi: "epubcfi(/6/8)", mastery: "learning", definition: "second active word" },
  ];
  assert.equal(passiveVocabLabel("to move gradually toward"), "to move gradual…");
  assert.equal(passiveVocabCount(words.length, "low"), 1);
  assert.deepEqual([...selectPassiveVocab(words, "low")], ["epubcfi(/6/4)"]);
  assert.deepEqual([...selectPassiveVocab(words, "medium")], ["epubcfi(/6/4)", "epubcfi(/6/8)"]);
  assert.deepEqual([...selectPassiveVocab(words, "high")], [
    "epubcfi(/6/4)", "epubcfi(/6/8)", "epubcfi(/6/6)", "epubcfi(/6/2)",
  ]);
  const selected = selectPassiveVocab(words, "low");
  assert.equal(shouldShowPassiveVocab("epubcfi(/6/4)", "low", selected), true);
  assert.equal(shouldShowPassiveVocab("epubcfi(/6/2)", "low", selected), false);
});

test("optimistic settings writes roll back only the failed state, never a newer edit", () => {
  const original = { enabled: false, style: "ruby" as const, density: "medium" as const };
  const enable = updatePassiveVocabSettings(original, { enabled: true });
  assert.deepEqual(enable.values, {
    passive_vocab_enabled: "true",
    passive_vocab_style: "ruby",
    passive_vocab_density: "medium",
  });
  assert.deepEqual(rollbackPassiveVocabSettings(enable.next, enable), original);
  const newer = { ...enable.next, style: "margin" as const };
  assert.deepEqual(rollbackPassiveVocabSettings(newer, enable), newer);
});
