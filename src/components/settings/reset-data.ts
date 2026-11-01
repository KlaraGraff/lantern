/**
 * Pure pieces of 重置全部数据, kept free of React and Tauri so they run under
 * the plain `node:test` runner (see tests/reset-data.test.ts).
 */

/** Typed the same in every interface language, by design of the spec. */
export const RESET_CONFIRMATION_WORD = "RESET";

/** Exact word, case-sensitive; surrounding whitespace from a paste is forgiven. */
export function isResetConfirmed(typed: string): boolean {
  return typed.trim() === RESET_CONFIRMATION_WORD;
}

export interface ResetDataSummary {
  bookCount: number;
  syncEnabled: boolean;
}

export type ResetStep = "closed" | "explain" | "confirm" | "resetting";

/**
 * Run the reset in the only order that cannot leave the reader stranded:
 * the backend marks the data for wiping first, and only once that has
 * succeeded is the webview's own storage cleared and the app relaunched.
 * A failure in `request` therefore leaves everything — including UI
 * preferences in localStorage — exactly as it was.
 */
export async function runReset(deps: {
  request: () => Promise<void>;
  clearWebStorage: () => void;
  relaunch: () => Promise<void>;
}): Promise<"relaunching" | "request-failed" | "relaunch-failed"> {
  try {
    await deps.request();
  } catch {
    return "request-failed";
  }
  try {
    deps.clearWebStorage();
  } catch {
    // Storage can be unavailable; the backend wipe is what matters.
  }
  try {
    await deps.relaunch();
  } catch {
    return "relaunch-failed";
  }
  return "relaunching";
}
