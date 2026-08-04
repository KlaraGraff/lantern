import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { ArrowLeft } from "lucide-react";
import ReadingStats from "./ReadingStats";
import { createTauriReadingStatsAdapter } from "./reading-stats/tauri-adapter";

export default function ReadingStatsRoute() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
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
    title: t("readingStats.title"), subtitleHistory: t("readingStats.subtitleHistory"), subtitleCalendar: t("readingStats.subtitleCalendar"), loading: t("readingStats.loading"), loadFailed: t("readingStats.loadFailed"), retry: t("common.retry"), allBooks: t("readingStats.allBooks"), last30Days: t("readingStats.last30Days"), thisYear: t("readingStats.thisYear"), allTime: t("readingStats.allTime"), historyView: t("readingStats.historyView"), calendarView: t("readingStats.calendarView"), focusedReading: t("readingStats.focusedReading"), booksRead: t("readingStats.booksRead"), booksCompleted: t("readingStats.booksCompleted"), validSessions: t("readingStats.validSessions"), historyHeading: t("readingStats.historyHeading"), historyDescription: t("readingStats.historyDescription"), calendarHeading: t("readingStats.calendarHeading"), calendarDescription: t("readingStats.calendarDescription"), noCalendarActivity: t("readingStats.noCalendarActivity"), noCalendarActivityDescription: t("readingStats.noCalendarActivityDescription"), emptyTitle: t("readingStats.emptyTitle"), emptyDescription: t("readingStats.emptyDescription"), emptyRule: t("readingStats.emptyRule"), privacyButton: t("readingStats.privacyButton"), privacyTitle: t("readingStats.privacyTitle"), privacyDescription: t("readingStats.privacyDescription"), privacyLocalFacts: t("readingStats.privacyLocalFacts"), privacyAiScope: t("readingStats.privacyAiScope"), privacyNoSocial: t("readingStats.privacyNoSocial"), privacySessionRule: t("readingStats.privacySessionRule"), close: t("common.close"), aiBadge: t("readingStats.aiBadge"), aiReviewHeading: t("readingStats.aiReviewHeading"), aiReviewDescription: t("readingStats.aiReviewDescription"), aiGenerate: t("readingStats.aiGenerate"), aiRefresh: t("readingStats.aiRefresh"), aiGenerating: t("readingStats.aiGenerating"), aiGeneratedBy: t("readingStats.aiGeneratedBy"), aiDisclosureTitle: t("readingStats.aiDisclosureTitle"), aiDisclosureDescription: t("readingStats.aiDisclosureDescription"), aiDisclosureProvider: t("readingStats.aiDisclosureProvider"), aiDisclosureData: t("readingStats.aiDisclosureData"), aiDisclosureDataValue: t("readingStats.aiDisclosureDataValue"), aiDisclosureExcludes: t("readingStats.aiDisclosureExcludes"), aiDisclosureExcludesValue: t("readingStats.aiDisclosureExcludesValue"), aiDisclosureBilling: t("readingStats.aiDisclosureBilling"), aiDisclosureConfirm: t("readingStats.aiDisclosureConfirm"), aiNotConfigured: t("readingStats.aiNotConfigured"), aiQuotaExceeded: t("readingStats.aiQuotaExceeded"), aiOffline: t("readingStats.aiOffline"), aiFailed: t("readingStats.aiFailed"), aiCachedNotice: t("readingStats.aiCachedNotice"), progressLabel: t("readingStats.progressLabel"), sessionCountLabel: (count: number) => t("readingStats.sessionCount", { count }), formatDuration: (seconds: number) => t("readingStats.duration", { count: Math.round(seconds / 60) }), formatDate: (date: string) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(`${date}T12:00:00`)), formatTime: (timestamp: number) => new Intl.DateTimeFormat(i18n.language, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp * 1000)), formatReviewUpdatedAt: (timestamp: number) => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(timestamp * 1000)),
  }), [i18n.language, t]);

  return <div className="relative h-screen"><button type="button" aria-label={t("reader.returnToLibrary")} title={t("reader.returnToLibrary")} onClick={() => navigate("/")} className="fixed left-3 top-titlebar z-40 grid size-8 place-items-center rounded-lg border border-border bg-bg-surface text-text-muted shadow-sm hover:bg-bg-input"><ArrowLeft size={15} /></button><ReadingStats adapter={adapter} labels={labels} provider={provider} aiReviewDisclosureAcknowledged={acknowledged} onAcknowledgeAiReviewDisclosure={() => invoke("set_setting", { key: "reading_stats_ai_disclosure_acknowledged", value: "true" }).then(() => setAcknowledged(true))} /></div>;
}
