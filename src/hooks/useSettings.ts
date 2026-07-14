import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listenForSettingsChanged, notifySettingsChanged } from "../components/settings-events";

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

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
      if (!disposed) setSettings((current) => ({ ...current, ...values }));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const saveBulk = useCallback(async (newSettings: Record<string, string>) => {
    await invoke("set_settings_bulk", { settings: newSettings });
    setSettings((prev) => ({ ...prev, ...newSettings }));
    await notifySettingsChanged(newSettings).catch(() => {});
  }, []);

  const save = useCallback(async (key: string, value: string) => {
    await invoke("set_setting", { key, value });
    setSettings((prev) => ({ ...prev, [key]: value }));
    await notifySettingsChanged({ [key]: value }).catch(() => {});
  }, []);

  return { settings, loading, refresh, saveBulk, save };
}

export async function getAllSettings(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("get_all_settings");
}
