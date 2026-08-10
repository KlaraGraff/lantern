import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import Toast from "./ui/Toast";
import UpdateNotes from "./UpdateNotes";
import { platform } from "../services/platform";
import { useUpdater } from "../hooks/useUpdater";
import { extractLocaleNotes } from "../services/updateNotes";

/** Where "view on GitHub" goes — the release page for the offered version. */
const releasePageUrl = (version: string) =>
  `https://github.com/KlaraGraff/lantern/releases/tag/v${version}`;

/**
 * The update experience, as a toast over the page.
 *
 * One toast carries the whole lifecycle — offered → downloading → ready →
 * restart — rather than a notification plus a settings row, because there is
 * only ever one update in flight and nothing to configure about it mid-flight.
 * The state itself lives in `useUpdater`, shared with the Settings → About row
 * so the two can never answer the same question differently.
 *
 * The prompt says what changed, not just that something did. `latest.json`
 * carries the published release notes, and the toast renders the block written
 * in the reader's interface language — collapsed, because a release note that
 * covers the page is one nobody reads. When a release has no usable notes the
 * panel is not shown empty; the toast falls back to the one-line prompt.
 *
 * Silent unless it has something to say: the launch check surfaces nothing
 * until an update actually exists. A manual check additionally shows the
 * transient `checking` / `upToDate` / `error` beats, because a click that
 * produces no visible response reads as broken.
 *
 * Every branch is gated on `platform.hasUpdater` — Apple's mobile platforms
 * forbid self-updating and the plugin is not even compiled for them.
 */
export default function UpdateToast() {
  const { t, i18n } = useTranslation();
  const { state, check, download, install, dismiss } = useUpdater();
  // Reset per offered version rather than per mount, so a version dismissed
  // while expanded is not re-offered already expanded.
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [notesOverflow, setNotesOverflow] = useState(false);

  const version = "version" in state ? state.version : null;
  useEffect(() => {
    setNotesExpanded(false);
    setNotesOverflow(false);
  }, [version]);

  if (!platform.hasUpdater || state.kind === "idle") return null;

  if (state.kind === "checking") {
    return (
      <Toast icon={<Loader2 size={14} className="shrink-0 animate-spin text-text-muted" />}>
        {t("update.toast.checking")}
      </Toast>
    );
  }

  if (state.kind === "upToDate") {
    return <Toast>{t("update.toast.upToDate")}</Toast>;
  }

  if (state.kind === "installing") {
    return (
      <Toast icon={<Loader2 size={14} className="shrink-0 animate-spin text-text-muted" />}>
        {t("update.toast.installing")}
      </Toast>
    );
  }

  if (state.kind === "downloading") {
    return (
      <Toast icon={<ArrowDownToLine size={14} className="shrink-0 text-accent-text" />}>
        <span className="flex w-[220px] flex-col gap-1.5">
          <span>
            {state.progress === null
              ? t("update.toast.downloadingIndeterminate")
              : t("update.toast.downloading", { progress: state.progress })}
          </span>
          <span className="block h-1 w-full overflow-hidden rounded-full bg-bg-input">
            <span
              className={`block h-full rounded-full bg-accent ${
                state.progress === null ? "w-1/3 animate-pulse" : "transition-[width] duration-200"
              }`}
              style={state.progress === null ? undefined : { width: `${state.progress}%` }}
            />
          </span>
        </span>
      </Toast>
    );
  }

  // `checking`, `downloading`, `installing` and `upToDate` all end on their
  // own. The rest wait on the reader, so they need a way out that is not
  // "install it" — otherwise a toast they have read and decided about sits
  // over the page until they quit.
  const dismissButton = (
    <button
      type="button"
      onClick={dismiss}
      aria-label={t("update.toast.dismiss")}
      title={t("update.toast.dismiss")}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-secondary"
    >
      <X size={14} />
    </button>
  );

  if (state.kind === "error") {
    return (
      <Toast icon={<AlertTriangle size={14} className="shrink-0 text-danger-text" />}>
        <span className="flex items-center gap-3">
          <span className="flex-1">{t("update.toast.error")}</span>
          <button
            type="button"
            onClick={() => void check(true)}
            className="h-7 shrink-0 rounded-lg border border-border px-2.5 text-[12px] font-medium text-text-secondary hover:border-accent"
          >
            {t("common.retry")}
          </button>
          {dismissButton}
        </span>
      </Toast>
    );
  }

  // `ready` means the package is already downloaded and verified, so the
  // button restarts rather than starting a download.
  const staged = state.kind === "ready";
  const headline = staged
    ? t("update.toast.ready", { version: state.version })
    : t("update.toast.available", { version: state.version });
  const icon = staged ? (
    <CheckCircle2 size={14} className="shrink-0 text-accent-text" />
  ) : (
    <ArrowDownToLine size={14} className="shrink-0 text-accent-text" />
  );
  const actionButton = (
    <button
      type="button"
      onClick={() => void (staged ? install() : download())}
      className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-[12px] font-medium text-white"
    >
      {staged ? t("update.toast.restartNow") : t("update.toast.update")}
    </button>
  );

  // `notes` is the `notes` field of `latest.json`. It is bilingual, so only the
  // block matching the interface language is rendered; a release published
  // before the notes pipeline existed has nothing usable in there and falls
  // through to the bare one-line prompt below.
  const notes = extractLocaleNotes(state.notes, i18n.language);

  if (!notes) {
    return (
      <Toast icon={icon}>
        <span className="flex items-center gap-3">
          <span className="flex-1">{headline}</span>
          {actionButton}
          {dismissButton}
        </span>
      </Toast>
    );
  }

  return (
    <Toast variant="panel">
      <div className="w-[360px] text-[13px] tracking-[-0.08px] text-text-secondary">
        <div className="flex items-start gap-3 py-2.5 pr-2 pl-4">
          <span className="mt-[3px]">{icon}</span>
          <span className="flex-1">{headline}</span>
          {dismissButton}
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
            onClick={() => { openUrl(releasePageUrl(state.version)).catch(() => {}); }}
            className="text-[12px] text-text-muted hover:text-accent-text"
          >
            {t("update.toast.notes.viewOnGitHub")}
          </button>
          <span className="flex-1" />
          {actionButton}
        </div>
      </div>
    </Toast>
  );
}
