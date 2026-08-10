import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { arch } from "@tauri-apps/plugin-os";
import {
  Github,
  BookText,
  Scale,
  ExternalLink,
  GitFork,
  Bug,
  Check,
  Copy,
  Database,
  Loader2,
} from "lucide-react";
import LanternLogo from "../LanternLogo";
import { platform as platformCaps, type PlatformId } from "../../services/platform";
import { useUpdater } from "../../hooks/useUpdater";
import Button from "../ui/Button";
import { ROW_CONTROL_WIDTH } from "./types";

const CURRENT_REPOSITORY_URL = "https://github.com/KlaraGraff/lantern";
const CURRENT_RELEASES_URL = `${CURRENT_REPOSITORY_URL}/releases`;
const CURRENT_ISSUES_URL = `${CURRENT_REPOSITORY_URL}/issues`;
const CURRENT_DOCS_URL = `${CURRENT_REPOSITORY_URL}#readme`;
const UPSTREAM_REPOSITORY_URL = "https://github.com/yicheng47/quill";
// The word-frequency table ships under CC BY 3.0, which requires naming the
// source. This row is that attribution, not a nicety.
const WORD_FREQUENCY_SOURCE_URL = "https://github.com/orgtre/google-books-ngram-frequency";

interface BuildInfo {
  version: string;
  upstream_baseline: string;
  commit: string;
  built_at: string;
  channel: string;
  bundle_identifier: string;
  repository: string;
  upstream_repository: string;
}

const OS_NAMES: Partial<Record<PlatformId, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  ios: "iOS",
  android: "Android",
};

// Informational only. Read from the OS plugin rather than the UA string, which
// says "Macintosh" on iPadOS and carries no architecture at all in a webview.
function platformLabel(): string {
  const os = OS_NAMES[platformCaps.id];
  if (!os) return "";
  try {
    return `${os} · ${arch()}`;
  } catch {
    // Not under Tauri; the OS name came from the UA fallback.
    return os;
  }
}

