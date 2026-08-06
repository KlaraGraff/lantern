/**
 * D-016's pure frontend logic — the error code, the settings key, and the
 * predicate that tells a `diagnoseBookFile` catch site whether the rejection
 * was the cellular-consent refusal. Kept free of React/i18n (same reasoning
 * as `import-batch.ts`) so it can run under the plain `node:test` runner:
 * `useBooks.ts` transitively imports `../i18n`, which is a directory import
 * Node's ESM loader won't resolve outside of Vite, so anything reachable
 * from a unit test has to live off that chain.
 *
 * `useBooks.ts` re-exports these so existing callers keep one import site.
 */

/**
 * D-016's refusal code: `diagnose_book_file` returns this instead of
 * starting a watched download when the connection is cellular and there is
 * no remembered answer (or the remembered answer is "no"). Mirrors
 * `icloud::cellular::ERROR_NEEDS_CELLULAR_CONSENT` in
 * `src-tauri/src/icloud/cellular.rs`.
 */
export const CELLULAR_CONSENT_ERROR = "BOOK_DOWNLOAD_NEEDS_CELLULAR_CONSENT";

/**
 * `invoke` rejections serialize `AppError::Other` as the bare code string
 * (see `src-tauri/src/error.rs`), so the match is a substring check against
 * whatever the rejection stringifies to — the same `error?.includes("CODE")`
 * pattern `LibrarySyncSettings.tsx` already uses for its own sync error codes.
 */
export function isCellularConsentError(error: unknown): boolean {
  return String(error).includes(CELLULAR_CONSENT_ERROR);
}

/** The tri-state answer D-016 remembers, in `settings` under this key. */
export const CELLULAR_CONSENT_SETTING_KEY = "icloud_download_on_cellular";
export type CellularDownloadConsent = "ask" | "allow" | "deny";
