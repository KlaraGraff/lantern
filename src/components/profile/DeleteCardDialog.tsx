import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import Button from "../ui/Button";

interface DeleteCardDialogProps {
  slotLabel: string;
  onCancel: () => void;
  /**
   * "移动到上段修改" — the escape hatch, since most delete clicks really mean
   * this. Synchronous: it only closes this dialog and opens the move-edit
   * flow (state ⑤) in the editor above — no network call happens here. The
   * move itself only reaches the backend when the reader explicitly presses
   * "保存" in that editor.
   */
  onMoveInstead: () => void;
  onConfirmDelete: () => Promise<void>;
  /** Only one move-edit can be pending at a time — disables this escape hatch while another card's move is already open in the editor above. */
  moveDisabled?: boolean;
}

/**
 * State ⑥ — deleting a single system card. Framed around the watermark
 * mechanic (docs/impls/user-profile.md §7 `profile_delete_card`): deleting
 * only stops *past* follow-ups from feeding this dimension again, it doesn't
 * blacklist the dimension forever. The dialog leads with "移动" as the
 * better fit for "it's just worded wrong" — deletion is for "stop tracking
 * this," which is a narrower ask than most delete clicks turn out to mean.
 */
export default function DeleteCardDialog({ slotLabel, onCancel, onMoveInstead, onConfirmDelete, moveDisabled }: DeleteCardDialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"delete" | null>(null);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  const runDelete = async () => {
    setBusy("delete");
    try {
      await onConfirmDelete();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-overlay px-4"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onCancel()}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" className="w-[460px] max-w-full rounded-xl border border-border bg-bg-surface shadow-card">
        <div className="px-5 pt-[18px]">
          <h2 className="text-[15.5px] font-semibold text-text-primary">{t("profile.deleteCard.title", { slot: slotLabel })}</h2>
          <p className="mt-1.5 text-[12.5px] leading-[1.65] text-text-secondary">{t("profile.deleteCard.body")}</p>

          <ul className="mt-3.5 border-t border-border-light">
            <li className="flex gap-2.5 border-b border-border-light py-2.5 text-[12.2px] leading-[1.55]">
              <b className="w-[92px] shrink-0 font-semibold text-text-primary">{t("profile.deleteCard.comeBackQ")}</b>
              <span className="text-text-secondary">{t("profile.deleteCard.comeBackA")}</span>
            </li>
            <li className="flex gap-2.5 border-b border-border-light py-2.5 text-[12.2px] leading-[1.55]">
              <b className="w-[92px] shrink-0 font-semibold text-text-primary">{t("profile.deleteCard.untouchedQ")}</b>
              <span className="text-text-secondary">{t("profile.deleteCard.untouchedA")}</span>
            </li>
          </ul>

          <p className="mt-3.5 rounded-lg bg-bg-muted px-3 py-2.5 text-[11.8px] leading-[1.6] text-text-secondary">
            {t("profile.deleteCard.suggestMove")}
          </p>
        </div>
        <div className="mt-3.5 flex items-center gap-2 border-t border-border-light px-5 py-3.5">
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onCancel}>{t("common.cancel")}</Button>
          <span className="flex-1" />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null || moveDisabled}
            title={moveDisabled ? t("profile.move.alreadyPending") : undefined}
            onClick={onMoveInstead}
          >
            {t("profile.moveToText")}
          </Button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void runDelete()}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-danger px-3 text-[13px] font-medium text-white transition-colors hover:bg-danger-hover disabled:pointer-events-none disabled:opacity-50"
          >
            {busy === "delete" && <Loader2 size={14} className="animate-spin" />}
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
