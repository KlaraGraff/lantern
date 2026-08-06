import assert from "node:assert/strict";
import test from "node:test";

import {
  CELLULAR_CONSENT_ERROR,
  CELLULAR_CONSENT_SETTING_KEY,
  isCellularConsentError,
} from "../src/hooks/cellular-consent.ts";

// D-016's frontend half of the tri-state gate: `isCellularConsentError` is
// the predicate every catch site uses to decide "was this refusal the
// cellular-consent one, or something else". Mirrors the Rust-side coverage
// in `src-tauri/src/icloud/cellular.rs` (`icloud::cellular::decide`), which
// tests the same tri-state on the backend.

test("recognises the bare error code", () => {
  assert.equal(isCellularConsentError(CELLULAR_CONSENT_ERROR), true);
});

test("recognises the code wrapped in whatever invoke() rejects with", () => {
  // `AppError::Other` serializes as the bare string, but callers pass
  // through `Error` instances, plain strings, and rejection objects alike —
  // the predicate has to work on all of them via `String(error)`.
  assert.equal(isCellularConsentError(new Error(CELLULAR_CONSENT_ERROR)), true);
  assert.equal(isCellularConsentError({ toString: () => CELLULAR_CONSENT_ERROR }), true);
});

test("does not fire on unrelated errors, including other BOOK_* codes", () => {
  assert.equal(isCellularConsentError("BOOK_FILE_MISSING"), false);
  assert.equal(isCellularConsentError(new Error("SYNC_FOLDER_NOT_FOUND")), false);
  assert.equal(isCellularConsentError(null), false);
  assert.equal(isCellularConsentError(undefined), false);
});

test("the setting key matches what the backend module expects", () => {
  // Kept as a literal on both sides (Rust `SETTING_KEY`, TS
  // `CELLULAR_CONSENT_SETTING_KEY`) rather than generated — this test is the
  // tripwire if one side's spelling drifts from the other.
  assert.equal(CELLULAR_CONSENT_SETTING_KEY, "icloud_download_on_cellular");
});
