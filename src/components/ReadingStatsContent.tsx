import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import ReadingStats from "../pages/ReadingStats";
import { createTauriReadingStatsAdapter } from "../pages/reading-stats/tauri-adapter";
import {
  levelObservationBodyKey,
  levelObservationEffectKey,
  levelObservationRuleKeys,
  type LevelObservation,
} from "../pages/reading-stats/level-observation";
import { markEmphasis } from "../i18n/emphasis";
import { openSettings } from "./settings-open";
import { compactTokens, needsUnit, tokenScaleFor } from "./settings/auto-analysis";

/**
 * The offer quotes what one run costs, in the unit the reader's language
 * counts in — and never in money. Same rule as the console: only the
 * provider can price a call correctly, so we state the measurement and stop
 * there. Shares the console's helpers so the two screens cannot round the
 * same number differently.
 */
function formatTokens(tokens: number, language: string, t: TFunction): string {
  const scale = tokenScaleFor(language);
  const amount = compactTokens(tokens, scale);
  const key = needsUnit(tokens, scale)
    ? `settings.autoAnalysis.tokens.${scale}`
    : "settings.autoAnalysis.tokens.plain";
  return t(key, { amount });
}

/**
 * Home's "stats" filter, wearing the same `<ReadingStats>` the standalone
 * route used to. This is the one row in the sidebar whose click used to be a
 * navigation instead of a same-page filter (`docs/impls/sidebar-ia-options-mockup.html`,
 * option C) — the route is gone, so this is the only place `<ReadingStats>`
 * still mounts. `flex-1 min-w-0` is what every other same-page content
 * component (`DictionaryContent`, `QaContent`, `AnnotationsContent`) puts
 * on its own root for the same reason: Home's shell is a row flexbox and this
 * pane has to claim the width the sidebar isn't using.
 */
