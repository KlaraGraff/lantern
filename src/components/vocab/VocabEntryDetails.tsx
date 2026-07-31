import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { timeAgo } from "../../utils/timeAgo";
import { LOOKUP_PROSE } from "../lookup-prose";
import { parseDefinition, truncateMiddle } from "./entry-text";
import PronounceButton from "../speech/PronounceButton";

export interface VocabEntryDetailsProps {
  word: DictionaryWord;
  /** Overrides the row's stored book title, e.g. inside a single-book panel. */
  bookTitle?: string;
  /** Omitted when there is nowhere to navigate to. */
  onOpenInReader?: () => void;
}

/**
 * The expanded body shared by every vocabulary surface. Rows differ between the
 * reader panel and the library pages — the pages carry bulk-select and review
 * controls — but what you see when you open a word must not.
 */
export default function VocabEntryDetails({
  word,
  bookTitle,
  onOpenInReader,
}: VocabEntryDetailsProps) {
  const { t } = useTranslation();
  const { definition } = parseDefinition(word.definition);
  const contextSentence = word.context_sentence?.trim() || null;
  const contextExplanation = word.context_explanation?.trim() || null;
  const source = bookTitle ?? word.book_title ?? t("vocab.detail.unknownBook");
  const [dictionary, setDictionary] = useState<string | null>(null);

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

      {definition && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.contextualDefinition")}
          </h3>
          <div className={`${LOOKUP_PROSE} text-[13px] text-text-primary`}>
            <Markdown>{definition}</Markdown>
          </div>
        </section>
      )}

      {dictionary && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.dictionary")}
          </h3>
          <p className="text-[12px] leading-[1.55] text-text-secondary">{dictionary}</p>
        </section>
      )}

      {contextSentence && (
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
      )}

      {contextExplanation && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.inContext")}
          </h3>
          <div className={`${LOOKUP_PROSE} text-[12px] text-text-secondary`}>
            <Markdown>{contextExplanation}</Markdown>
          </div>
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
