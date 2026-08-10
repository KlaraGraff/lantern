import { useEffect, useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import Button from "./ui/Button";
import {
  clearVocabProfile,
  CLEAR_PROGRESS_EVENT,
  previewVocabProfileClear,
  type ClearProgress,
  type VocabProfileClearPreview,
} from "../hooks/useBookCoverage";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * 09 / 09b — clearing the automatically-derived vocabulary profile.
 *
 * Both columns are on the same screen and both carry counts, because the
 * question a reader actually has here is not "what does this do" but "does my
 * word list go with it". A category name cannot answer that; a row count can.
 *
 * The delete is a batched pass over a table that can hold hundreds of thousands
 * of rows, so it is not instant. Cancel stays live until the first write goes
 * out, and after that the dialog stops offering an exit it cannot honour.
 */
export default function ClearVocabProfileDialog({
  onClose,
  onCleared,
}: {
  onClose(): void;
  onCleared?(): void;
}) {
  const { t, i18n } = useTranslation();
  const numbers = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<VocabProfileClearPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ClearProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    previewVocabProfileClear()
      .then((rows) => {
        if (alive) setPreview(rows);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Escape is the same exit as Cancel, and disappears for the same reason.
  //
  // Capture phase, and the key is swallowed either way: this dialog opens on
  // top of the settings modal, which has its own document-level Escape handler
  // that closes the whole modal. Left to bubble, Escape would take the settings
  // modal — and this dialog with it — out from under a delete that had already
  // started writing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  useEffect(() => {
    if (!busy) return;
    let alive = true;
    let stop: UnlistenFn | undefined;
    listen<ClearProgress>(CLEAR_PROGRESS_EVENT, (event) => {
      if (!alive) return;
      setProgress(event.payload);
      if (event.payload.done) {
        onCleared?.();
        onClose();
      }
    })
      .then((unlisten) => {
        if (alive) stop = unlisten;
        else unlisten();
      })
      .catch(() => {});
    return () => {
      alive = false;
      stop?.();
    };
  }, [busy, onClose, onCleared]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearVocabProfile();
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  const gone = [
    preview
      ? t("vocabProfileClear.gone.mastery", { words: numbers.format(preview.autoMasteryWords) })
      : null,
    preview
      ? t("vocabProfileClear.gone.exposures", { records: numbers.format(preview.exposureRecords) })
      : null,
    preview
      ? t("vocabProfileClear.gone.coverage", { books: numbers.format(preview.computedBooks) })
      : null,
  ].filter((line): line is string => line !== null);

  const kept = [
    preview ? t("vocabProfileClear.kept.manual", { words: numbers.format(preview.manualWords) }) : null,
    preview ? t("vocabProfileClear.kept.vocab", { words: numbers.format(preview.vocabWords) }) : null,
    t("vocabProfileClear.kept.records"),
    t("vocabProfileClear.kept.bands"),
  ].filter((line): line is string => line !== null);

  return (
    <div
      className="motion-scrim fixed inset-0 z-[60] flex items-center justify-center bg-overlay px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="clear-vocab-profile-title"
        className="motion-dialog w-[480px] max-w-full rounded-lg border border-border bg-bg-surface p-5 shadow-popover"
      >
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-danger-bg text-danger-text">
            <Trash2 size={18} />
          </div>
          <div className="min-w-0">
            <h2 id="clear-vocab-profile-title" className="text-[16px] font-semibold text-text-primary">
              {busy ? t("vocabProfileClear.busyTitle") : t("vocabProfileClear.title")}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-text-secondary">
              {busy
                ? progress && progress.total > 0
                  ? t("vocabProfileClear.busyMessage", {
                    total: numbers.format(progress.total),
                    cleared: numbers.format(progress.cleared),
                  })
                  : t("vocabProfileClear.busyMessageUnknown")
                : t("vocabProfileClear.message")}
            </p>
          </div>
        </div>

        {busy ? (
          <div
            className="mt-4 h-[3px] overflow-hidden rounded-full bg-bg-input"
            role="progressbar"
            aria-valuetext={t("vocabProfileClear.busyTitle")}
          >
            <div className="difficulty-scan h-full w-1/3 rounded-full bg-accent/75" />
          </div>
        ) : (
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <ClearColumn
              heading={t("vocabProfileClear.gone.heading")}
              lines={gone}
              placeholder={t("vocabProfileClear.counting")}
              danger
            />
            <ClearColumn
              heading={t("vocabProfileClear.kept.heading")}
              lines={kept}
              placeholder={t("vocabProfileClear.counting")}
            />
          </div>
        )}

        {error ? (
          <p role="alert" className="mt-3 text-[12px] text-danger-text">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2.5">
          <span className="mr-auto max-w-[250px] text-[10.5px] leading-[1.6] text-text-muted">
            {t("vocabProfileClear.deviceNote")}
          </span>
          <Button ref={cancelRef} type="button" variant="ghost" size="md" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <button
            type="button"
            disabled={busy || preview === null}
            onClick={() => void start()}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center rounded-lg bg-danger px-3 text-[14px] font-medium text-white transition-colors hover:bg-danger-hover disabled:pointer-events-none disabled:opacity-60"
          >
            {busy ? t("vocabProfileClear.busyConfirm") : t("vocabProfileClear.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ClearColumn({
  heading,
  lines,
  placeholder,
  danger = false,
}: {
  heading: string;
  lines: string[];
  placeholder: string;
  danger?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${danger ? "border-danger-border" : "border-border"}`}>
      <h3 className={`text-[11.5px] font-semibold ${danger ? "text-danger-text" : "text-text-primary"}`}>
        {heading}
      </h3>
      <ul>
        {lines.length === 0 ? (
          <li className="mt-[7px] text-[11px] leading-[1.6] text-text-muted">{placeholder}</li>
        ) : (
          lines.map((line) => (
            <li key={line} className="relative mt-[7px] pl-3 text-[11px] leading-[1.6] text-text-muted">
              <span
                className="absolute left-0 top-[7px] size-1 rounded-full bg-current opacity-50"
                aria-hidden="true"
              />
              {line}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
