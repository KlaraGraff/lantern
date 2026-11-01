import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { trapTabKey } from "../focus-trap";
import Button from "../ui/Button";
import { isResetConfirmed, type ResetDataSummary, type ResetStep } from "./reset-data";

interface ResetDataDialogProps {
  step: Exclude<ResetStep, "closed">;
  summary: ResetDataSummary;
  error: string | null;
  onCancel: () => void;
  onContinue: () => void;
  onConfirm: (typed: string) => void;
}

/**
 * The two confirmation steps of 重置全部数据, then the "resetting" screen the
 * app sits on until it relaunches. Focus starts on 取消 in both steps, so an
 * Enter pressed out of habit backs out instead of going further.
 */
export default function ResetDataDialog({ step, summary, error, onCancel, onContinue, onConfirm }: ResetDataDialogProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const busy = step === "resetting";

  useEffect(() => {
    setTyped("");
    (cancelRef.current ?? dialogRef.current)?.focus();
  }, [step]);

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

  const confirmed = isResetConfirmed(typed);

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
        {step === "explain" && (
          <>
            <h2 id={titleId} className="text-[15px] font-semibold text-text-primary">{t("settings.reset.step1Title")}</h2>
            <p className="mt-2 text-[13px] leading-5 text-text-secondary">{t("settings.reset.step1Lead")}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-5 text-text-primary">
              <li>{t("settings.reset.itemBooks", { count: summary.bookCount })}</li>
              <li>{t("settings.reset.itemAnnotations")}</li>
              <li>{t("settings.reset.itemAi")}</li>
              <li>{t("settings.reset.itemSettings")}</li>
            </ul>
            {summary.syncEnabled && (
              <p className="mt-3 rounded-md border border-border bg-bg-input px-3 py-2 text-[12px] leading-5 text-text-secondary">
                {t("settings.reset.syncNote")}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button ref={cancelRef} variant="secondary" size="sm" onClick={onCancel}>{t("settings.reset.cancel")}</Button>
              <Button size="sm" className="bg-danger hover:bg-danger-hover" onClick={onContinue}>{t("settings.reset.continue")}</Button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (confirmed) onConfirm(typed);
            }}
          >
            <h2 id={titleId} className="text-[15px] font-semibold text-text-primary">{t("settings.reset.step2Title")}</h2>
            <label htmlFor={inputId} className="mt-2 block text-[13px] leading-5 text-text-secondary">
              {t("settings.reset.step2Body")}
            </label>
            <input
              id={inputId}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              aria-label={t("settings.reset.inputLabel")}
              className="field-soft mt-2 h-9 w-full rounded-[10px] bg-white px-3 font-mono text-[14px] tracking-[0.08em] text-text-primary outline-none dark:bg-bg-input"
            />
            {error && <p role="alert" className="mt-2 text-[12px] leading-5 text-danger-text">{error}</p>}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button ref={cancelRef} type="button" variant="secondary" size="sm" onClick={onCancel}>{t("settings.reset.cancel")}</Button>
              <Button type="submit" size="sm" disabled={!confirmed} className="bg-danger hover:bg-danger-hover disabled:opacity-40">
                {t("settings.reset.confirm")}
              </Button>
            </div>
          </form>
        )}

        {step === "resetting" && (
          <>
            <h2 id={titleId} className="text-[15px] font-semibold text-text-primary">{t("settings.reset.progressTitle")}</h2>
            <p className="mt-2 text-[13px] leading-5 text-text-secondary">{error ?? t("settings.reset.progressBody")}</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
