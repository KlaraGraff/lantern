import { useTranslation } from "react-i18next";

/**
 * The bookmark ear (design §12): when the right card is shut while an answer
 * is still being written, a small tab on the right edge keeps it in reach —
 * its dot breathes until the answer is done, and a click brings the
 * conversation back.
 */
export default function ReaderBookmarkEar({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("reader.side.answerWaiting")}
      title={t("reader.side.answerWaiting")}
      className="absolute right-0 top-1/3 z-30 grid h-9 w-7 cursor-pointer place-items-center rounded-l-lg border border-r-0 border-border bg-bg-surface shadow-popover transition-colors hover:bg-bg-muted"
    >
      <span aria-hidden className="size-2 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
    </button>
  );
}
