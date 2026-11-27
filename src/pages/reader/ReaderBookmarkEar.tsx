import { useTranslation } from "react-i18next";

/**
 * The bookmark ear (design §12): a small tab on the right edge that keeps an
 * answer in reach. It holds the conversation when the right card is shut
 * while an answer is still being written, and learning cards whose sentence a
 * page turn took away (`answer-fold.ts`). Its dot breathes while what it holds
 * is still being written; a click brings it back.
 */
export default function ReaderBookmarkEar({
  holds,
  writing,
  onOpen,
}: {
  holds: "conversation" | "cards";
  writing: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const label = holds === "cards" ? t("reader.side.foldedCards") : t("reader.side.answerWaiting");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="absolute right-0 top-1/3 z-30 grid h-9 w-7 cursor-pointer place-items-center rounded-l-lg border border-r-0 border-border bg-bg-surface shadow-popover transition-colors hover:bg-bg-muted"
    >
      <span
        aria-hidden
        className={writing
          ? "size-2 rounded-full bg-accent animate-pulse motion-reduce:animate-none"
          : "size-2 rounded-full bg-accent"}
      />
    </button>
  );
}
