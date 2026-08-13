import { lazy, Suspense, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DictionaryWord } from "../../hooks/useDictionary";
import PronounceButton from "../speech/PronounceButton";
import { entryClipboardText, glossOf, parseDefinition } from "./entry-text";

// The markdown renderer it pulls in is only worth paying for once a row is
// actually opened — most of a vocab list never gets expanded in a session.
const VocabEntryDetails = lazy(() => import("./VocabEntryDetails"));

export interface VocabEntryProps {
  word: DictionaryWord;
  /** Overrides the row's stored book title, e.g. inside a single-book panel. */
  bookTitle?: string;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => Promise<void> | void;
  /** Omitted when there is nowhere to navigate to. */
  onOpenInReader?: () => void;
  className?: string;
}

/**
 * The compact vocabulary row used where the list has no other job — currently
 * the reader's side panel. The library pages keep their own rows (bulk select,
 * review controls) and reuse `VocabEntryDetails` for the expanded body.
 */
export default function VocabEntry({
  word,
  bookTitle,
  expanded,
  onToggle,
  onDelete,
  onOpenInReader,
  className = "",
}: VocabEntryProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gloss = glossOf(parseDefinition(word.definition).definition);
  const source = bookTitle ?? word.book_title ?? t("vocab.detail.unknownBook");

  const handleCopy = () => {
    // Copies the whole entry even when collapsed — the row is a summary, not
    // what the user means when they say "copy this word".
    navigator.clipboard.writeText(entryClipboardText(word, source));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimer.current = setTimeout(() => {
        setConfirmingDelete(false);
        confirmTimer.current = null;
      }, 3000);
      return;
    }
    if (confirmTimer.current) {
      clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    await onDelete();
  };

  return (
    <div className={`rounded-r-lg border-l-[3px] border-accent bg-bg-surface ${className}`}>
      {/* The toggle and the actions are siblings — never nested buttons. */}
      <div className="flex min-h-[40px] items-center gap-1.5 pl-3 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        >
          {expanded
            ? <ChevronDown size={13} className="shrink-0 text-text-muted" />
            : <ChevronRight size={13} className="shrink-0 text-text-muted" />}
          <span className="shrink-0 text-[14px] font-semibold leading-5 text-text-primary">
            {word.word}
          </span>
          {gloss && (
            <span className="min-w-0 flex-1 truncate text-[12px] leading-5 text-text-secondary">
              {gloss}
            </span>
          )}
        </button>
        {/* Moves into the expanded body once open, so only one is ever shown. */}
        {!expanded && <PronounceButton text={word.word} />}
        <button
          type="button"
          onClick={handleCopy}
          title={t("vocab.entry.copy")}
          aria-label={t("vocab.entry.copy")}
          className="tap-44 flex size-6 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          title={confirmingDelete ? t("vocab.detail.deleteConfirm") : t("vocab.detail.delete")}
          aria-label={confirmingDelete ? t("vocab.detail.deleteConfirm") : t("vocab.detail.delete")}
          className={`flex size-6 shrink-0 items-center justify-center rounded-md ${
            confirmingDelete
              ? "text-danger-text"
              : "text-text-muted hover:bg-bg-input hover:text-danger-text"
          }`}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {expanded && (
        <Suspense fallback={null}>
          <VocabEntryDetails word={word} bookTitle={bookTitle} onOpenInReader={onOpenInReader} />
        </Suspense>
      )}
    </div>
  );
}
