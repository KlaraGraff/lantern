import { useTranslation } from "react-i18next";
import { BookOpen, RotateCcw } from "lucide-react";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { timeAgo } from "../../utils/timeAgo";
import { contextualReviewAnswer } from "./contextual-review";
import { glossOf, parseDefinition } from "./entry-text";
import type { MergedVocabEntry } from "./merge";
import VocabEntryDetails from "./VocabEntryDetails";

const MASTERY_LEVELS = ["new", "learning", "mastered"] as const;
export type MasteryLevel = (typeof MASTERY_LEVELS)[number];

export interface MergedVocabDetailsProps {
  entry: MergedVocabEntry;
  onOpenRow: (row: DictionaryWord) => void;
  onSetPrimary: (rowId: string) => void;
  onSetMastery: (mastery: MasteryLevel) => void;
}

/** One saved sentence, tied back to the book and place it came from. */
function Encounter({
  row,
  onOpen,
}: {
  row: DictionaryWord;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const sentence = row.context_sentence?.trim() || null;
  const marked = contextualReviewAnswer(sentence, row.word);
  return (
    <div className="rounded-md border border-border-light bg-bg-muted px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
        <BookOpen size={10} className="shrink-0" />
        <span className="max-w-[180px] truncate">{row.book_title || t("common.unknownBook")}</span>
        {row.chapter && <>
          <span aria-hidden="true">·</span>
          <span className="max-w-[150px] truncate">{row.chapter}</span>
        </>}
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{timeAgo(row.created_at)}</span>
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[10px] text-accent-text hover:bg-accent-bg cursor-pointer"
        >
          {t("vocab.merged.backToSource")}
        </button>
      </div>
      {sentence && (
        <p className="mt-1.5 font-serif text-[12px] leading-[1.7] text-text-secondary">
          {marked
            ? <>{marked.before}<mark className="rounded bg-accent-bg px-0.5 font-semibold text-accent-text">{marked.answer}</mark>{marked.after}</>
            : sentence}
        </p>
      )}
    </div>
  );
}

/**
 * The expanded body of a word that lives in more than one book: one definition,
 * every place it was met, the notes, and a single mastery control — because
 * after the merge there is only one schedule to move.
 */
export default function MergedVocabDetails({
  entry,
  onOpenRow,
  onSetPrimary,
  onSetMastery,
}: MergedVocabDetailsProps) {
  const { t } = useTranslation();
  const bookCount = entry.books.length;

  return (
    <>
      <VocabEntryDetails
        word={entry.primary}
        onOpenInReader={() => onOpenRow(entry.primary)}
        afterDefinition={entry.altRows.length > 0 && (
          <details className="rounded-md border border-dashed border-border bg-bg-muted px-2.5 py-2">
            <summary className="cursor-pointer text-[11px] text-accent-text">
              {t("vocab.merged.altDefinitions", { count: entry.altRows.length })}
            </summary>
            {entry.altRows.map((row) => (
              <div key={row.id} className="mt-2 border-t border-border-light pt-2">
                <p className="text-[12px] leading-[1.6] text-text-secondary">
                  {glossOf(parseDefinition(row.definition).definition)}
                </p>
                <div className="mt-1 flex items-center gap-2 text-[10px] text-text-muted">
                  <span className="min-w-0 truncate">
                    {t("vocab.entry.savedIn", { source: row.book_title || t("common.unknownBook") })}
                  </span>
                  <button
                    type="button"
                    onClick={() => onSetPrimary(row.id)}
                    className="ml-auto flex h-5 shrink-0 items-center rounded px-1.5 text-[10px] text-accent-text hover:bg-accent-bg cursor-pointer"
                  >
                    {t("vocab.merged.makePrimary")}
                  </button>
                </div>
              </div>
            ))}
            <p className="mt-2 text-[10px] leading-[1.5] text-text-muted">{t("vocab.merged.altHint")}</p>
          </details>
        )}
        encounters={(
          <section className="flex flex-col gap-1.5">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
              {t("vocab.merged.encounters", { count: bookCount })}
            </h3>
            {entry.rows.map((row) => (
              <Encounter key={row.id} row={row} onOpen={() => onOpenRow(row)} />
            ))}
          </section>
        )}
      />
      <div className="flex flex-wrap items-center gap-2 border-t border-border-light px-3 pb-3 pt-2.5">
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-input p-0.5">
          {MASTERY_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={entry.primary.mastery === level}
              onClick={() => onSetMastery(level)}
              className={`h-6 rounded px-2 text-[11px] cursor-pointer ${
                entry.primary.mastery === level
                  ? "bg-bg-surface font-semibold text-accent-text"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {t(`vocab.mastery.${level}`)}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-text-muted">
          <RotateCcw size={10} className="shrink-0" />
          {t("vocab.merged.masterySharedHint", { count: bookCount })}
        </span>
      </div>
    </>
  );
}
