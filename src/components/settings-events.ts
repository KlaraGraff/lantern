import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

export const SETTINGS_CHANGED_EVENT = "settings-changed";

export interface SettingsChangedPayload {
  values: Record<string, string>;
}

export async function notifySettingsChanged(values: Record<string, string>) {
  if (Object.keys(values).length === 0) return;
  await emit(SETTINGS_CHANGED_EVENT, { values } satisfies SettingsChangedPayload);
}

export function listenForSettingsChanged(
  handler: (values: Record<string, string>) => void,
): Promise<UnlistenFn> {
  return listen<SettingsChangedPayload>(SETTINGS_CHANGED_EVENT, (event) => {
    handler(event.payload.values);
  });
}
