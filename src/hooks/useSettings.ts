import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  applySettingsChange,
  listenForSettingsChanged,
  notifySettingsChanged,
} from "../components/settings-events.ts";

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const writesRef = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((write: () => Promise<void>) => {
    const result = writesRef.current.catch(() => {}).then(write);
    writesRef.current = result;
    return result;
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Record<string, string>>("get_all_settings");
      setSettings(result);
    } catch (err) {
      console.error("Failed to load settings:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForSettingsChanged((values) => {
      if (!disposed) setSettings((current) => applySettingsChange(current, values));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const saveBulk = useCallback((newSettings: Record<string, string>) => enqueue(async () => {
    await invoke("set_settings_bulk", { settings: newSettings });
    setSettings((prev) => ({ ...prev, ...newSettings }));
    await notifySettingsChanged(newSettings).catch(() => {});
  }), [enqueue]);

  const save = useCallback((key: string, value: string) => enqueue(async () => {
    await invoke("set_setting", { key, value });
    setSettings((prev) => ({ ...prev, [key]: value }));
    await notifySettingsChanged({ [key]: value }).catch(() => {});
  }), [enqueue]);

  return { settings, loading, refresh, saveBulk, save };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_all_settings");
}

export async function getBookSettings(bookId: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_book_settings", { bookId });
}
