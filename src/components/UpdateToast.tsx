import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { AlertTriangle, ArrowDownToLine, Loader2, X } from "lucide-react";
import Toast from "./ui/Toast";
import { platform } from "../services/platform";

/** How long the manual "you're up to date" confirmation stays up. */
const UP_TO_DATE_MS = 4000;

type View =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; progress: number }
  | { kind: "upToDate" }
  | { kind: "error" };

/**
 * The whole update experience, in one surface.
 *
 * One toast carries the entire lifecycle — available → downloading → relaunch —
 * rather than a settings row plus a notification, because there is only ever one
 * update in flight and nothing to configure about it mid-flight. The auto-check
 * toggle lives in General settings; the manual entry point is the app menu.
 *
 * Silent unless it has something to say: the launch check surfaces nothing
 * until an update actually exists. A manual check additionally shows the
 * transient `checking` / `upToDate` / `error` states, because a click that
 * produces no visible response reads as broken.
 *
 * Every branch is gated on `platform.hasUpdater` — Apple's mobile platforms
 * forbid self-updating and the plugin is not even compiled for them, so calling
 * into it there would throw.
 */
export default function UpdateToast() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>({ kind: "idle" });
  // Guards the check itself, not the download: a menu click while a download is
  // running must not start a second check behind it.
  const checking = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (checking.current) return;
    checking.current = true;
    if (manual) setView({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setView({ kind: "available", update });
      } else {
        setView(manual ? { kind: "upToDate" } : { kind: "idle" });
      }
    } catch (error) {
      console.error("Update check failed:", error);
      if (manual) setView({ kind: "error" });
    } finally {
      checking.current = false;
    }
  }, []);

  const install = useCallback(async (update: Update) => {
    setView({ kind: "downloading", progress: 0 });
    let total = 0;
    let received = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          received = 0;
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          // A server that omits Content-Length leaves the bar at 0 rather than
          // inventing a percentage; the label still says a download is running.
          const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
          setView((current) => (current.kind === "downloading" ? { ...current, progress } : current));
        } else {
          setView((current) => (current.kind === "downloading" ? { ...current, progress: 100 } : current));
        }
      });
      // The new version is on disk; there is no state worth keeping across the
      // restart, so the reader never has to press anything to get it.
      await relaunch();
    } catch (error) {
      console.error("Update download failed:", error);
      setView({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    if (!platform.hasUpdater) return;
    const unlisten = listen("menu:check-for-updates", () => {
      void runCheck(true);
    });
    // Absent means on: a reader who never opened the toggle still gets told
    // about a new version.
    invoke<string | null>("get_setting", { key: "auto_check_updates" })
      .then((value) => {
        if (value !== "false") void runCheck(false);
      })
      .catch(() => {});
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [runCheck]);

  useEffect(() => {
    if (view.kind !== "upToDate") return;
    const timer = window.setTimeout(() => setView({ kind: "idle" }), UP_TO_DATE_MS);
    return () => window.clearTimeout(timer);
  }, [view.kind]);

  if (!platform.hasUpdater || view.kind === "idle") return null;

  if (view.kind === "checking") {
    return (
      <Toast icon={<Loader2 size={14} className="shrink-0 animate-spin text-text-muted" />}>
        {t("update.toast.checking")}
      </Toast>
    );
  }

  if (view.kind === "upToDate") {
    return <Toast>{t("update.toast.upToDate")}</Toast>;
  }

  // `checking`, `downloading` and `upToDate` all end on their own. The other
  // two wait on the reader, so they need a way out that is not "install it" —
  // otherwise a toast the reader has read and decided about sits over the page
  // until they quit the app.
  const dismiss = (
    <button
      type="button"
      onClick={() => setView({ kind: "idle" })}
      aria-label={t("update.toast.dismiss")}
      title={t("update.toast.dismiss")}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-secondary"
    >
      <X size={14} />
    </button>
  );

  if (view.kind === "error") {
    return (
      <Toast icon={<AlertTriangle size={14} className="shrink-0 text-danger-text" />}>
        <span className="flex items-center gap-3">
          <span className="flex-1">{t("update.toast.error")}</span>
          <button
            type="button"
            onClick={() => void runCheck(true)}
            className="h-7 shrink-0 rounded-lg border border-border px-2.5 text-[12px] font-medium text-text-secondary hover:border-accent"
          >
            {t("common.retry")}
          </button>
          {dismiss}
        </span>
      </Toast>
    );
  }

  if (view.kind === "downloading") {
    return (
      <Toast icon={<ArrowDownToLine size={14} className="shrink-0 text-accent-text" />}>
        <span className="flex w-[220px] flex-col gap-1.5">
          <span>{t("update.toast.downloading", { progress: view.progress })}</span>
          <span className="block h-1 w-full overflow-hidden rounded-full bg-bg-input">
            <span
              className="block h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${view.progress}%` }}
            />
          </span>
        </span>
      </Toast>
    );
  }

  return (
    <Toast icon={<ArrowDownToLine size={14} className="shrink-0 text-accent-text" />}>
      <span className="flex items-center gap-3">
        <span className="flex-1">{t("update.toast.available", { version: view.update.version })}</span>
        <button
          type="button"
          onClick={() => void install(view.update)}
          className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-white"
        >
          {t("update.toast.update")}
        </button>
        {dismiss}
      </span>
    </Toast>
  );
}
