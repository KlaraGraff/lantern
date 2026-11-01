import assert from "node:assert/strict";
import test from "node:test";

import { onboardingProgressLabel } from "../src/components/onboarding/onboarding-state.ts";
import { aliasAmbiguities, ambiguousAliasSet } from "../src/components/person-aliases.ts";

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
test("an alias spelled in two cases is still one ambiguous alias", () => {
  const rows = [
    {
      canonical: "Elizabeth",
      names: [{ id: "n1", alias: "Lizzy", source: "auto" as const, mentions: 30, kind: "name" as const, sourceQuery: null }],
      descriptions: [],
    },
    {
      canonical: "Charlotte",
      names: [{ id: "n2", alias: "lizzy", source: "user" as const, mentions: 5, kind: "name" as const, sourceQuery: null }],
      descriptions: [],
    },
  ];
  const ambiguities = aliasAmbiguities(rows);
  assert.equal(ambiguities.length, 1, `got ${JSON.stringify(ambiguities)}`);
  assert.deepEqual(
    ambiguities[0].candidates.map((candidate) => candidate.canonical),
    ["Elizabeth", "Charlotte"],
  );
  // One bridge card, anchored on the spelling the first row used; the chip the
  // card is reachable from is that same spelling.
  assert.deepEqual([...ambiguousAliasSet(ambiguities)], ["Lizzy"]);
});
