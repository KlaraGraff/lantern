import assert from "node:assert/strict";
import test from "node:test";

import { DISMISSED_UPDATE_VERSION_KEY, shouldSuppressAutoPrompt } from "../src/services/updateCheck.ts";

// Regression coverage for the "update toast nags on every launch" bug: the
// dismiss action used to update nothing but local React state, so the very
// next launch re-ran the same check and showed the same toast again, forever.
// `shouldSuppressAutoPrompt` is the fix's whole decision — version-keyed, not
// a boolean, so dismissing one release cannot silence the next one too.

test("a launch check stays silent for a version already dismissed", () => {
  assert.equal(shouldSuppressAutoPrompt(false, "2.13.0", "2.13.0"), true);
});

test("a launch check still prompts when nothing has been dismissed", () => {
  assert.equal(shouldSuppressAutoPrompt(false, "2.13.0", null), false);
  assert.equal(shouldSuppressAutoPrompt(false, "2.13.0", undefined), false);
});

test("a newer version than the one dismissed prompts again", () => {
  // Reader dismissed 2.13.0; 2.14.0 ships later and must not stay silent
  // just because *some* version was dismissed before.
  assert.equal(shouldSuppressAutoPrompt(false, "2.14.0", "2.13.0"), false);
});

test("a manual check always answers, dismissed or not", () => {
  assert.equal(shouldSuppressAutoPrompt(true, "2.13.0", "2.13.0"), false);
  assert.equal(shouldSuppressAutoPrompt(true, "2.13.0", null), false);
});

test("the setting key stays a literal — a drift here would silently break persistence", () => {
  assert.equal(DISMISSED_UPDATE_VERSION_KEY, "dismissed_update_version");
});
