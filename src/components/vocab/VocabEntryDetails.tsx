import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { notifyReaders } from "../../utils/notifyReaders";
import { timeAgo } from "../../utils/timeAgo";
import AiMarkdown from "../ai-markdown/AiMarkdown";
import { parseDefinition, truncateMiddle } from "./entry-text";
import PronounceButton from "../speech/PronounceButton";

interface WordNote {
  id: string;
  book_title: string | null;
  scope: "book" | "global" | "detached";
  content: string;
  updated_at: number;
}

export interface VocabEntryDetailsProps {
  word: DictionaryWord;
  /** Overrides the row's stored book title, e.g. inside a single-book panel. */
  bookTitle?: string;
  /** Omitted when there is nowhere to navigate to. */
  onOpenInReader?: () => void;
  /** Slot under the definition — the folded sibling definitions of a merged entry. */
  afterDefinition?: ReactNode;
  /**
   * Replaces the single saved sentence. A word merged across books has one
   * context per book, and listing them here keeps the section in the place the
   * reader already looks for it.
   */
  encounters?: ReactNode;
}

/**
 * The expanded body shared by every vocabulary surface. Rows differ between the
 * reader panel and the library pages — the pages carry bulk-select and review
 * controls — but what you see when you open a word must not.
 */
export default function VocabEntryDetails({
  word: savedWord,
  bookTitle,
  onOpenInReader,
  afterDefinition,
  encounters,
}: VocabEntryDetailsProps) {
  const { t, i18n } = useTranslation();
  // The regenerated row, once there is one. The list that owns `savedWord`
  // reloads on `vocab-changed`, but the panel the button lives in must not
  // wait for that round trip to show what the reader just paid for.
  const [regenerated, setRegenerated] = useState<DictionaryWord | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState(false);
  const word = regenerated ?? savedWord;
  const { definition } = parseDefinition(word.definition);
  const contextSentence = word.context_sentence?.trim() || null;
  const contextExplanation = word.context_explanation?.trim() || null;
  const source = bookTitle ?? word.book_title ?? t("vocab.detail.unknownBook");
  const [dictionary, setDictionary] = useState<string | null>(null);
  const [notes, setNotes] = useState<WordNote[]>([]);

  // A merged entry can swap which row is primary under a mounted panel; the
  // previous row's regenerated text must not survive that.
  useEffect(() => {
    setRegenerated(null);
    setRegenerateError(false);
  }, [savedWord.id]);

  const regenerate = async () => {
    setRegenerating(true);
    setRegenerateError(false);
    try {
      const updated = await invoke<Partial<DictionaryWord>>("regenerate_vocab_definition", {
        id: savedWord.id,
        // The reader's own UI language, the same choice the save path makes.
        locale: i18n.resolvedLanguage || i18n.language || null,
      });
      setRegenerated({ ...word, ...updated });
      // The definition is printed above the word in the book and listed in
      // every vocabulary surface, so the change is not this panel's alone.
      notifyReaders("vocab-changed", {
        bookId: word.book_id,
        cfi: word.cfi ?? undefined,
      });
    } catch (error) {
      console.error("Failed to regenerate vocabulary definition:", error);
      setRegenerateError(true);
    } finally {
      setRegenerating(false);
    }
  };

  // Only mounted while expanded, so this is the lazy load. A miss is silent —
  // the section simply does not appear.
  useEffect(() => {
    let cancelled = false;
    invoke<{ explain: string }>("dictionary_gloss", { word: word.word })
      .then((entry) => {
        if (!cancelled) setDictionary(entry.explain.trim() || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [word.word]);

  // What the reader wrote about this word, from any book. The note was written
  // in the lookup card; review is exactly when it is worth the most, so the
  // entry has to carry it rather than leave it behind in the reader.
  useEffect(() => {
    let cancelled = false;
    invoke<{ notes: WordNote[] }>("list_notes", {
      bookId: null,
      anchorKind: "word",
      word: word.word,
      search: null,
      updatedAfter: null,
      updatedBefore: null,
      cursor: null,
      limit: 20,
    })
      .then((page) => {
        if (!cancelled) setNotes(page.notes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [word.word]);

  return (
    <div className="flex flex-col gap-3 border-t border-border-light px-3 pb-3 pt-2.5">
      <div className="flex items-center justify-between gap-3">
        <PronounceButton text={word.word} />
        {onOpenInReader && (
          <button
            type="button"
            onClick={onOpenInReader}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-accent-text hover:bg-accent-bg"
          >
            {t("vocab.detail.openInReader")}
            <ArrowRight size={13} />
          </button>
        )}
      </div>

      {/* Always rendered, so the one control that can change a saved
          definition is always there — a button that appeared only for glosses
          that look damaged would be missing exactly when a reader wants to
          reword a valid but unhelpful one. */}
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.contextualDefinition")}
          </h3>
          <button
            type="button"
            onClick={() => { void regenerate(); }}
            disabled={regenerating}
            title={t("vocab.detail.regenerate")}
            aria-label={t("vocab.detail.regenerate")}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-accent-text hover:bg-accent-bg disabled:cursor-default disabled:text-text-muted disabled:hover:bg-transparent"
          >
            <RefreshCw size={11} className={regenerating ? "animate-spin" : ""} />
            {regenerating ? t("vocab.detail.regenerating") : t("vocab.detail.regenerate")}
          </button>
        </div>
        {definition && (
          <AiMarkdown size="compact" className="text-[13px] text-text-primary">
            {definition}
          </AiMarkdown>
        )}
        {regenerateError && (
          <p className="text-[11px] leading-[1.5] text-danger-text">
            {t("vocab.detail.regenerateFailed")}
          </p>
        )}
      </section>

      {afterDefinition}

      {dictionary && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.dictionary")}
          </h3>
          <p className="text-[12px] leading-[1.55] text-text-secondary">{dictionary}</p>
        </section>
      )}

      {encounters ?? (contextSentence && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.fromBook")}
          </h3>
          <blockquote className="border-l-2 border-lavender py-0.5 pl-3">
            <p className="text-[12px] italic leading-[1.5] text-text-secondary">
              &ldquo;{contextSentence}&rdquo;
            </p>
          </blockquote>
        </section>
      ))}

      {contextExplanation && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.inContext")}
          </h3>
          <AiMarkdown size="compact" highlightTerm={word.word} className="text-[12px] text-text-secondary">
            {contextExplanation}
          </AiMarkdown>
        </section>
      )}

      {notes.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.myNotes")}
          </h3>
          {notes.map((note) => (
            <div key={note.id} className="rounded-md border border-border-light bg-bg-muted px-2.5 py-2">
              <p className="whitespace-pre-line text-[12px] leading-[1.55] text-text-primary">
                {note.content}
              </p>
              <p className="mt-1 text-[10px] text-text-muted">
                {note.scope === "global"
                  ? t("vocab.detail.noteGlobal")
                  : t("vocab.detail.noteFromBook", {
                      source: truncateMiddle(note.book_title || t("vocab.detail.unknownBook")),
                    })}
              </p>
            </div>
          ))}
        </section>
      )}

      <div className="flex items-baseline justify-between gap-3 border-t border-border-light pt-2 text-[11px] text-text-muted">
        <span className="min-w-0 truncate">
          {t("vocab.entry.savedIn", { source: truncateMiddle(source) })}
        </span>
        <span className="shrink-0">{timeAgo(word.created_at)}</span>
      </div>
    </div>
  );
}
