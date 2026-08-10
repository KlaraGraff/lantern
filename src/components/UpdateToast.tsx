import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ArrowDownToLine, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import Toast from "./ui/Toast";
import UpdateNotes from "./UpdateNotes";
import { platform } from "../services/platform";
import { DISMISSED_UPDATE_VERSION_KEY, runUpdateCheck, shouldSuppressAutoPrompt } from "../services/updateCheck";
import { extractLocaleNotes } from "../services/updateNotes";

/** How long the manual "you're up to date" confirmation stays up. */
const UP_TO_DATE_MS = 4000;

/** Where "view on GitHub" goes — the release page for the offered version. */
const releasePageUrl = (version: string) =>
  `https://github.com/KlaraGraff/lantern/releases/tag/v${version}`;

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
 * The prompt says what changed, not just that something did. `latest.json`
 * carries the published release notes, and the toast renders the block written
 * in the reader's interface language — collapsed, because a release note that
 * covers the page is one nobody reads. When a release has no usable notes the
 * panel is not shown empty; the toast falls back to the one-line prompt.
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
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<View>({ kind: "idle" });
  // Guards the check itself, not the download: a menu click while a download is
  // running must not start a second check behind it.
  const checking = useRef(false);
  // Reset per offered update rather than per mount, so a version dismissed
  // while expanded is not re-offered already expanded.
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [notesOverflow, setNotesOverflow] = useState(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (checking.current) return;
    checking.current = true;
    if (manual) setView({ kind: "checking" });
    try {
      const result = await runUpdateCheck();
      if (result.status === "available") {
        // Only the silent launch check needs to know what was dismissed —
        // a manual check (menu item) always shows what it found.
        const dismissed = manual
          ? null
          : await invoke<string | null>("get_setting", { key: DISMISSED_UPDATE_VERSION_KEY }).catch(
              () => null,
            );
        if (shouldSuppressAutoPrompt(manual, result.update.version, dismissed)) {
          setView({ kind: "idle" });
        } else {
          setNotesExpanded(false);
          setNotesOverflow(false);
          setView({ kind: "available", update: result.update });
        }
      } else if (result.status === "upToDate") {
        setView(manual ? { kind: "upToDate" } : { kind: "idle" });
      } else if (manual) {
        setView({ kind: "error" });
      }
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
      onClick={() => {
        // Remember *this version* as dismissed, not "a toast was shown" —
        // otherwise the next real release would never get to prompt either.
        if (view.kind === "available") {
          void invoke("set_setting", {
            key: DISMISSED_UPDATE_VERSION_KEY,
            value: view.update.version,
          }).catch(() => {});
        }
        setView({ kind: "idle" });
      }}
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

  const version = view.update.version;
  const updateButton = (
    <button
      type="button"
      onClick={() => void install(view.update)}
      className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-white"
    >
      {t("update.toast.update")}
    </button>
  );

  // `body` is the `notes` field of `latest.json`. It is bilingual, so only the
  // block matching the interface language is rendered; a release published
  // before the notes pipeline existed has nothing usable in there and falls
  // through to the bare one-line prompt below.
  const notes = extractLocaleNotes(view.update.body, i18n.language);

  if (!notes) {
    return (
      <Toast icon={<ArrowDownToLine size={14} className="shrink-0 text-accent-text" />}>
        <span className="flex items-center gap-3">
          <span className="flex-1">{t("update.toast.available", { version })}</span>
          {updateButton}
          {dismiss}
        </span>
      </Toast>
    );
  }

  return (
    <Toast variant="panel">
      <div className="w-[360px] text-[13px] tracking-[-0.08px] text-text-secondary">
        <div className="flex items-start gap-3 py-2.5 pr-2 pl-4">
          <ArrowDownToLine size={14} className="mt-[3px] shrink-0 text-accent-text" />
          <span className="flex-1">{t("update.toast.available", { version })}</span>
          {dismiss}
        </div>
        <UpdateNotes
          notes={notes}
          expanded={notesExpanded}
          onOverflowChange={setNotesOverflow}
          label={t("update.toast.notes.label")}
        />
        <div className="flex items-center gap-3 border-t border-border-light py-2 pr-3 pl-4">
          {/* Only offered when the clamp actually hid something. */}
          {notesOverflow && (
            <button
              type="button"
              onClick={() => setNotesExpanded((open) => !open)}
              aria-expanded={notesExpanded}
              className="flex items-center gap-1 text-[12px] text-text-muted hover:text-accent-text"
            >
              {notesExpanded ? t("update.toast.notes.collapse") : t("update.toast.notes.expand")}
              {notesExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => { openUrl(releasePageUrl(version)).catch(() => {}); }}
            className="text-[12px] text-text-muted hover:text-accent-text"
          >
            {t("update.toast.notes.viewOnGitHub")}
          </button>
          <span className="flex-1" />
          {updateButton}
        </div>
      </div>
    </Toast>
  );
}
