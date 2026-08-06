import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_ANALYSIS_INTRO_KEY,
  ONBOARDING_STATE_KEY,
  ONBOARDING_DONE,
  afterAdvance,
  shouldIntroduceAutoAnalysis,
  groupBookSources,
  isAiConfigured,
  isCefrLevelUnset,
  shouldShowOnboarding,
} from "../src/components/onboarding/onboarding-state.ts";
import { DEFAULT_CEFR_LEVEL, resolveInitialCefrLevel } from "../src/components/settings/cefr.ts";
import { BUILT_IN_BOOK_SOURCES } from "../src/components/book-sources.ts";

test("the card shows for a fresh install and stays hidden once done", () => {
  assert.ok(shouldShowOnboarding({}));
  assert.ok(shouldShowOnboarding({ [ONBOARDING_STATE_KEY]: "" }));
  assert.ok(shouldShowOnboarding({ [ONBOARDING_STATE_KEY]: "garbage" }));
  assert.ok(!shouldShowOnboarding({ [ONBOARDING_STATE_KEY]: ONBOARDING_DONE }));
});

test("B1 is the default level when nothing has been chosen yet", () => {
  assert.equal(DEFAULT_CEFR_LEVEL, "B1");
  assert.equal(resolveInitialCefrLevel({}), "B1");
  assert.equal(resolveInitialCefrLevel({ cefr_level: "" }), "B1");
  // A junk value (never written by this app, but defensive) also falls back.
  assert.equal(resolveInitialCefrLevel({ cefr_level: "not-a-level" }), "B1");
  // An explicit prior choice always wins over the default.
  assert.equal(resolveInitialCefrLevel({ cefr_level: "C1" }), "C1");
});

test("skip and next both advance one step, and step 3 always finishes onboarding", () => {
  assert.equal(afterAdvance(1), 2);
  assert.equal(afterAdvance(2), 3);
  assert.equal(afterAdvance(3), "done");
});

test("the CEFR-unset signal only looks at whether a level was ever confirmed", () => {
  assert.ok(isCefrLevelUnset({}));
  assert.ok(isCefrLevelUnset({ cefr_level: "" }));
  assert.ok(!isCefrLevelUnset({ cefr_level: "B1" }));
});

test("AI counts as configured only with an enabled, valid key on an enabled profile", () => {
  const enabledProfile = { id: "p1", enabled: true };
  const disabledProfile = { id: "p2", enabled: false };

  // No credentials at all — an enabled profile alone is not enough, unlike
  // the backend's own `ai_active_profile` check.
  assert.ok(!isAiConfigured([enabledProfile], []));

  // A credential that failed its last test does not count, even if enabled.
  assert.ok(!isAiConfigured(
    [enabledProfile],
    [{ profile_id: "p1", enabled: true, state: "invalid" }],
  ));

  // A disabled credential does not count.
  assert.ok(!isAiConfigured(
    [enabledProfile],
    [{ profile_id: "p1", enabled: false, state: "active" }],
  ));

  // A valid credential on a disabled profile does not count.
  assert.ok(!isAiConfigured(
    [disabledProfile],
    [{ profile_id: "p2", enabled: true, state: "active" }],
  ));

  // The one case that does count.
  assert.ok(isAiConfigured(
    [enabledProfile],
    [{ profile_id: "p1", enabled: true, state: "active" }],
  ));
});

test("book sources split into the library group before the third-party group", () => {
  const { library, thirdParty } = groupBookSources(BUILT_IN_BOOK_SOURCES);
  assert.ok(library.every((source) => source.kind === "library"));
  assert.ok(thirdParty.every((source) => source.kind === "thirdParty"));
  assert.equal(library.length + thirdParty.length, BUILT_IN_BOOK_SOURCES.length);
  // Z-Library leads the third-party group, per the product decision baked
  // into the built-in catalog itself.
  assert.equal(thirdParty[0]?.id, "builtin:zlibrary");

  // Order within a group survives even when the source list is shuffled —
  // grouping must key off `kind`, not off position in the list.
  const shuffled = [...BUILT_IN_BOOK_SOURCES].reverse();
  const regrouped = groupBookSources(shuffled);
  assert.deepEqual(regrouped.library.map((s) => s.id), [...library].reverse().map((s) => s.id));
});

test("what runs on its own is disclosed once, by whichever surface gets there first", () => {
  assert.ok(shouldIntroduceAutoAnalysis({}));
  assert.ok(shouldIntroduceAutoAnalysis({ [AUTO_ANALYSIS_INTRO_KEY]: "" }));
  // The onboarding step and the AI settings pane both read this one key, so
  // the reader is told exactly once no matter which of them said it.
  assert.ok(!shouldIntroduceAutoAnalysis({ [AUTO_ANALYSIS_INTRO_KEY]: "true" }));
});

test("the fourth step is not something you can advance into", () => {
  // It is reached only by *completing* the AI step. Skipping step 3 ends
  // onboarding, which is what keeps the disclosure away from someone who
  // configured no service and therefore has no quota to spend.
  assert.equal(afterAdvance(3), "done");
  assert.equal(afterAdvance(4), "done");
});
