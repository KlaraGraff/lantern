import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, Sparkles } from "lucide-react";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { timeAgo } from "../../utils/timeAgo";
import {
  masteryBecauseExplanation,
  masteryTransitionDirection,
  timelineEventExplanation,
} from "./mastery-explanation";

const MASTERY_LEVELS = ["new", "learning", "familiar", "mastered"] as const;
export type MasteryLevel = (typeof MASTERY_LEVELS)[number];

/** One row of the local mastery-tier timeline. See src-tauri/src/commands/mastery_events.rs. */
interface MasteryEvent {
  id: string;
  vocab_word_id: string;
  from_mastery: string;
  to_mastery: string;
  source: "auto" | "manual" | "review";
  reason: string;
  detail: string;
  created_at: number;
}

const TIMELINE_DOT_COLOR: Record<"up" | "down" | "flat", string> = {
  up: "border-success",
  down: "border-danger",
  flat: "border-border",
};

/** One entry in "how it got here" — a plain-language read of one mastery_events row. */
function TimelineEvent({ event }: { event: MasteryEvent }) {
  const { t } = useTranslation();
  const direction = masteryTransitionDirection(event.from_mastery, event.to_mastery);
  const explanation = timelineEventExplanation(
    event.reason,
    event.detail,
    t(`vocab.mastery.${event.from_mastery}`),
    t(`vocab.mastery.${event.to_mastery}`),
  );
  // `rating` arrives as the stored code ("good"), which would drop an English
  // word into the middle of a Chinese sentence. The pure module has no `t`, so
  // the label swap happens here.
  const params = explanation.params.rating === undefined
    ? explanation.params
    : { ...explanation.params, rating: t(`vocab.rating.${explanation.params.rating}`) };
  return (
    <div className="relative pl-3.5">
      <span
        aria-hidden="true"
        className={`absolute left-0 top-[3px] size-2 rounded-full border-2 bg-bg-surface ${TIMELINE_DOT_COLOR[direction]}`}
      />
      <p className="text-[12.5px] leading-[1.6] text-text-primary">{t(explanation.key, params)}</p>
      <p className="mt-0.5 text-[11px] text-text-muted">{timeAgo(event.created_at)}</p>
    </div>
  );
}

export interface MasteryPanelProps {
  word: DictionaryWord;
  onSetMastery: (mastery: MasteryLevel) => void;
  /**
   * How many books this word was saved from. Above one, the panel says so —
   * one schedule moves every copy, and changing a tier from a page that only
   * names one book should not look like it only touched that book.
   */
  sharedBookCount?: number;
}

/**
 * Tier, whether the app decided it, the one sentence saying why, a way to
 * overrule it, and the timeline behind it. See docs/impls/review-entry-mockup.html §5.
 *
 * The sentence is the point of this panel, not the timeline: it turns "decided
 * automatically" from a black box into a claim the reader can argue with. So
 * it renders for every saved word, whether that word was saved from one book
 * or five — an automatic judgement nobody can find is not overrulable.
 */
export default function MasteryPanel({ word, onSetMastery, sharedBookCount }: MasteryPanelProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<MasteryEvent[]>([]);
  const because = masteryBecauseExplanation(word.mastery_reason);

  // mastery_events is device-local (migration 038) — a miss here is a normal
  // "nothing happened on this device yet", not an error, so it fails silent.
  useEffect(() => {
    let cancelled = false;
    invoke<MasteryEvent[]>("list_mastery_events", { vocabWordId: word.id })
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [word.id]);

  return (
    <div className="flex flex-col gap-3 border-t border-border-light px-3 pb-3 pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-accent-bg px-2.5 py-1 text-[12px] font-medium text-accent-text">
          {t(`vocab.mastery.${word.mastery}`)}
        </span>
        {word.mastery_source === "auto" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-bg-input px-2 py-0.5 text-[11px] text-text-muted">
            <Sparkles size={11} className="shrink-0" />
            {t("vocab.mastery.autoBadge")}
          </span>
        )}
      </div>

      {because && (
        <p className="rounded-lg bg-accent-bg px-3.5 py-3 text-[13.5px] leading-[1.65] text-accent-text">
          {t(because.key, because.params)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-input p-0.5">
          {MASTERY_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={word.mastery === level}
              onClick={() => onSetMastery(level)}
              className={`h-6 rounded px-2 text-[11px] cursor-pointer ${
                word.mastery === level
                  ? "bg-bg-surface font-semibold text-accent-text"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {t(`vocab.mastery.${level}`)}
            </button>
          ))}
        </div>
        {sharedBookCount !== undefined && sharedBookCount > 1 && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-text-muted">
            <RotateCcw size={10} className="shrink-0" />
            {t("vocab.merged.masterySharedHint", { count: sharedBookCount })}
          </span>
        )}
      </div>

      {events.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
            {t("vocab.mastery.timelineHeading")}
          </h3>
          <div className="flex flex-col gap-2.5">
            {events.map((event) => (
              <TimelineEvent key={event.id} event={event} />
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-light pt-2.5">
        <p className="max-w-[420px] text-[11.5px] leading-[1.5] text-text-muted">
          {t("vocab.mastery.tierEffectNote")}
        </p>
        {word.mastery !== "new" && (
          <button
            type="button"
            onClick={() => onSetMastery("learning")}
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-danger-border bg-danger-bg px-3 text-[12.5px] font-medium text-danger-text cursor-pointer"
          >
            <RotateCcw size={13} className="shrink-0" />
            {t("vocab.mastery.iDontKnowThis")}
          </button>
        )}
      </div>
    </div>
  );
}
