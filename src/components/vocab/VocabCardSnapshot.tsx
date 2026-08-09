import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { LearningModuleBody } from "../learning-card/LearningCardModules";
import { buildCardSnapshotView, type CardSnapshotView } from "./cardSnapshotView";

/**
 * One global switch, not one per word. Someone who wants the whole card wants
 * it on every word; someone who only scans the list never opens it once. Per
 * word, the state multiplies into something nobody can remember setting.
 *
 * It is deliberately not in the settings screen — it is this control's memory
 * of its own last position, not a feature to turn on.
 */
export const CARD_SNAPSHOT_EXPANDED_KEY = "vocab_card_snapshot_expanded";

export interface VocabCardSnapshotProps {
  wordId: string;
  /** When the word was collected — the card was captured in the same breath. */
  createdAt: number;
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-[9px]" aria-hidden="true">
      {["38%", "92%", "74%"].map((width) => (
        <div key={width} className="h-[9px] animate-pulse rounded-sm bg-border-light" style={{ width }} />
      ))}
      <div className="mt-1.5 h-[9px] w-[31%] animate-pulse rounded-sm bg-border-light" />
      <div className="h-[9px] w-[86%] animate-pulse rounded-sm bg-border-light" />
    </div>
  );
}

/**
 * The whole learning card as it stood the moment the word was collected.
 *
 * It is a snapshot, not a live answer: "Regenerate" above rewrites the one-line
 * meaning and never touches this, so the date has to be on screen or the two
 * halves of the panel look like they contradict each other. An absolute date,
 * not "3 months ago" — the point being made is that this is old.
 */
export default function VocabCardSnapshot({ wordId, createdAt }: VocabCardSnapshotProps) {
  const { t, i18n } = useTranslation();
  const { settings, save } = useSettings();
  const expanded = settings[CARD_SNAPSHOT_EXPANDED_KEY] === "true";
  // `null` while the read is still out. The panel only mounts when the word is
  // opened, so this request is the lazy load.
  const [view, setView] = useState<CardSnapshotView | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    invoke<string | null>("get_vocab_card_snapshot", { wordId })
      .then((json) => {
        if (!cancelled) setView(buildCardSnapshotView(json));
      })
      // A failed read is silent, the same as the dictionary gloss above: there
      // is nothing the reader could do about it and nothing was lost.
      .catch(() => {
        if (!cancelled) setView({ status: "none" });
      });
    return () => {
      cancelled = true;
    };
  }, [wordId]);

  const toggle = () => {
    void save(CARD_SNAPSHOT_EXPANDED_KEY, expanded ? "false" : "true").catch(() => {});
  };

  if (view === null) {
    // Collapsed and still loading: say nothing. A heading that appears and then
    // vanishes on every word without a card is worse than a beat of delay.
    if (!expanded) return null;
    return (
      <div className="border-t border-border-light pt-[9px]">
        <div className="mb-[9px] flex items-baseline justify-between gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.detail.cardSnapshot.title")}
          </h3>
          <span className="shrink-0 text-[10px] text-text-muted">
            {t("vocab.detail.cardSnapshot.loading")}
          </span>
        </div>
        <Skeleton />
      </div>
    );
  }

  // Nothing stored, or nothing left once the two modules printed above are
  // dropped. No greyed-out control, no "no card" line: for a word saved before
  // the card existed, that would be bad news invented out of nothing.
  if (view.status === "none") return null;

  if (view.status === "unreadable") {
    // The only case that speaks. A card *was* stored here, so silence would
    // tell the reader it never was.
    return (
      <div className="border-t border-border-light pt-[9px]">
        <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
          {t("vocab.detail.cardSnapshot.title")}
        </h3>
        <p className="text-[12px] leading-[1.55] text-warning">
          {t("vocab.detail.cardSnapshot.unreadable")}
        </p>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        className="flex w-full cursor-pointer items-center gap-1.5 border-t border-border-light pt-[7px] text-left text-[12px] font-medium text-accent-text"
      >
        <ChevronRight size={13} className="shrink-0" />
        {t("vocab.detail.cardSnapshot.expand")}
        <span className="font-normal text-text-muted">
          {t("vocab.detail.cardSnapshot.moduleCount", { count: view.modules.length })}
        </span>
      </button>
    );
  }

  const savedOn = new Date(createdAt).toLocaleDateString(
    i18n.resolvedLanguage || i18n.language || undefined,
    { year: "numeric", month: "long", day: "numeric" },
  );

  return (
    <div className="border-t border-border-light pt-[9px]">
      <div className="mb-[9px] flex items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded
          className="flex cursor-pointer items-center gap-1.5 text-left text-[12px] font-medium text-accent-text"
        >
          <ChevronDown size={13} className="shrink-0" />
          {t("vocab.detail.cardSnapshot.title")}
        </button>
        <span className="shrink-0 text-[10px] text-text-muted">
          {t("vocab.detail.cardSnapshot.savedOn", { date: savedOn })}
        </span>
      </div>

      {/* Hairlines between the blocks and nothing else — the panel is already
          dense, and a bordered container inside a bordered row is nesting for
          its own sake. */}
      {view.modules.map((module) => (
        <section key={module.id} className="border-t border-border-light py-[9px]">
          <h4 className="mb-[3px] text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t(module.labelKey)}
          </h4>
          <LearningModuleBody
            moduleId={module.id}
            content={module.content}
            // The reader opened this to see what the card said, not a
            // condensed retelling of it — so the widest density, and both
            // counts at the most a live card can be configured to show. A
            // snapshot months old has no card config of its own to consult.
            density="detailed"
            exampleCount={3}
            keyTermCount={8}
          />
        </section>
      ))}
    </div>
  );
}
