import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useBookDifficulty } from "../hooks/useBookDifficulty";
import { useBookDifficultySections, useBookLookupStats, useVocabPassRates } from "../hooks/useOpenCardData";
import RidgeChart from "./RidgeChart";
import { useOpenCardControls } from "./BookOpenGateProvider";
import { AUTO_DISMISS_MS, isPageTurn, isRearmed, markDismissed } from "./reading-strip-dismissal";
import { bandShares, classifyRidge, roundPercent, weightedHardShare, type BandPassRates } from "./book-open-card-view";

interface BookReaderDifficultyStripProps {
  book: Pick<Book, "id" | "format" | "status" | "progress">;
  /** `TocChapter.title` at the reader's current position, when Foliate has
   *  resolved one. `undefined` renders the strip without a chapter name
   *  rather than a placeholder. */
  currentChapterTitle?: string;
  /** Bumped by `Reader` on every relocate — page turns and jumps alike. The
   *  strip only needs to know the reader moved, not why. */
  locationTick?: number;
}

/**
 * Mockup §5's reader-top strip: the downgrade a book already `"reading"`
 * gets instead of the full open card.
 *
 * Shows expanded, says its piece, and then leaves — see
 * `reading-strip-dismissal.ts` for the three exits. It used to collapse to a
 * one-line bar instead of leaving, which meant every reading screen
 * permanently gave up a strip of its top edge to a sentence the reader had
 * already read.
 *
 * Those three exits are all "not now". "Not ever" is `hideOpenCardForever`,
 * which is the whole feature's switch, not this book's — see
 * `useOpenCardControls`. Deliberately not per-book: a per-book hide would need
 * somewhere to list and un-hide the books it had been used on, which is a
 * settings screen's worth of machinery for a banner that already leaves on its
 * own after six seconds.
 */
export default function BookReaderDifficultyStrip({
  book,
  currentChapterTitle,
  locationTick = 0,
}: BookReaderDifficultyStripProps) {
  const { t } = useTranslation();
  const { openCardEnabled, hideOpenCardForever } = useOpenCardControls();
  const mountedAtRef = useRef(Date.now());
  const [visible, setVisible] = useState(() => isRearmed(book.id, Date.now()));
  // The auto-dismiss timer holds while the pointer is on the strip: a reader
  // who is looking at the ridge chart is not a reader who has finished with it.
  const [hovered, setHovered] = useState(false);

  const dismiss = useCallback(() => {
    markDismissed(book.id, Date.now());
    setVisible(false);
  }, [book.id]);

  useEffect(() => {
    if (!visible || hovered) return;
    const timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [visible, hovered, dismiss]);

  useEffect(() => {
    if (!visible) return;
    if (!isPageTurn(mountedAtRef.current, Date.now())) return;
    dismiss();
  }, [locationTick, visible, dismiss]);

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

  if (!visible || !openCardEnabled) return null;

  return (
    <div
      className="shrink-0 border-b border-border bg-bg-muted px-section pb-3"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex w-full items-center justify-between gap-3 py-1.5">
        <span className="flex min-w-0 items-center gap-2 text-[11.5px] text-text-secondary">
          <span className="shrink-0 font-medium text-text-primary">{progressLine}</span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {/* The same copy and the same key as the card's own button — a reader
              who turns it off here has turned off both surfaces, which is the
              only reading of "不再显示开书卡" that is not a lie. */}
          <button
            type="button"
            onClick={hideOpenCardForever}
            className="text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            {t("bookOpenCard.hideForever")}
          </button>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("bookOpenCard.readingStrip.dismiss")}
            title={t("bookOpenCard.readingStrip.dismiss")}
            className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary"
          >
            <X size={13} />
          </button>
        </span>
      </div>

      {currentChapterTitle ? (
        <p className="m-0 text-[11px] text-text-muted">
          {t("bookOpenCard.readingStrip.chapter", { chapter: currentChapterTitle })}
        </p>
      ) : null}
      {positionLine ? (
        <p className="mt-1 text-[12px] leading-[1.6] text-text-secondary">{positionLine}</p>
      ) : null}
      {ridgeBars.length > 0 ? (
        // `mt-5` rather than `mt-2` when the "你在这里" marker is drawn: that
        // label is absolutely positioned above the bars (`-top-4` in
        // `RidgeChart`) and lands on the line above without the clearance.
        <RidgeChart
          bars={ridgeBars}
          markerSectionOrder={markerSectionOrder}
          className={`${markerSectionOrder !== null ? "mt-5" : "mt-2"} max-w-[420px]`}
        />
      ) : null}
      {stats && stats.lookedUpWords > 0 ? (
        <div className="mt-2 text-[11px] leading-[1.7] text-text-muted">
          <p className="m-0">{t("bookOpenCard.readingStrip.lookedUpCount", { count: stats.lookedUpWords })}</p>
          {stats.masteredWords > 0 ? (
            <p className="m-0">{t("bookOpenCard.readingStrip.masteredCount", { count: stats.masteredWords })}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
