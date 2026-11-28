import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { AlertTriangle, RotateCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import Button from "./ui/Button";
import RestoreBackupDialog, { type RestorePreview } from "./settings/RestoreBackupDialog";
import { restoreErrorKey } from "./settings/restore-backup";
import {
  startupFailureActions,
  startupFailureCopy,
  type StartupFailureAction,
  type StartupFailureInfo,
} from "./startup-failure";

/**
 * What the main window shows instead of the app when the library database or
 * the API-key store would not open at launch. Laid out like the app-level
 * error boundary's full-window fallback, so it reads as part of Lantern rather
 * than a crash dialog. Nothing here may touch a command that needs the
 * library: the backend registered none of that state.
 */
export default function StartupFailure({ info }: { info: StartupFailureInfo }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const { titleKey, bodyKey } = startupFailureCopy(info);
  const actions = startupFailureActions(info);

  // The main window starts hidden and the app reveals it once mounted; the
  // app never mounts on this path.
  useEffect(() => {
    invoke("app_ready").catch(() => {});
  }, []);

  const reopen = async () => {
    try {
      await relaunch();
    } catch {
      setPageError(t("startupFailure.relaunchFailed"));
    }
  };

  const chooseRestore = async () => {
    setPageError(null);
    try {
      const next = await invoke<RestorePreview | null>("startup_restore_choose");
      if (next) {
        setDialogError(null);
        setPreview(next);
      }
    } catch (err) {
      setPageError(t(restoreErrorKey(err)));
    }
  };

  const confirmRestore = async (name: string) => {
    setDialogError(null);
    setBusy(true);
    try {
      await invoke("startup_restore_apply", { name });
    } catch (err) {
      setBusy(false);
      setDialogError(t(restoreErrorKey(err)));
      return;
    }
    try {
      await relaunch();
    } catch {
      setDialogError(t("settings.libraryBackup.restore.relaunchFailed"));
    }
  };

  const renderAction = (action: StartupFailureAction, index: number) => {
    const variant = index === 0 ? "primary" : "secondary";
    switch (action) {
      case "restore":
        return (
          <Button key="restore" variant={variant} size="sm" onClick={() => void chooseRestore()}>
            {t("startupFailure.restore")}
          </Button>
        );
      case "relaunch":
        return (
          <Button key="relaunch" variant={variant} size="sm" onClick={() => void reopen()}>
            <RotateCw size={13} aria-hidden="true" />
            {t("startupFailure.relaunch")}
          </Button>
        );
      case "logs":
        return (
          <Button
            key="logs"
            variant={variant}
            size="sm"
            onClick={() => {
              invoke("reveal_logs").catch(() => {});
            }}
          >
            {t("startupFailure.showLogs")}
          </Button>
        );
    }
  };

  return (
    <div
      role="alert"
      className="flex h-screen flex-col items-center justify-center gap-4 bg-bg-page px-6 text-center"
    >
      <div className="flex size-10 items-center justify-center rounded-md bg-danger-bg text-danger-text">
        <AlertTriangle size={21} aria-hidden="true" />
      </div>
      <div className="max-w-[560px]">
        <p className="text-[16px] font-medium text-text-primary">{t(titleKey)}</p>
        <p className="mt-2 text-[13px] leading-5 text-text-muted break-words">{t(bodyKey)}</p>
        {actions.includes("restore") && (
          <p className="mt-1 text-[13px] leading-5 text-text-muted break-words">{t("startupFailure.restoreHint")}</p>
        )}
        <details className="mx-auto mt-3 max-w-[520px] text-left">
          <summary className="cursor-pointer text-center text-[12px] text-text-secondary">
            {t("reader.errorDetails")}
          </summary>
          <p className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap rounded-md bg-bg-input px-3 py-2 font-mono text-[11px] leading-5 text-text-muted break-words">
            {info.detail}
          </p>
        </details>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {actions.map(renderAction)}
      </div>
      {pageError && (
        <p role="status" className="max-w-[520px] text-[12px] leading-5 text-danger-text">
          {pageError}
        </p>
      )}
      {preview && (
        <RestoreBackupDialog
          preview={preview}
          busy={busy}
          error={dialogError}
          onCancel={() => setPreview(null)}
          onConfirm={(name) => void confirmRestore(name)}
        />
      )}
    </div>
  );
}
