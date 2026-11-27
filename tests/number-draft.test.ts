import assert from "node:assert/strict";
import test from "node:test";

import { acceptedNumberDraft } from "../src/components/settings/number-draft.ts";

// Settings → Reading → font size is 12–48px. Typing a new size means passing
// through drafts the range rejects, and those must not stop the next digit.
test("typing 24 into the 12–48 font size field gets there through a rejected '2'", () => {
  const typed = ["2", "24"].map((raw) => acceptedNumberDraft(raw, 12, 48));
  assert.deepEqual(typed, [null, 24]);
});

test("a draft outside the range or not a number is not a value", () => {
  assert.equal(acceptedNumberDraft("99", 12, 48), null);
  assert.equal(acceptedNumberDraft("-", -5, 20), null);
  assert.equal(acceptedNumberDraft("abc", 0, 30), null);
});

// An emptied margins field used to become Number("") === 0 and be saved as 0%.
test("an emptied field is a draft, not zero", () => {
  assert.equal(acceptedNumberDraft("", 0, 30), null);
  assert.equal(acceptedNumberDraft("  ", 0, 30), null);
});

test("values at the bounds, negatives and decimals are accepted", () => {
  assert.equal(acceptedNumberDraft("12", 12, 48), 12);
  assert.equal(acceptedNumberDraft("48", 12, 48), 48);
  assert.equal(acceptedNumberDraft("-3", -5, 20), -3);
  assert.equal(acceptedNumberDraft("1.5", 1, 3), 1.5);
});
