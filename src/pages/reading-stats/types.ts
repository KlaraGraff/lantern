import type { LevelObservation } from "./level-observation";

export type ReadingStatsView = "history" | "calendar" | "learning";
export type ReadingStatsRange = "last30Days" | "year" | "all";

export interface ReadingStatsQuery {
  range: ReadingStatsRange;
  bookId: string | null;
}

export interface ReadingStatsOverview {
  totalActiveSeconds: number;
  booksTouched: number;
  completedBooks: number;
  sessionCount: number;
  readingDays: number;
}

export interface ReadingStatsBook {
  bookId: string;
  title: string;
  author: string | null;
  coverData: string | null;
  progress: number;
  completed: boolean;
  activeSeconds: number;
  sessionCount: number;
}

export interface ReadingStatsCalendarDay {
  date: string;
  activeSeconds: number;
  sessions: Array<{
    bookId: string;
    title: string;
    startedAt: number;
    endedAt: number;
    activeSeconds: number;
  }>;
}

export interface ReadingReviewFacts {
  periodStart: number;
  periodEnd: number;
  totalActiveSeconds: number;
  sessionCount: number;
  booksTouched: number;
  completedBooks: number;
  mostReadBookTitle: string | null;
  mostReadBookSeconds: number;
  readingDays: number;
  mostCommonHour: number | null;
}

export interface CachedReadingReview {
  narrative: string;
  providerName: string;
  model: string;
  updatedAt: number;
  facts: ReadingReviewFacts;
}

/** How the lookup trend below is bucketed — chosen server-side from the span
 * of the reader's actual activity, not the nominal query range, so a chart
 * over "all time" doesn't walk decades of empty history. */
export type VocabTrendGranularity = "day" | "week" | "month";

export interface VocabTrendBucket {
  /** Local date the bucket starts on (`YYYY-MM-DD`) — the day itself for
   * `"day"` granularity, that ISO week's Monday for `"week"`, or the 1st of
   * the month for `"month"`. */
  date: string;
  count: number;
}

export interface VocabMasteryDistribution {
  total: number;
  newCount: number;
  learningCount: number;
  familiarCount: number;
  masteredCount: number;
}

/** The reading-stats page's "learning" view (`docs/impls/reading-stats-learning-mockup.html`):
 * how much dictionary-lookup and vocabulary-mastery activity happened in the
 * selected period, computed entirely on-device. */
export interface VocabLearningStats {
  lookupCount: number;
  newWordsCount: number;
  masteredCount: number;
  /** Not scoped to the period — "today" means today regardless of the range
   * tab, same as the sidebar's own review entry point. Still respects the
   * book filter. */
  dueForReviewCount: number;
  trendGranularity: VocabTrendGranularity;
  /** Oldest first, one entry per bucket across the whole period including
   * zero-count buckets. */
  trend: VocabTrendBucket[];
  /** Current mastery-tier snapshot (not period-scoped), narrowed to the book
   * filter only. */
  masteryDistribution: VocabMasteryDistribution;
}

export interface ReadingStatsDashboard {
  overview: ReadingStatsOverview;
  books: ReadingStatsBook[];
  calendar: ReadingStatsCalendarDay[];
  facts: ReadingReviewFacts;
  cachedReview: CachedReadingReview | null;
  learning: VocabLearningStats;
  /**
   * Set only when the dashboard is scoped to one book and that book's most
   * recent *automatic* review attempt failed — not configured, out of
   * quota, offline, or the model itself. `null` once a review exists for
   * that book, whether it arrived automatically or by hand. The reading
   * page uses this to show a placeholder in that book's spot instead of
   * nothing, without the reader having needed to press anything first.
   */
  reviewPendingReason: ReadingReviewErrorCode | null;
}

export interface ReadingReviewProvider {
  name: string;
  model: string;
  billingNotice: string;
  configured: boolean;
}

export type ReadingReviewErrorCode = "notConfigured" | "quotaExceeded" | "offline" | "failed";

export class ReadingReviewError extends Error {
  readonly code: ReadingReviewErrorCode;

  constructor(code: ReadingReviewErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ReadingReviewError";
    this.code = code;
  }
}

/**
 * The shared integration pass supplies the command implementation. Keeping
 * this boundary explicit lets the page be tested without a live Tauri shell.
 */
/**
 * What the page needs to know about making this review automatic.
 *
 * `recommend` is the backend's whole decision — the page never re-derives
 * it. `typicalTokens` is what one run has actually cost, or null when
 * nothing has run yet; the offer states the price or says nothing, it never
 * estimates.
 */
export interface AutoReviewOffer {
  recommend: boolean;
  typicalTokens: number | null;
  /**
   * How many times the reader has done this by hand. The offer quotes the
   * real count rather than the threshold that unlocked it — by the time
   * someone is on their sixth run, telling them "you've done this 4 times"
   * is a script, not an observation.
   */
  manualRuns: number;
}

