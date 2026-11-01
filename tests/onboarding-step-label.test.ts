import assert from "node:assert/strict";
import test from "node:test";

import { onboardingProgressLabel } from "../src/components/onboarding/onboarding-state.ts";

// The onboarding card grew a fourth step (the auto-analysis disclosure) without
// teaching its header about it. `onboarding.progress.stepOf` counts a fixed
// three, so a `stepOf` for step 4 renders "Step 4 of 3".
test("the auto-analysis step does not report itself as step 4 of a three-step card", () => {
  assert.deepEqual(onboardingProgressLabel(4, "steps"), { key: "onboarding.progress.last" });
});

test("the three setup steps keep their labels", () => {
  assert.deepEqual(onboardingProgressLabel(1, "steps"), { key: "onboarding.progress.stepOf", step: 1 });
  assert.deepEqual(onboardingProgressLabel(2, "steps"), { key: "onboarding.progress.stepOf", step: 2 });
  assert.deepEqual(onboardingProgressLabel(3, "steps"), { key: "onboarding.progress.last" });
  assert.deepEqual(onboardingProgressLabel(3, "review"), { key: "onboarding.progress.done" });
});

// `resolve()` in the backend lowercases both sides before matching, so two
// aliases that differ only in case address the same text. The ambiguity list
// bucketed on the literal string, so exactly that pair was never flagged.
