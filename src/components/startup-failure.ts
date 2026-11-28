/**
 * Pure pieces of the startup failure page, kept free of React and Tauri so
 * they run under the plain `node:test` runner (see
 * tests/startup-failure.test.ts). The shape mirrors `StartupFailureInfo` in
 * src-tauri/src/startup_failure.rs.
 */

export type FailedStore = "library" | "secrets";
export type FailureReason = "damaged" | "disk_full" | "no_access" | "unknown";

export interface StartupFailureInfo {
  store: FailedStore;
  reason: FailureReason;
  detail: string;
  can_restore: boolean;
}

export type StartupFailureAction = "restore" | "relaunch" | "logs";

const REASON_KEYS: Record<FailureReason, string> = {
  damaged: "damaged",
  disk_full: "diskFull",
  no_access: "noAccess",
  unknown: "unknown",
};

export function startupFailureCopy(info: StartupFailureInfo): { titleKey: string; bodyKey: string } {
  return {
    titleKey: `startupFailure.${info.store}.title`,
    bodyKey: `startupFailure.${info.store}.${REASON_KEYS[info.reason] ?? "unknown"}`,
  };
}

/**
 * The recommended action first — the page fills only the first button. A
 * damaged library is what 从备份恢复 is for; a full disk or a permission
 * problem is fixed outside Lantern, so reopening comes first there.
 */
export function startupFailureActions(info: StartupFailureInfo): StartupFailureAction[] {
  if (!info.can_restore) return ["relaunch", "logs"];
  if (info.reason === "disk_full" || info.reason === "no_access") return ["relaunch", "restore", "logs"];
  return ["restore", "relaunch", "logs"];
}
