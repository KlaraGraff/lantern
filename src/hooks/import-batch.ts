/**
 * Pure decision logic for turning a dialog import batch's raw failures into
 * what the UI should say, kept free of React/i18n so it can run under the
 * plain `node:test` runner the rest of this repo's unit tests use (see
 * tests/import-batch.test.ts) — there is no component-rendering harness
 * here, so anything that needs a unit test has to be extractable like this.
 *
 * Callers own the actual wording (via i18n); this only decides which shape
 * of message applies.
 */

import type { ImportFailure } from "./useBooks";

export type ImportFailureKind = "none" | "singleFailure" | "batchFailure";

export interface ImportFailureSummary {
  kind: ImportFailureKind;
  /** Populated only for `"singleFailure"` — that one file's own error text,
   * unchanged from what a lone import has always shown. */
  message: string | null;
  failedCount: number;
}

/**
 * A file picker that only ever returned one file could only ever fail one
 * way, so today's single-import error banner just shows that file's own
 * message verbatim — no count, no list. Multi-select keeps that exact
 * behavior for the (still overwhelmingly common) case of one bad file, and
 * only switches to a count once there is more than one failure to report —
 * showing every message stacked would be noise no reader wants to parse.
 */
export function summarizeImportFailures(failures: readonly ImportFailure[]): ImportFailureSummary {
  if (failures.length === 0) return { kind: "none", message: null, failedCount: 0 };
  if (failures.length === 1) {
    return { kind: "singleFailure", message: failures[0].error, failedCount: 1 };
  }
  return { kind: "batchFailure", message: null, failedCount: failures.length };
}
