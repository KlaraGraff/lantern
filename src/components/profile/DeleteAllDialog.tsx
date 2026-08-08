import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import Button from "../ui/Button";

interface DeleteAllDialogProps {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirms "删除整份画像" (the footer button in the mockup's default state).
 * The mockup doesn't render this dialog explicitly, but wiping `user_text`
 * together with every card, event and revision is a heavier, less reversible
 * action than a single card's watermark delete (`profile_delete_all` per
 * docs/impls/user-profile.md §7), so it gets the same confirm-before-destroy
 * treatment as `DeleteBookDialog` rather than firing on one click.
 */
export default function DeleteAllDialog({ onCancel, onConfirm }: DeleteAllDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay px-4"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" className="w-[440px] max-w-full rounded-xl border border-border bg-bg-surface shadow-card p-5">
        <h2 className="text-[15.5px] font-semibold text-text-primary">{t("profile.deleteAll.title")}</h2>
        <p className="mt-1.5 text-[12.5px] leading-[1.65] text-text-secondary">{t("profile.deleteAll.body")}</p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("common.cancel")}</Button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void confirm()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-danger px-3 text-[13px] font-medium text-white transition-colors hover:bg-danger-hover disabled:pointer-events-none disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {t("profile.deleteAll.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
