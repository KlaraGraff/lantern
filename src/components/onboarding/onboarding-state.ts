/**
 * Pure decision logic for the first-launch onboarding card, kept free of
 * React and Tauri so it can run under the plain `node:test` runner the rest
 * of this repo's unit tests use (see tests/onboarding-state.test.ts) — there
 * is no component-rendering harness here, so anything that needs a unit test
 * has to be extractable like this.
 */

import type { BookSource } from "../book-sources";

/** A single settings key, `"done"` once the card has been completed or
 * skipped in full. Any other value (including absent/empty) means "show it."
 * There is no dedicated "unset a setting" command, so replaying onboarding
 * writes back an empty string rather than deleting the key. */
export const ONBOARDING_STATE_KEY = "onboarding_state";
export const ONBOARDING_DONE = "done";

export function shouldShowOnboarding(settings: Record<string, string>): boolean {
  return settings[ONBOARDING_STATE_KEY] !== ONBOARDING_DONE;
}

export type OnboardingStep = 1 | 2 | 3 | 4;

/**
 * Both "Next" and "Skip" move to the same next step — skipping only omits
 * that step's save, it never abandons the whole card. Finishing step 3 either
 * way reaches `"done"`. This is the one transition rule every step's footer
 * button drives, so it is tested once here instead of once per button.
 *
 * Step 4 is not on this path. It is reached only by *completing* step 3, not
 * by advancing past it — see `shouldIntroduceAutoAnalysis`.
 */
export function afterAdvance(step: OnboardingStep): OnboardingStep | "done" {
  return step >= 3 ? "done" : ((step + 1) as OnboardingStep);
}

/** Written once the reader has been told what runs on its own. */
export const AUTO_ANALYSIS_INTRO_KEY = "auto_analysis_intro_shown";

/**
 * Whether the auto-analysis disclosure still needs showing.
 *
 * It is said once and never again. Two surfaces can be the one to say it —
 * the last onboarding step, and the AI settings pane the moment a service
 * first connects there — and both consult this, so whichever happens first
 * retires the other. Someone who skips the AI step never sees it from
 * either place: with no service configured there is no quota to spend, and
 * a disclosure about spending nothing is noise.
 */
export function shouldIntroduceAutoAnalysis(settings: Record<string, string>): boolean {
  return settings[AUTO_ANALYSIS_INTRO_KEY] !== "true";
}

/** `cefr_level` is never seeded by the backend, so its absence in settings
 * reliably means the person has never confirmed an English level — distinct
 * from having chosen one and it happening to still be the default. */
export function isCefrLevelUnset(settings: Record<string, string>): boolean {
  return !settings.cefr_level;
}

export interface AiProfileLike {
  id: string;
  enabled: boolean;
}

export interface AiCredentialLike {
  profile_id: string;
  enabled: boolean;
  state: string;
}

/**
 * `ai_active_profile` on the backend only requires an *enabled profile row*
 * to exist — it does not check that the profile has a working credential. A
 * profile can be enabled with zero credentials, or with only credentials
 * that failed their last test (`state === "invalid"`), and still count as
 * "active" there. For onboarding and the library hint, "configured" has to
 * mean something a person can actually use: at least one enabled, non-invalid
 * credential attached to an enabled profile.
 */
export function isAiConfigured(profiles: AiProfileLike[], credentials: AiCredentialLike[]): boolean {
  const enabledProfileIds = new Set(profiles.filter((profile) => profile.enabled).map((profile) => profile.id));
  return credentials.some(
    (credential) =>
      credential.enabled
      && credential.state !== "invalid"
      && enabledProfileIds.has(credential.profile_id),
  );
}

/** The mockup's two book-source groups, in the mockup's order: free/public
 * sources first, third-party archives second. Grouping by `kind` rather than
 * relying on list order, because a user-added source can land anywhere. */
export function groupBookSources(sources: readonly BookSource[]): {
  library: BookSource[];
  thirdParty: BookSource[];
} {
  return {
    library: sources.filter((source) => source.kind === "library"),
    thirdParty: sources.filter((source) => source.kind === "thirdParty"),
  };
}