export default function ReadingStatsContent({ onOpenReview }: { onOpenReview?: () => void } = {}) {
  const { t, i18n } = useTranslation();
  const adapter = useMemo(() => createTauriReadingStatsAdapter(i18n.language), [i18n.language]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [provider, setProvider] = useState({ name: "Lantern AI", model: "", billingNotice: t("readingStats.aiBillingDefault"), configured: false });

  useEffect(() => {
    let disposed = false;
    Promise.all([
      invoke<Record<string, string>>("get_all_settings"),
      invoke<{ label?: string; provider?: string; model?: string }>("ai_active_profile").catch(() => null),
      invoke<boolean>("ai_api_key_configured").catch(() => false),
    ]).then(([settings, profile, configured]) => {
      if (disposed) return;
      setAcknowledged(settings.reading_stats_ai_disclosure_acknowledged === "true");
      setProvider({
        name: profile?.label || profile?.provider || "Lantern AI",
        model: profile?.model || "",
        billingNotice: t("readingStats.aiBillingDefault"),
        configured: Boolean(configured),
      });
    }).catch(() => {});
    return () => { disposed = true; };
  }, [t]);

  const labels = useMemo(() => ({
    title: t("readingStats.title"), subtitleHistory: t("readingStats.subtitleHistory"), subtitleCalendar: t("readingStats.subtitleCalendar"), loading: t("readingStats.loading"), loadFailed: t("readingStats.loadFailed"), retry: t("common.retry"), allBooks: t("readingStats.allBooks"), last30Days: t("readingStats.last30Days"), thisYear: t("readingStats.thisYear"), allTime: t("readingStats.allTime"), historyView: t("readingStats.historyView"), calendarView: t("readingStats.calendarView"), focusedReading: t("readingStats.focusedReading"), booksRead: t("readingStats.booksRead"), booksCompleted: t("readingStats.booksCompleted"), validSessions: t("readingStats.validSessions"), historyHeading: t("readingStats.historyHeading"), historyDescription: t("readingStats.historyDescription"), calendarHeading: t("readingStats.calendarHeading"), calendarDescription: t("readingStats.calendarDescription"), noCalendarActivity: t("readingStats.noCalendarActivity"), noCalendarActivityDescription: t("readingStats.noCalendarActivityDescription"), emptyTitle: t("readingStats.emptyTitle"), emptyDescription: t("readingStats.emptyDescription"), emptyRule: t("readingStats.emptyRule"), privacyButton: t("readingStats.privacyButton"), privacyTitle: t("readingStats.privacyTitle"), privacyDescription: t("readingStats.privacyDescription"), privacyLocalFacts: t("readingStats.privacyLocalFacts"), privacyAiScope: t("readingStats.privacyAiScope"), privacyNoSocial: t("readingStats.privacyNoSocial"), privacySessionRule: t("readingStats.privacySessionRule"), close: t("common.close"), aiBadge: t("readingStats.aiBadge"), aiReviewHeading: t("readingStats.aiReviewHeading"), aiReviewDescription: t("readingStats.aiReviewDescription"), aiGenerate: t("readingStats.aiGenerate"), aiRefresh: t("readingStats.aiRefresh"), aiGenerating: t("readingStats.aiGenerating"), aiGeneratedBy: t("readingStats.aiGeneratedBy"), aiDisclosureTitle: t("readingStats.aiDisclosureTitle"), aiDisclosureDescription: t("readingStats.aiDisclosureDescription"), aiDisclosureProvider: t("readingStats.aiDisclosureProvider"), aiDisclosureData: t("readingStats.aiDisclosureData"), aiDisclosureDataValue: t("readingStats.aiDisclosureDataValue"), aiDisclosureExcludes: t("readingStats.aiDisclosureExcludes"), aiDisclosureExcludesValue: t("readingStats.aiDisclosureExcludesValue"), aiDisclosureBilling: t("readingStats.aiDisclosureBilling"), aiDisclosureConfirm: t("readingStats.aiDisclosureConfirm"), aiNotConfigured: t("readingStats.aiNotConfigured"), aiQuotaExceeded: t("readingStats.aiQuotaExceeded"), aiOffline: t("readingStats.aiOffline"), aiFailed: t("readingStats.aiFailed"), aiCachedNotice: t("readingStats.aiCachedNotice"), aiPendingTitle: t("readingStats.aiPendingTitle"), autoOfferTitle: (manualRuns: number) => t("readingStats.autoOfferTitle", { times: manualRuns }), autoOfferBody: t("readingStats.autoOfferBody"), autoOfferBodyWithCost: (tokens: number) => t("readingStats.autoOfferBodyWithCost", { tokens: formatTokens(tokens, i18n.language, t) }), autoOfferAccept: t("readingStats.autoOfferAccept"), autoOfferDecline: t("readingStats.autoOfferDecline"), progressLabel: t("readingStats.progressLabel"), sessionCountLabel: (count: number) => t("readingStats.sessionCount", { count }), formatDuration: (seconds: number) => t("readingStats.duration", { count: Math.round(seconds / 60) }), formatDate: (date: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(`${date}T12:00:00`)), formatTime: (timestamp: number) => new Intl.DateTimeFormat(i18n.language, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp * 1000)), formatReviewUpdatedAt: (timestamp: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(timestamp * 1000)),
    levelHeading: t("readingStats.levelObservation.heading"),
    levelDescription: t("readingStats.levelObservation.description"),
    levelDeclared: (level: string) => t("readingStats.levelObservation.declared", { level }),
    levelBasis: (days: number) => t("readingStats.levelObservation.basis", { days }),
    // The emphasized run is a number inside a sentence, and where it lands
    // differs per language — hence a marker in the string rather than three
    // keys the translator cannot reorder. See `i18n/emphasis.ts`.
    levelBody: (observation: LevelObservation) => t(levelObservationBodyKey(observation.kind), {
      band: observation.band ?? 0,
      from: observation.bandFrom ?? 0,
      to: observation.bandTo ?? 0,
      level: observation.declaredLevel,
      suggested: observation.suggestedLevel ?? "",
      total: observation.totalLookups ?? 0,
      // The emphasis goes on the concentrated count, not the total: the total
      // is only there to be the denominator the reader can see.
      concentrated: markEmphasis(observation.concentratedLookups ?? 0),
      passed: markEmphasis(observation.passedWords ?? 0),
    }),
    // Only when lookups were actually screened out: the note explains why
    // the totals above are smaller than the record the reader can count.
    levelTopicalNote: (observation: LevelObservation) => {
      const topical = observation.topicalLookups ?? 0;
      return topical > 0
        ? t("readingStats.levelObservation.topicalNote", { topical })
        : null;
    },
    levelEffect: (observation: LevelObservation) => {
      const key = levelObservationEffectKey(observation.kind);
      return key ? t(key, {
        level: observation.suggestedLevel ?? observation.declaredLevel,
        days: observation.windowDays,
        total: observation.totalLookups ?? 0,
        concentrated: observation.concentratedLookups ?? 0,
        band: observation.band ?? 0,
      }) : null;
    },
    levelApply: (level: string) => t("readingStats.levelObservation.apply", { level }),
    levelKeep: (level: string) => t("readingStats.levelObservation.keep", { level }),
    levelStop: t("readingStats.levelObservation.stop"),
    levelOpenSettings: t("readingStats.levelObservation.openSettings"),
    levelRules: (observation: LevelObservation) =>
      levelObservationRuleKeys(observation.kind, observation.wordClassSource).map((key) => t(key)),
    subtitleLearning: t("readingStats.subtitleLearning"),
    learningView: t("readingStats.learningView"),
    learningHeading: (scoped: boolean) => (scoped ? t("readingStats.learningHeadingScoped") : t("readingStats.learningHeading")),
    learningDescription: (scoped: boolean) => (scoped ? t("readingStats.learningDescriptionScoped") : t("readingStats.learningDescription")),
    learningLookupCount: t("readingStats.learningLookupCount"),
    learningNewWords: t("readingStats.learningNewWords"),
    learningMastered: t("readingStats.learningMastered"),
    learningDueForReview: t("readingStats.learningDueForReview"),
    learningGoToReview: t("readingStats.learningGoToReview"),
    learningTrendTitle: t("readingStats.learningTrendTitle"),
    learningTrendDescription: (granularity: "day" | "week" | "month") =>
      granularity === "day"
        ? t("readingStats.learningTrendDescriptionDay")
        : granularity === "week"
        ? t("readingStats.learningTrendDescriptionWeek")
        : t("readingStats.learningTrendDescriptionMonth"),
    learningTrendTooltip: (dateLabel: string, count: number) => t("readingStats.learningTrendTooltip", { date: dateLabel, count }),
    learningDistributionTitle: (count: number, scoped: boolean) =>
      scoped
        ? t("readingStats.learningDistributionTitleScoped", { count })
        : t("readingStats.learningDistributionTitleAll", { count }),
    learningDistributionDescription: t("readingStats.learningDistributionDescription"),
    masteryTierNew: t("vocab.mastery.new"),
    masteryTierLearning: t("vocab.mastery.learning"),
    masteryTierFamiliar: t("vocab.mastery.familiar"),
    masteryTierMastered: t("vocab.mastery.mastered"),
    learningEmptyTitle: t("readingStats.learningEmptyTitle"),
    learningEmptyDescription: t("readingStats.learningEmptyDescription"),
    learningFootnote: t("readingStats.learningFootnote"),
  }), [i18n.language, t]);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <ReadingStats
        adapter={adapter}
        labels={labels}
        provider={provider}
        aiReviewDisclosureAcknowledged={acknowledged}
        onAcknowledgeAiReviewDisclosure={() => invoke("set_setting", { key: "reading_stats_ai_disclosure_acknowledged", value: "true" }).then(() => setAcknowledged(true))}
        onOpenLevelSettings={() => openSettings("general")}
        onOpenReview={onOpenReview}
      />
    </div>
  );
}
