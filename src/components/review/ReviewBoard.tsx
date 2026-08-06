import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import Button from "../ui/Button";
import PileCard from "./PileCard";
import { pileKey, splitReviewPiles, type ReviewPile } from "./review-piles";

interface ReviewBoardProps {
  /** Distinct saved-word count, for the empty state's "see all N words" copy. */
  totalWordCount: number;
  onSeeAllWords: () => void;
}

/**
 * The 回顾/"Review" board: piles built from what the reader actually did
 * (repeat lookups, a word promoted then looked up again, a chapter just
 * finished, words gone quiet) — never a raw due-count. See
 * docs/impls/review-entry-mockup.html §2 for the design of record.
 */
export default function ReviewBoard({ totalWordCount, onSeeAllWords }: ReviewBoardProps) {
  const { t } = useTranslation();
  const [piles, setPiles] = useState<ReviewPile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ReviewPile[]>("list_review_piles")
      .then((result) => { if (!cancelled) setPiles(result); })
      .catch((err) => {
        console.error("Failed to load review piles:", err);
        if (!cancelled) setPiles([]);
      });
    return () => { cancelled = true; };
  }, []);

  // Nothing renders while the first fetch is in flight — a spinner here would
  // outlive its usefulness on every subsequent visit once piles are cached.
  if (piles === null) return null;

  const { cards, longUnseen } = splitReviewPiles(piles);
  const isEmpty = cards.length === 0 && !longUnseen;

  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-[9px]">
        <RotateCcw size={17} className="text-accent" />
        <h3 className="text-[15px] font-semibold tracking-[-0.2px] text-text-primary">{t("reviewBoard.title")}</h3>
        <span className="ml-auto text-[12.5px] text-text-muted">{t("reviewBoard.subtitle")}</span>
      </div>
      {isEmpty ? (
        <div className="flex flex-col items-start gap-2">
          <h4 className="text-[15px] font-semibold text-text-primary">{t("reviewBoard.empty.heading")}</h4>
          <p className="max-w-[480px] text-[13.5px] text-text-secondary">{t("reviewBoard.empty.body")}</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={onSeeAllWords}>
            {t("reviewBoard.empty.seeAllWords", { count: totalWordCount })}
          </Button>
        </div>
      ) : (
        <>
          {cards.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {cards.map((pile) => (
                <PileCard key={pileKey(pile)} pile={pile} />
              ))}
            </div>
          )}
          {longUnseen && (
            <div className="mt-3.5 border-t border-border pt-3.5">
              <p className="mb-[9px] text-[12.5px] text-text-muted">{t("reviewBoard.also")}</p>
              <PileCard pile={longUnseen} quiet />
            </div>
          )}
        </>
      )}
    </div>
  );
}
