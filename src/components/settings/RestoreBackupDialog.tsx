import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { trapTabKey } from "../focus-trap";
import Button from "../ui/Button";

export interface RestoreVersion {
  name: string;
  date: string;
  saved_at: number | null;
  books: number;
  highlights: number;
  notes: number;
  vocab: number;
}

export interface RestorePreview {
  dir: string;
  versions: RestoreVersion[];
}

interface RestoreBackupDialogProps {
  preview: RestorePreview;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

/**
 * Confirmation for 从备份恢复: which day to restore, what it holds, and what
 * happens to the data on this device. Focus starts on 取消, as in 重置.
 */
export default function RestoreBackupDialog({ preview, busy, error, onCancel, onConfirm }: RestoreBackupDialogProps) {
  const { t, i18n } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState(preview.versions[0]?.name ?? "");

  useEffect(() => {
    (cancelRef.current ?? dialogRef.current)?.focus();
  }, [busy]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
        return;
      }
      if (event.key === "Tab") trapTabKey(event, dialog, { stopPropagation: true });
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [busy, onCancel]);

  const dateLabel = (version: RestoreVersion) => {
    const when = version.saved_at ? new Date(version.saved_at) : new Date(`${version.date}T12:00:00`);
    const options: Intl.DateTimeFormatOptions = version.saved_at
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" };
    return new Intl.DateTimeFormat(i18n.language, options).format(when);
  };
  const countsLine = (version: RestoreVersion) =>
    t("settings.libraryBackup.restore.counts", {
      books: version.books,
      marks: version.highlights + version.notes,
      vocab: version.vocab,
    });
  const selected = preview.versions.find((version) => version.name === name) ?? preview.versions[0];

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay p-4"
      onPointerDown={(event) => !busy && event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        role={busy ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        tabIndex={-1}
        className="w-[min(440px,calc(100vw-32px))] rounded-md border border-border bg-bg-surface p-5 shadow-context outline-none"
      >
        {busy ? (
          <>
            <h2 id={titleId} className="text-[15px] font-semibold text-text-primary">
              {t("settings.libraryBackup.restore.workingTitle")}
            </h2>
            <p className="mt-2 text-[13px] leading-5 text-text-secondary">
              {error ?? t("settings.libraryBackup.restore.workingBody")}
            </p>
          </>
        ) : (
          <>
            <h2 id={titleId} className="text-[15px] font-semibold text-text-primary">
              {t("settings.libraryBackup.restore.title")}
            </h2>
            <p className="mt-1 text-[12px] leading-5 text-text-muted font-mono break-all">{preview.dir}</p>
            <fieldset className="mt-3">
              <legend className="text-[13px] leading-5 text-text-secondary">
                {t("settings.libraryBackup.restore.versionLabel")}
              </legend>
              <div className="mt-1.5 max-h-[220px] overflow-y-auto rounded-md border border-border">
                {preview.versions.map((version) => (
                  <label
                    key={version.name}
                    className="flex cursor-pointer items-start gap-2.5 border-b border-border-light px-3 py-2 last:border-b-0 hover:bg-bg-input"
                  >
                    <input
                      type="radio"
                      name={titleId}
                      value={version.name}
                      checked={version.name === selected?.name}
                      onChange={() => setName(version.name)}
                      className="mt-1 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] leading-5 text-text-primary">{dateLabel(version)}</span>
                      <span className="block text-[12px] leading-5 text-text-muted">{countsLine(version)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="mt-3 rounded-md border border-border bg-bg-input px-3 py-2 text-[12px] leading-5 text-text-secondary">
              {t("settings.libraryBackup.restore.replaceNote")}
            </p>
            <p className="mt-2 text-[12px] leading-5 text-text-secondary">{t("settings.libraryBackup.restore.keyNote")}</p>
            {error && (
              <p role="alert" className="mt-2 text-[12px] leading-5 text-danger-text">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button ref={cancelRef} variant="secondary" size="sm" onClick={onCancel}>
                {t("settings.libraryBackup.restore.cancel")}
              </Button>
              <Button size="sm" onClick={() => selected && onConfirm(selected.name)} disabled={!selected}>
                {t("settings.libraryBackup.restore.confirm")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
