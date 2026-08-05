import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export const SETTINGS_CHANGED_EVENT = "settings-changed";

/**
 * `null` means the key's row was deleted, not that it was set to an empty
 * string — the two differ, because every reader setting parses `""` as
 * something. The backend expresses the same distinction as a `setting`
 * tombstone; this is its in-app counterpart, so a second open window stops
 * showing a value the row no longer has.
 */
export type SettingsChangedValues = Record<string, string | null>;

export interface SettingsChangedPayload {
  values: SettingsChangedValues;
}

export async function notifySettingsChanged(values: SettingsChangedValues) {
  if (Object.keys(values).length === 0) return;
  await emit(SETTINGS_CHANGED_EVENT, { values } satisfies SettingsChangedPayload);
}

export function listenForSettingsChanged(
  handler: (values: SettingsChangedValues) => void,
): Promise<UnlistenFn> {
  return listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
    handler(event.payload.values);
  });
}

/**
 * Fold a broadcast into a settings map: present keys overwrite, `null` keys are
 * removed. Every listener needs exactly this, and spelling it out three times
 * is how one of them ends up storing the literal `null`.
 */
export function applySettingsChange(
  current: Record<string, string>,
  values: SettingsChangedValues,
): Record<string, string> {
  const next = { ...current };
  for (const [key, value] of Object.entries(values)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
