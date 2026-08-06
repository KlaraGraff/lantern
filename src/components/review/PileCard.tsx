import { Book, History, BookOpen, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { timeAgo } from "../../utils/timeAgo";
import { capPileChips, pileReasonKey, pileTitleKey, type ReviewPile } from "./review-piles";

const PILE_ICONS = {
  repeat_lookups_in_book: Book,
  promoted_then_looked_up: History,
  recent_chapter_lookups: BookOpen,
  long_unseen: Clock,
} as const;

interface PileCardProps {
  pile: ReviewPile;
  /** The "还有" section's long_unseen pile: dashed border, no chips — its 来由 has no story to illustrate. */
  quiet?: boolean;
}

export default function PileCard({ pile, quiet = false }: PileCardProps) {
  const { t } = useTranslation();
  const Icon = PILE_ICONS[pile.kind.kind];
  const title = pileTitleKey(pile.kind);
  // `ago` only matters for recent_chapter_lookups; computing it unconditionally
  // would be harmless but pointless for the other three kinds.
  const ago = pile.kind.kind === "recent_chapter_lookups" ? timeAgo(pile.newest_activity_at) : undefined;
  const reason = pileReasonKey(pile, ago);
  const { visible, overflow } = capPileChips(pile.words);

  return (
    <div
      className={`flex flex-col gap-[9px] rounded-[14px] border p-4 pb-[14px] transition-colors ${
        quiet
          ? "border-dashed border-border bg-transparent hover:border-text-muted hover:shadow-none"
          : "border-border bg-bg-surface hover:border-lavender hover:shadow-[0_2px_10px_rgba(124,58,237,0.09)]"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`flex size-[30px] shrink-0 items-center justify-center rounded-[9px] ${
            quiet ? "bg-bg-input text-text-muted" : "bg-accent-bg text-accent"
          }`}
        >
          <Icon size={15} />
        </div>
        <h4 className="text-[14.5px] font-semibold leading-[1.45] tracking-[-0.15px] text-text-primary">
          {t(title.key, title.params)}
        </h4>
        <span
          className={`ml-auto shrink-0 rounded-full px-[9px] py-0.5 text-[13px] font-semibold ${
            quiet ? "bg-bg-input text-text-secondary" : "bg-accent-bg text-accent"
          }`}
        >
          {pile.word_ids.length}
        </span>
      </div>
      <p className="text-[12.8px] leading-[1.6] text-text-secondary">{t(reason.key, reason.params)}</p>
      {/* Piles have no minimum size: a 1-word pile still shows every chip it has, no padding, no overflow. */}
      {!quiet && visible.length > 0 && (
        <div className="mt-px flex flex-wrap gap-[5px]">
          {visible.map((word) => (
            <span
              key={word.id}
              className="rounded-md bg-bg-input px-[9px] py-[2.5px] font-serif text-[12px] tracking-[0.1px] text-text-secondary"
            >
              {word.word}
            </span>
          ))}
          {overflow > 0 && (
            <span className="rounded-md bg-transparent py-[2.5px] pl-0.5 pr-[9px] font-serif text-[12px] tracking-[0.1px] text-text-muted">
              {t("reviewBoard.pile.moreChips", { count: overflow })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
