import assert from "node:assert/strict";
import test from "node:test";

import {
  explanationSampleKey,
  recommendedExplanationMode,
  storedExplanationMode,
} from "../src/components/onboarding/explanation-samples.ts";

test("chinese mode always uses the fixed Chinese sample", () => {
  assert.equal(explanationSampleKey("chinese", "A1"), "onboarding.step1.sampleChinese");
  assert.equal(explanationSampleKey("chinese", "C2"), "onboarding.step1.sampleChinese");
});

test("adaptive_bilingual mode always uses the fixed bilingual sample", () => {
  assert.equal(explanationSampleKey("adaptive_bilingual", "A1"), "onboarding.step1.sampleBilingual");
  assert.equal(explanationSampleKey("adaptive_bilingual", "C2"), "onboarding.step1.sampleBilingual");
});

test("english_by_level bands A1/A2 as beginner", () => {
  assert.equal(explanationSampleKey("english_by_level", "A1"), "onboarding.step1.sampleEnglishBeginner");
  assert.equal(explanationSampleKey("english_by_level", "A2"), "onboarding.step1.sampleEnglishBeginner");
});

test("english_by_level bands B1/B2 as mid", () => {
  assert.equal(explanationSampleKey("english_by_level", "B1"), "onboarding.step1.sampleEnglishMid");
  assert.equal(explanationSampleKey("english_by_level", "B2"), "onboarding.step1.sampleEnglishMid");
});

test("english_by_level bands C1/C2 as advanced", () => {
  assert.equal(explanationSampleKey("english_by_level", "C1"), "onboarding.step1.sampleEnglishAdvanced");
  assert.equal(explanationSampleKey("english_by_level", "C2"), "onboarding.step1.sampleEnglishAdvanced");
});

test("the recommendation climbs with the level, on a Chinese interface", () => {
  assert.equal(recommendedExplanationMode("A1", "zh"), "chinese");
  assert.equal(recommendedExplanationMode("A2", "zh"), "chinese");
  assert.equal(recommendedExplanationMode("B1", "zh"), "chinese");
  assert.equal(recommendedExplanationMode("B2", "zh"), "adaptive_bilingual");
  assert.equal(recommendedExplanationMode("C1", "zh"), "english_by_level");
  assert.equal(recommendedExplanationMode("C2", "zh"), "english_by_level");
});

test("a non-Chinese interface never lands on the all-Chinese rung", () => {
  assert.equal(recommendedExplanationMode("A1", "en"), "adaptive_bilingual");
  assert.equal(recommendedExplanationMode("B1", "en"), "adaptive_bilingual");
  assert.equal(recommendedExplanationMode("B2", "en"), "adaptive_bilingual");
  // The top of the ladder is the level's call, not the interface's.
  assert.equal(recommendedExplanationMode("C1", "en"), "english_by_level");
  assert.equal(recommendedExplanationMode("C2", "en"), "english_by_level");
});

test("regional Chinese tags still read as Chinese", () => {
  assert.equal(recommendedExplanationMode("B1", "zh-CN"), "chinese");
  assert.equal(recommendedExplanationMode("B1", "zh-TW"), "chinese");
});

test("storedExplanationMode only trusts the three real values", () => {
  assert.equal(storedExplanationMode("chinese"), "chinese");
  assert.equal(storedExplanationMode("adaptive_bilingual"), "adaptive_bilingual");
  assert.equal(storedExplanationMode("english_by_level"), "english_by_level");
  assert.equal(storedExplanationMode(undefined), null);
  assert.equal(storedExplanationMode(""), null);
  assert.equal(storedExplanationMode("bilingual"), null);
});
