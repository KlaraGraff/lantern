import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useBookDifficulty } from "../hooks/useBookDifficulty";
import { useBookDifficultySections, useBookLookupStats, useVocabPassRates } from "../hooks/useOpenCardData";
import RidgeChart from "./RidgeChart";
import { bandShares, classifyRidge, roundPercent, weightedHardShare, type BandPassRates } from "./book-open-card-view";

const AUTO_COLLAPSE_MS = 2000;

interface BookReaderDifficultyStripProps {
  book: Pick<Book, "id" | "format" | "status" | "progress">;
  /** `TocChapter.title` at the reader's current position, when Foliate has
   *  resolved one. `undefined` renders the strip without a chapter name
   *  rather than a placeholder. */
  currentChapterTitle?: string;
}

/**
 * Mockup §5's reader-top strip: the downgrade a book already `"reading"`
 * gets instead of the full open card. Starts expanded for ~2s so a reader
 * who just resumed sees it once, then collapses to one line on its own —
 * never re-expands by itself, only a tap does that.
 */
export default function BookReaderDifficultyStrip({ book, currentChapterTitle }: BookReaderDifficultyStripProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (userToggled) return;
    const timer = window.setTimeout(() => setExpanded(false), AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [userToggled]);

  const { difficulty } = useBookDifficulty(book.id);
  const sections = useBookDifficultySections(book.id);
  const lookupStats = useBookLookupStats(book.id);
  const passRates = useVocabPassRates(true);

  const ridge = useMemo(
    () => (difficulty ? classifyRidge(sections.value ?? [], book, difficulty.status) : { kind: "unavailable" as const }),
    [difficulty, sections.value, book],
  );

  const passRateTuple: BandPassRates = passRates.value?.bandPassRates ?? [null, null, null, null, null];
  const weightedPercent = difficulty ? roundPercent(weightedHardShare(bandShares(difficulty), passRateTuple)) : null;

  const hasChapterData = ridge.kind === "flat" || ridge.kind === "peak";
  const ridgeBars = hasChapterData ? ridge.bars : [];

  // The position marker is an estimate — the reader's progress fraction
  // mapped onto the same bars the ridge chart already drew — not a real
  // section lookup. Good enough for "roughly here", which is all a marker on
  // a chart this coarse claims to be.
  const currentBarIndex = ridgeBars.length > 0
    ? Math.min(ridgeBars.length - 1, Math.floor((book.progress / 100) * ridgeBars.length))
    : -1;
  const markerSectionOrder = currentBarIndex >= 0 ? ridgeBars[currentBarIndex].sectionOrder : null;

  // Only ever "the hard part is behind you" or a neutral fact — never "the
  // hard part is still ahead". Nothing in the mockup names an "ahead" line,
  // and the card's own rule elsewhere ("不挽留") reads as a broader "don't
  // discourage" stance, so a peak the reader has not reached yet falls back
  // to the neutral whole-book share instead of a warning.
  let positionLine: string | null = null;
  if (ridge.kind === "flat") {
    positionLine = t("bookOpenCard.readingStrip.flatBehind");
  } else if (ridge.kind === "peak") {
    const peakIndex = ridgeBars.findIndex((bar) => bar.sectionOrder === ridge.peakSectionOrder);
    if (peakIndex >= 0 && peakIndex <= currentBarIndex) {
      positionLine = t("bookOpenCard.readingStrip.peakBehind", { title: ridge.peakTitle });
    } else if (weightedPercent !== null) {
      positionLine = t("bookOpenCard.readingStrip.wholeBookShare", {
        share: t("bookOpenCard.sharePercent", { percent: weightedPercent }),
      });
    }
  }

  const progressLine = t("bookOpenCard.readingStrip.progress", { percent: Math.round(book.progress) });
  const stats = lookupStats.value;

  return (
    <div className="shrink-0 border-b border-border bg-bg-muted px-section">
      <button
        type="button"
        onClick={() => { setUserToggled(true); setExpanded((v) => !v); }}
        className="flex w-full items-center justify-between gap-3 py-1.5 text-left"
      >
        <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-text-secondary">
          <span className="shrink-0 font-medium text-text-primary">{progressLine}</span>
          {!expanded && positionLine ? (
            <span className="truncate text-text-muted">{positionLine}</span>
          ) : null}
        </span>
        {expanded ? <ChevronUp size={13} className="shrink-0 text-text-muted" /> : <ChevronDown size={13} className="shrink-0 text-text-muted" />}
      </button>

      {expanded ? (
        <div className="pb-3">
          {currentChapterTitle ? (
            <p className="m-0 text-[11px] text-text-muted">
              {t("bookOpenCard.readingStrip.chapter", { chapter: currentChapterTitle })}
            </p>
          ) : null}
          {positionLine ? (
            <p className="mt-1 text-[12px] leading-[1.6] text-text-secondary">{positionLine}</p>
          ) : null}
          {ridgeBars.length > 0 ? (
            <RidgeChart bars={ridgeBars} markerSectionOrder={markerSectionOrder} className="mt-2 max-w-[420px]" />
          ) : null}
          {stats && stats.lookedUpWords > 0 ? (
            <div className="mt-2 text-[11px] leading-[1.7] text-text-muted">
              <p className="m-0">{t("bookOpenCard.readingStrip.lookedUpCount", { count: stats.lookedUpWords })}</p>
              {stats.masteredWords > 0 ? (
                <p className="m-0">{t("bookOpenCard.readingStrip.masteredCount", { count: stats.masteredWords })}</p>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => { setUserToggled(true); setExpanded(false); }}
            className="mt-2 text-[11px] font-medium text-accent-text"
          >
            {t("bookOpenCard.readingStrip.collapse")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
