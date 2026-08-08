import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";

interface HardLimitDialogProps {
  softLimit: number;
  hardLimit: number;
  onBackToEdit: () => void;
  onOptimize: () => void;
}

/**
 * State ③ — blocking confirm once the user text passes the hard limit
 * (soft × 2). Both manual save and autosave land here; there is no silent
 * truncation path. "回去修改" just closes the dialog — the draft underneath
 * is untouched either way, since the hook never persists text over the hard
 * limit in the first place.
 */
export default function HardLimitDialog({ softLimit, hardLimit, onBackToEdit, onOptimize }: HardLimitDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBackToEdit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onBackToEdit]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay px-4"
      onMouseDown={(event) => event.target === event.currentTarget && onBackToEdit()}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" className="w-[460px] max-w-full rounded-xl border border-border bg-bg-surface shadow-card">
        <div className="px-5 pt-[18px]">
          <h2 className="text-[15.5px] font-semibold text-text-primary">{t("profile.hardLimit.title")}</h2>
          <p className="mt-1.5 text-[12.5px] leading-[1.65] text-text-secondary">
            {t("profile.hardLimit.body", { softLimit, hardLimit })}
          </p>
          <p className="mt-3 rounded-lg bg-bg-muted px-3 py-2.5 text-[11.8px] leading-[1.6] text-text-secondary">
            {t("profile.hardLimit.keep")}
          </p>
        </div>
        <div className="mt-3.5 flex items-center gap-2 border-t border-border-light px-5 py-3.5">
          <Button variant="ghost" size="sm" onClick={onBackToEdit}>{t("profile.hardLimit.backToEdit")}</Button>
          <span className="flex-1" />
          <Button size="sm" onClick={onOptimize}>{t("profile.optimize")}</Button>
        </div>
      </div>
    </div>
  );
}
