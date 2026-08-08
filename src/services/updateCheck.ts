import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * Settings key: the version number the reader last dismissed from the
 * launch-time update toast.
 *
 * Version-keyed, not a boolean flag. A flag can only mean "a toast has been
 * shown and dismissed" — once set, there is no way back to "show the next
 * one", so the very next real release would stay silent forever too. Storing
 * the version means dismissing v2.1.0 goes quiet only for v2.1.0; a
 * subsequently released v2.2.0 compares unequal and prompts again.
 */
export const DISMISSED_UPDATE_VERSION_KEY = "dismissed_update_version";

export type UpdateCheckResult =
  | { status: "available"; update: Update }
  | { status: "upToDate" }
  | { status: "error" };

/**
 * The one place that calls into the updater plugin. `UpdateToast` (launch
 * check and the macOS menu item) and the Settings "Check for Updates" row
 * both call through here, so the two entry points can never end up answering
 * the same question two different ways.
 */
export async function runUpdateCheck(): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    return update ? { status: "available", update } : { status: "upToDate" };
  } catch (error) {
    console.error("Update check failed:", error);
    return { status: "error" };
  }
}

/**
 * Whether a launch-time (non-manual) check should stay silent for the given
 * available version, because the reader already dismissed exactly this one.
 *
 * A manual check — the menu item or the Settings row — always answers for
 * real: someone who explicitly asked "is there an update" gets a real
 * answer, including "yes, the one you dismissed before."
 */
export function shouldSuppressAutoPrompt(
  manual: boolean,
  latestVersion: string,
  dismissedVersion: string | null | undefined,
): boolean {
  if (manual) return false;
  return dismissedVersion === latestVersion;
}
