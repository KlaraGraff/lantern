import assert from "node:assert/strict";
import test from "node:test";

import { explanationSampleKey } from "../src/components/onboarding/explanation-samples.ts";

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
