import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import Toggle from "../ui/Toggle";
import { installEnhancedFontFace } from "../enhanced-fonts";

type FontStatus = {
  state: "not_downloaded" | "downloading" | "verifying" | "enabled" | "disabled_retained" | "failed";
  enabled: boolean;
  downloadSize: number | null;
  downloadedBytes: number | null;
  version: string | null;
  errorCode: string | null;
};

type Availability = {
  status: FontStatus;
  manifest: { downloadSize: number } | null;
  localPath: string | null;
};

export default function EnhancedFontSettings() {
  const { t } = useTranslation();
  const [value, setValue] = useState<Availability | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void invoke<Availability>("enhanced_font_status").then((next) => {
      setValue(next);
      installEnhancedFontFace(next.localPath);
    }).catch(() => setFailed(true));
    const unlisten = listen<FontStatus>("enhanced-font-status-changed", (event) => {
      setValue((current) => current ? { ...current, status: event.payload } : current);
    });
    return () => { void unlisten.then((stop) => stop()); };
  }, []);

  const apply = async (enabled: boolean) => {
    setBusy(true);
    setFailed(false);
    try {
      const command = enabled && value?.status.state === "not_downloaded"
        ? "enhanced_font_download"
        : "enhanced_font_set_enabled";
      const next = await invoke<Availability>(command, command.endsWith("set_enabled") ? { enabled } : {});
      setValue(next);
      installEnhancedFontFace(next.localPath);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const status = value?.status;
  const total = status?.downloadSize ?? value?.manifest?.downloadSize ?? null;
  const downloaded = status?.downloadedBytes ?? 0;
  const progress = total ? Math.min(100, Math.round(downloaded / total * 100)) : 0;
  const packageUnavailable = status?.state === "not_downloaded" && !value?.manifest;

  return <section className="border-t border-border-light py-4">
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[14px] font-medium text-text-primary">{t("settings.enhancedFonts.title")}</p>
        <p className="mt-0.5 text-[12px] text-text-muted">{t("settings.enhancedFonts.hint")}</p>
      </div>
      <Toggle label={t("settings.enhancedFonts.title")} checked={Boolean(status?.enabled)} disabled={busy || !value || packageUnavailable} onChange={(enabled) => { void apply(enabled); }} />
    </div>
    {total ? <p className="mt-2 text-[11px] text-text-muted">{t("settings.enhancedFonts.size", { size: (total / 1024 / 1024).toFixed(1) })}</p> : null}
    {(status?.state === "downloading" || status?.state === "verifying") && <div className="mt-3" role="status">
      <div className="h-1.5 overflow-hidden rounded-full bg-bg-input"><div className="h-full bg-accent" style={{ width: `${status.state === "verifying" ? 100 : progress}%` }} /></div>
      <p className="mt-1 text-[11px] text-text-muted">{status.state === "verifying" ? t("settings.enhancedFonts.verifying") : t("settings.enhancedFonts.downloading", { progress })}</p>
    </div>}
    {packageUnavailable && <p className="mt-2 text-[11px] text-text-muted">{t("settings.enhancedFonts.unavailable")}</p>}
    {failed && <p role="alert" className="mt-2 text-[11px] text-danger-text">{t("settings.enhancedFonts.failed")}</p>}
    {status?.state === "disabled_retained" && <div className="mt-3 rounded-lg bg-bg-input p-3">
      <p className="text-[11px] text-text-muted">{t("settings.enhancedFonts.retained")}</p>
      {!confirmRemove ? <button type="button" className="mt-2 text-[11px] text-danger-text underline" onClick={() => setConfirmRemove(true)}>{t("settings.enhancedFonts.remove")}</button> : <div className="mt-2 flex items-center justify-end gap-2">
        <button type="button" className="text-[11px] text-text-muted" onClick={() => setConfirmRemove(false)}>{t("common.cancel")}</button>
        <button type="button" className="rounded-md bg-danger px-2 py-1 text-[11px] text-white" onClick={() => { setBusy(true); void invoke<Availability>("enhanced_font_remove").then((next) => { setValue(next); installEnhancedFontFace(null); setConfirmRemove(false); }).catch(() => setFailed(true)).finally(() => setBusy(false)); }}>{t("settings.enhancedFonts.confirmRemove")}</button>
      </div>}
    </div>}
  </section>;
}