export default function AboutSettings() {
  const { t } = useTranslation();
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const platform = platformLabel();
  // Windows has no app menu, so this row is the only manual "check for
  // updates" entry point it gets — and it has to be able to finish the job,
  // not just report that there is one. It shares the whole lifecycle with the
  // toast rather than running a check of its own, so the two can never give
  // different answers, and a download started here keeps going if the reader
  // closes Settings.
  const { state: update, check, download, install } = useUpdater();

  useEffect(() => {
    invoke<BuildInfo>("app_build_info").then(setBuildInfo).catch(() => setBuildInfo(null));
  }, []);

  const open = (url: string) => {
    openUrl(url).catch(() => {});
  };

  const copyDiagnostics = async () => {
    if (!buildInfo) return;
    const details = [
      `Lantern ${buildInfo.version}`,
      `Upstream baseline: ${buildInfo.upstream_baseline}`,
      `Commit: ${buildInfo.commit}`,
      `Built: ${buildInfo.built_at}`,
      `Channel: ${buildInfo.channel}`,
      `Platform: ${platform || "unknown"}`,
      `Bundle ID: ${buildInfo.bundle_identifier}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  // What the row says, and what its one button does about it. Derived rather
  // than stored: the row has no state of its own to fall out of step with.
  const updateAction =
    update.kind === "ready" ? "restart" : update.kind === "available" ? "update" : "check";
  const updateBusy =
    update.kind === "checking" || update.kind === "downloading" || update.kind === "installing";
  const updateHint = (() => {
    switch (update.kind) {
      case "checking":
        return t("update.toast.checking");
      case "upToDate":
        return t("update.toast.upToDate");
      case "available":
        return t("update.toast.available", { version: update.version });
      case "downloading":
        return update.progress === null
          ? t("update.toast.downloadingIndeterminate")
          : t("update.toast.downloading", { progress: update.progress });
      case "ready":
        return t("update.toast.ready", { version: update.version });
      case "installing":
        return t("update.toast.installing");
      case "error":
        return t("update.toast.error");
      default:
        return t("settings.about.checkForUpdatesHint");
    }
  })();

  return (
    <div className="flex flex-col min-h-full pb-2">
      {/* Identity */}
      <div className="flex flex-col items-center gap-3.5 pt-4 pb-6">
        <LanternLogo size={56} className="rounded-2xl" />
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-[20px] font-semibold text-text-primary tracking-[0.5px]">
            Lantern
          </span>
          <span className="max-w-[280px] text-balance text-center text-[12px] leading-[1.6] text-text-muted">
            {t("settings.about.description")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-bg-page dark:bg-bg-input text-text-secondary text-[12px] font-mono px-2 py-0.5 rounded-lg">
            v{buildInfo?.version ?? "..."}
          </span>
          {platform && (
            <span className="bg-bg-page dark:bg-bg-input text-text-secondary text-[12px] font-mono px-2 py-0.5 rounded-lg">
              {platform}
            </span>
          )}
        </div>
      </div>
      <div className="h-px bg-border-light mb-4" />

      {/* Check for Updates — sits right under the version badge above, since
          that's the number it's answering. The Mac menu bar carries the same
          manual check (Lantern → Check for Updates…); this is that entry
          point for every platform, Windows included. No per-row divider:
          this file's own link rows below use one height, `GeneralSettings`'s
          rows use another with no divider between them — this copies the
          latter, since it needs the two-line title+hint layout. */}
      {platformCaps.hasUpdater && (
        <div className="flex items-center justify-between min-h-[73px] py-3">
          <div className="min-w-0 flex-1 pr-4">
            <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
              {t("settings.about.checkForUpdates")}
            </p>
            <p className="text-[12px] text-text-muted mt-0.5">{updateHint}</p>
            {/* The bar is the only place this row can show progress; the
                button is busy saying what happens next. */}
            {update.kind === "downloading" && (
              <span className="mt-2 block h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-bg-input">
                <span
                  className={`block h-full rounded-full bg-accent ${
                    update.progress === null
                      ? "w-1/3 animate-pulse"
                      : "transition-[width] duration-200"
                  }`}
                  style={update.progress === null ? undefined : { width: `${update.progress}%` }}
                />
              </span>
            )}
          </div>
          <Button
            variant={updateAction === "check" ? "secondary" : "primary"}
            size="sm"
            className={`${ROW_CONTROL_WIDTH} justify-center gap-1.5`}
            disabled={updateBusy}
            onClick={() => {
              if (updateAction === "restart") void install();
              else if (updateAction === "update") void download();
              else void check(true);
            }}
          >
            {updateBusy && <Loader2 size={14} className="shrink-0 animate-spin" />}
            {updateAction === "restart"
              ? t("update.toast.restartNow")
              : updateAction === "update"
                ? t("update.toast.update")
                : t("settings.about.checkForUpdatesButton")}
          </Button>
        </div>
      )}

      {buildInfo && (
        <div className="mb-4 border-y border-border-light py-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
            <span className="text-text-muted">{t("settings.about.upstreamBaseline")}</span>
            <span className="font-mono text-text-secondary text-right truncate">v{buildInfo.upstream_baseline}</span>
            <span className="text-text-muted">{t("settings.about.commit")}</span>
            <span className="font-mono text-text-secondary text-right truncate">{buildInfo.commit}</span>
            <span className="text-text-muted">{t("settings.about.channel")}</span>
            <span className="font-mono text-text-secondary text-right truncate">{buildInfo.channel}</span>
            <span className="text-text-muted">{t("settings.about.buildDate")}</span>
            <span className="font-mono text-text-secondary text-right truncate">{buildInfo.built_at}</span>
          </div>
          <button
            type="button"
            title={t("settings.about.copyDiagnostics")}
            onClick={copyDiagnostics}
            className="mt-3 h-8 w-full flex items-center justify-center gap-2 rounded-lg border border-border text-[12px] text-text-secondary hover:bg-bg-input cursor-pointer"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("settings.about.copied") : t("settings.about.copyDiagnostics")}
          </button>
        </div>
      )}

      <p className="text-[11px] font-semibold text-text-muted tracking-[0.6px] mb-1">
        {t("settings.about.currentVersion").toUpperCase()}
      </p>
      <button
        onClick={() => open(buildInfo?.repository ?? CURRENT_REPOSITORY_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <Github size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.repository")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>

      <button
        onClick={() => open(CURRENT_RELEASES_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <BookText size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.releases")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>

      <button
        onClick={() => open(CURRENT_ISSUES_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <Bug size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.issues")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>
      <button
        onClick={() => open(CURRENT_DOCS_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <BookText size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.documentation")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>

      <div className="h-px bg-border-light my-3" />
      <p className="text-[11px] font-semibold text-text-muted tracking-[0.6px] mb-1">
        {t("settings.about.upstreamProject").toUpperCase()}
      </p>
      <button
        onClick={() => open(buildInfo?.upstream_repository ?? UPSTREAM_REPOSITORY_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <GitFork size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.originalRepository")}</span>
        </div>
        <ExternalLink size={14} className="text-text-muted" />
      </button>
      <div className="flex items-center justify-between h-[57px]">
        <div className="flex items-center gap-3">
          <Scale size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.license")}</span>
        </div>
        <span className="text-[12px] text-text-muted">MIT · yicheng47/quill</span>
      </div>

      <div className="h-px bg-border-light my-3" />
      <p className="text-[11px] font-semibold text-text-muted tracking-[0.6px] mb-1">
        {t("settings.about.dataSources").toUpperCase()}
      </p>
      <button
        onClick={() => open(WORD_FREQUENCY_SOURCE_URL)}
        className="group flex items-center justify-between h-[57px] cursor-pointer"
      >
        <div className="flex items-center gap-3">
          <Database size={16} className="text-text-muted" />
          <span className="text-[14px] text-text-primary tracking-[-0.15px]">{t("settings.about.wordFrequency")}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-text-muted">CC BY 3.0 · Google Books Ngram</span>
          <ExternalLink size={14} className="text-text-muted" />
        </div>
      </button>
    </div>
  );
}
