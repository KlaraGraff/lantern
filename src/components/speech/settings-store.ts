import { invoke } from "@tauri-apps/api/core";
import { listenForSettingsChanged, notifySettingsChanged } from "../settings-events";
import {
  DEFAULT_SPEECH_SETTINGS,
  parseSpeechSettings,
  SPEECH_SETTING_KEYS,
  type SpeechSettings,
} from "./types";

/**
 * A shared store rather than `useSettings` per control: every looked-up word
 * renders a pronounce button, and each `useSettings` mount is a fresh
 * `get_all_settings` round trip. This loads once per window and then rides the
 * existing cross-window settings broadcast.
 */
let raw: Record<string, string> = {};
let current: SpeechSettings = DEFAULT_SPEECH_SETTINGS;
let loading: Promise<void> | null = null;
const listeners = new Set<(value: SpeechSettings) => void>();

function publish() {
  current = parseSpeechSettings(raw);
  for (const listener of listeners) listener(current);
}

export function speechSettings(): SpeechSettings {
  return current;
}

export function subscribeToSpeechSettings(listener: (value: SpeechSettings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function ensureSpeechSettings(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const all = await invoke<Record<string, string>>("get_all_settings");
    raw = all;
    publish();
    await listenForSettingsChanged((values) => {
      if (!SPEECH_SETTING_KEYS.some((key) => key in values)) return;
      raw = { ...raw, ...values };
      publish();
    });
  })().catch((error) => {
    console.error("Failed to load speech settings:", error);
  });
  return loading;
}

/** Applies optimistically so a replay uses the new accent without waiting. */
export async function updateSpeechSettings(values: Record<string, string>): Promise<void> {
  raw = { ...raw, ...values };
  publish();
  await invoke("set_settings_bulk", { settings: values });
  await notifySettingsChanged(values).catch(() => {});
}
