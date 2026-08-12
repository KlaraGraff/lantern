import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskWord, wordForms } from "../src/quiz/prompts.ts";

// 迁自 labs/cijuan/src/llm/maskword.test.ts（vitest → node:test）。
// 这些用例来自审查实测出的漏遮/误遮反例，回归护栏。

describe("maskWord", () => {
  it("遮住去 e 加 ing 的形态（allocate → allocating）", () => {
    assert.equal(
      maskWord("They are allocating funds; half is allocated.", "allocate"),
      "They are ████ funds; half is ████.",
    );
  });

  it("遮住辅音+y 变形（vary → varies / varied）", () => {
    assert.equal(
      maskWord("Results vary; the outcome varies and has varied.", "vary"),
      "Results ████; the outcome ████ and has ████.",
    );
  });

  it("不误遮形近但无关的词（art 不遮 article / artist）", () => {
    assert.equal(
      maskWord("The article by the artist explores art.", "art"),
      "The article by the artist explores ████.",
    );
  });

  it("不误遮共享前缀的词（run 不遮 runway / rural）", () => {
    assert.equal(maskWord("They run a rural runway.", "run"), "They ████ a rural runway.");
  });

  it("遮双写尾字母形态（run → running）", () => {
    assert.equal(maskWord("He keeps running daily.", "run"), "He keeps ████ daily.");
  });

  it("大小写不敏感", () => {
    assert.equal(
      maskWord("Subsidy matters. The subsidies grew.", "subsidy"),
      "████ matters. The ████ grew.",
    );
  });
});

describe("wordForms", () => {
  it("包含原形与常见屈折", () => {
    const forms = wordForms("allocate");
    assert.ok(forms.includes("allocate"));
    assert.ok(forms.includes("allocated"));
    assert.ok(forms.includes("allocating"));
    assert.ok(forms.includes("allocates"));
  });

  it("词组：首词屈折（动词短语）与尾词屈折（名词短语）都覆盖", () => {
    const phrasal = wordForms("take over");
    assert.ok(phrasal.includes("take over"));
    assert.ok(phrasal.includes("takes over"));
    assert.ok(phrasal.includes("taking over"));
    const noun = wordForms("climate change");
    assert.ok(noun.includes("climate changes"));
  });
});

describe("maskWord · 词组", () => {
  it("整体遮住词组及其屈折，不遮成员单词单独出现", () => {
    assert.equal(
      maskWord("He takes over the firm; we take a break.", "take over"),
      "He ████ the firm; we take a break.",
    );
  });

  it("遮住固定搭配（in particular）", () => {
    assert.equal(
      maskWord("Cities, in particular, suffer most.", "in particular"),
      "Cities, ████, suffer most.",
    );
  });
});
