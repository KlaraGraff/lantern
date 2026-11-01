import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Toggle from "../ui/Toggle";
import { platform } from "../../services/platform";

export interface LibraryBackupStatus {
  dir: string | null;
  online: boolean;
  auto: boolean;
  running: boolean;
  copied: number;
  total: number;
  last_at: number | null;
  books_backed_up: number;
  books_unavailable: number;
  error: string | null;
}

const KNOWN_ERRORS = ["LIBRARY_BACKUP_INSIDE_LIBRARY", "LIBRARY_BACKUP_WRITE_FAILED"];

/// Offline is shown as a state of the folder row, not as an error banner.
function backupErrorKey(error: string | null): string | null {
  if (!error || error.includes("LIBRARY_BACKUP_FOLDER_OFFLINE") || error.includes("LIBRARY_BACKUP_NOT_CONFIGURED")) {
    return null;
  }
  const code = KNOWN_ERRORS.find((candidate) => error.includes(candidate));
  return `settings.libraryBackup.error.${code ?? "unknown"}`;
}

export default function LibraryBackupSection() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<LibraryBackupStatus | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<LibraryBackupStatus>("library_backup_status"));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen<LibraryBackupStatus>("library-backup-changed", (event) => setStatus(event.payload));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const act = async (run: () => Promise<LibraryBackupStatus | null | void>) => {
    setActionError(null);
    try {
      const next = await run();
      if (next) setStatus(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseDir = () => act(() => invoke<LibraryBackupStatus | null>("library_backup_choose_dir"));
  const runNow = () => act(() => invoke<LibraryBackupStatus>("library_backup_run"));
  const stop = () => act(() => invoke<void>("library_backup_cancel"));
  const setAuto = (enabled: boolean) =>
    act(() => invoke<LibraryBackupStatus>("library_backup_set_auto", { enabled }));

  const hasDir = Boolean(status?.dir);
  const running = status?.running ?? false;
  const offline = hasDir && !(status?.online ?? false);
  const errorKey = backupErrorKey(actionError ?? status?.error ?? null);

  const lastLine = () => {
    if (!status?.last_at) return t("settings.libraryBackup.never");
    const time = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(status.last_at),
    );
    return t("settings.libraryBackup.lastAt", { time, count: status.books_backed_up });
  };

  let detail: ReactNode;
  if (!hasDir) {
    detail = <p className="text-[12px] text-text-muted mt-0.5 leading-[1.45]">{t("settings.libraryBackup.intro")}</p>;
  } else if (running) {
    detail = (
      <>
        <p className="text-[12px] text-text-muted mt-0.5 leading-[1.45]">
          {status && status.total > 0
            ? t("settings.libraryBackup.copying", { copied: status.copied, total: status.total })
            : t("settings.libraryBackup.preparing")}
        </p>
        <div className="h-1.5 w-[220px] max-w-full rounded-full bg-bg-muted overflow-hidden mt-2">
          <div
            className="h-full bg-accent transition-[width] duration-200"
            style={{ width: `${status && status.total > 0 ? Math.round((status.copied / status.total) * 100) : 8}%` }}
          />
        </div>
      </>
    );
  } else {
    detail = (
      <>
        <p className="text-[12px] text-text-muted mt-0.5 leading-[1.45] break-all">
          <span className="font-mono text-text-secondary">{status?.dir}</span>
          {" · "}
          <button
            type="button"
            onClick={chooseDir}
            className="text-accent-text hover:underline cursor-pointer"
          >
            {t("settings.libraryBackup.change")}
          </button>
        </p>
        {offline ? (
          <p className="text-[12px] text-danger-text mt-0.5 leading-[1.45]">{t("settings.libraryBackup.offline")}</p>
        ) : (
          <p className="text-[12px] text-text-muted mt-0.5 leading-[1.45]">{lastLine()}</p>
        )}
        {!offline && (status?.books_unavailable ?? 0) > 0 && (
          <p className="text-[12px] text-warning mt-0.5 leading-[1.45]">
            {t("settings.libraryBackup.unavailable", { count: status?.books_unavailable })}
          </p>
        )}
      </>
    );
  }

  const autoHint = !hasDir
    ? t("settings.libraryBackup.autoNeedsFolder")
    : offline
      ? t("settings.libraryBackup.autoOfflineHint")
      : t("settings.libraryBackup.autoHint");

  return (
    <div>
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.libraryBackup.title")}
          </p>
          {detail}
        </div>
        {!hasDir ? (
          <Button variant="primary" size="md" className="shrink-0 touch:h-11" onClick={chooseDir} disabled={!status}>
            {t("settings.libraryBackup.choose")}
          </Button>
        ) : running ? (
          <Button variant="secondary" size="md" className="shrink-0 touch:h-11" onClick={stop}>
            {t("settings.libraryBackup.stop")}
          </Button>
        ) : (
          <Button variant="secondary" size="md" className="shrink-0 touch:h-11" onClick={runNow}>
            {t("settings.libraryBackup.runNow")}
          </Button>
        )}
      </div>
      <div className="h-px bg-border-light" />
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">
            {t("settings.libraryBackup.auto")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5 leading-[1.45]">{autoHint}</p>
        </div>
        <Toggle
          label={t("settings.libraryBackup.auto")}
          checked={status?.auto ?? false}
          onChange={(next) => void setAuto(next)}
          disabled={!hasDir}
        />
      </div>
      <p className="text-[12px] text-text-muted leading-[1.5]">{t(platform.hasFolderSync ? "settings.libraryBackup.scopeNote" : "settings.libraryBackup.scopeNoteNoSync")}</p>
      {errorKey && (
        <div className="bg-danger-bg border border-danger-border rounded-lg px-3.5 py-2 mt-3">
          <span className="text-[12px] text-danger-text leading-[1.45]">{t(errorKey)}</span>
        </div>
      )}
    </div>
  );
}
