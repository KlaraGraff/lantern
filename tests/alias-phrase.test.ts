import assert from "node:assert/strict";
import test from "node:test";

import { referringPhrase } from "../src/components/alias-phrase.ts";

test("keeps only the demonstrative and the noun after it", () => {
  assert.equal(referringPhrase("那个牧师后来娶了谁？"), "那个牧师");
  assert.equal(referringPhrase("那个牧师娶了谁"), "那个牧师");
  assert.equal(referringPhrase("这位上校和达西是什么关系"), "这位上校");
  assert.equal(referringPhrase("那位夫人是谁"), "那位夫人");
});

test("keeps a description that runs through 的 up to where the question starts", () => {
  assert.equal(referringPhrase("那个总在拍马屁的牧师为什么来访？"), "那个总在拍马屁的牧师");
  assert.equal(referringPhrase("那个很高傲的有钱人最后怎么样了"), "那个很高傲的有钱人");
});

test("keeps a possessive in front of the demonstrative", () => {
  assert.equal(referringPhrase("伊丽莎白的那个表哥呢"), "伊丽莎白的那个表哥");
});

test("falls back to the question, minus trailing punctuation, without a demonstrative", () => {
  assert.equal(referringPhrase("牧师后来娶了谁？"), "牧师后来娶了谁");
  assert.equal(referringPhrase("  Who did the clergyman marry? "), "Who did the clergyman marry");
});

test("falls back when nothing follows the demonstrative", () => {
  assert.equal(referringPhrase("就是那个？"), "就是那个");
});