export interface ReadingStatsAdapter {
  loadDashboard(query: ReadingStatsQuery): Promise<ReadingStatsDashboard>;
  generateReview(query: ReadingStatsQuery): Promise<CachedReadingReview>;
  /**
   * The level observation as it stands, or `null` when there is nothing to
   * say — no declared level, too little record, or the reader has turned the
   * comparison off. Optional, and null-on-failure: this row is not something
   * anyone asked for, so it says nothing rather than reporting an error.
   */
  loadLevelObservation?(): Promise<LevelObservation | null>;
  /** Apply the suggested level. Only ever called from the reader's press. */
  applyLevelSuggestion?(level: string): Promise<void>;
  /** Keep the declared level. Settles this observation for a while. */
  keepDeclaredLevel?(): Promise<void>;
  /** Stop drawing the comparison at all. */
  stopLevelObservation?(): Promise<void>;
  /** The offer as it stands, without changing anything. */
  autoReviewOffer?(): Promise<AutoReviewOffer>;
  /** Records one run by hand and returns the offer that results from it. */
  noteManualReview?(): Promise<AutoReviewOffer>;
  /** The reader said yes: the job runs on its own from now on. */
  acceptAutoReview?(): Promise<AutoReviewOffer>;
  /** The reader said no. One refusal settles it — this is never asked again. */
  declineAutoReview?(): Promise<AutoReviewOffer>;
}

export interface ReadingStatsLabels {
  title: string;
  subtitleHistory: string;
  subtitleCalendar: string;
  subtitleLearning: string;
  loading: string;
  loadFailed: string;
  retry: string;
  allBooks: string;
  last30Days: string;
  thisYear: string;
  allTime: string;
  historyView: string;
  calendarView: string;
  learningView: string;
  focusedReading: string;
  booksRead: string;
  booksCompleted: string;
  validSessions: string;
  historyHeading: string;
  historyDescription: string;
  calendarHeading: string;
  calendarDescription: string;
  noCalendarActivity: string;
  noCalendarActivityDescription: string;
  /** `scoped` is true once the book filter narrows to one title — the
   * mockup's "学习 · 这本书" variant. */
  learningHeading(scoped: boolean): string;
  learningDescription(scoped: boolean): string;
  learningLookupCount: string;
  learningNewWords: string;
  learningMastered: string;
  learningDueForReview: string;
  learningGoToReview: string;
  learningTrendTitle: string;
  learningTrendDescription(granularity: VocabTrendGranularity): string;
  learningTrendTooltip(dateLabel: string, count: number): string;
  learningDistributionTitle(count: number, scoped: boolean): string;
  learningDistributionDescription: string;
  /** Reuses the app's one canonical name per mastery tier — same strings the
   * vocabulary page's own tier badges use. */
  masteryTierNew: string;
  masteryTierLearning: string;
  masteryTierFamiliar: string;
  masteryTierMastered: string;
  learningEmptyTitle: string;
  learningEmptyDescription: string;
  learningFootnote: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyRule: string;
  privacyButton: string;
  privacyTitle: string;
  privacyDescription: string;
  privacyLocalFacts: string;
  privacyAiScope: string;
  privacyNoSocial: string;
  privacySessionRule: string;
  close: string;
  aiBadge: string;
  aiReviewHeading: string;
  aiReviewDescription: string;
  aiGenerate: string;
  aiRefresh: string;
  aiGenerating: string;
  aiGeneratedBy: string;
  aiDisclosureTitle: string;
  aiDisclosureDescription: string;
  aiDisclosureProvider: string;
  aiDisclosureData: string;
  aiDisclosureDataValue: string;
  aiDisclosureExcludes: string;
  aiDisclosureExcludesValue: string;
  aiDisclosureBilling: string;
  aiDisclosureConfirm: string;
  aiNotConfigured: string;
  aiQuotaExceeded: string;
  aiOffline: string;
  aiFailed: string;
  aiCachedNotice: string;
  /** Heading on the placeholder card shown at a finished book's own summary
   * spot when its automatic attempt didn't produce a review yet. */
  aiPendingTitle: string;
  autoOfferTitle(manualRuns: number): string;
  autoOfferBody: string;
  autoOfferBodyWithCost(tokens: number): string;
  autoOfferAccept: string;
  autoOfferDecline: string;
  levelHeading: string;
  levelDescription: string;
  levelDeclared(level: string): string;
  levelBasis(days: number): string;
  /** The observation sentence, with its emphasized run already marked. */
  levelBody(observation: LevelObservation): string;
  /** What pressing the button would change. `null` when there is no button. */
  levelEffect(observation: LevelObservation): string | null;
  levelApply(level: string): string;
  levelKeep(level: string): string;
  levelStop: string;
  levelOpenSettings: string;
  /** The fine print, mandatory sentence first. Never empty. */
  levelRules(observation: LevelObservation): string[];
  progressLabel: string;
  sessionCountLabel: (count: number) => string;
  formatDuration: (seconds: number) => string;
  formatDate: (isoDate: string) => string;
  formatTime: (timestampSeconds: number) => string;
  formatReviewUpdatedAt: (timestampSeconds: number) => string;
}
