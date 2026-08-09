/**
 * Pure helpers for the auto-analysis console. Framework-free so the number
 * rules — the part the reader will actually squint at — can be tested
 * without a DOM.
 *
 * See docs/impls/auto-analysis-console-mockup.html. The rule the whole file
 * exists to keep: **never turn tokens into money.** Cache hits, off-peak
 * discounts and tiered first-input pricing are things only the provider can
 * compute, billing rules change under us, and a figure about someone's bill
 * that is quietly wrong is worse than no figure. What is shown instead is
 * the provider's own token count and a ratio against the reader's own
 * manual spend — internal data compared to internal data is always exact,
 * and it answers what they were really asking.
 */

/** One row of the console, as `commands::auto_analysis` serialises it. */
export interface AutoAnalysisJobView {
  id: string;
  trigger: string;
  enabled: boolean;
  autoCalls: number;
  autoTokens: number;
  manualRuns: number;
  recommendAuto: boolean;
}

export interface AutoAnalysisConsoleData {
  jobs: AutoAnalysisJobView[];
  autoTokens: number;
  userTokens: number;
  ratioPercent: number | null;
  /**
   * Providers that actually billed something in the window, from the usage
   * records rather than from configuration — failover means the provider
   * that ran is not always the one that is selected, and the billing link
   * has to point at the bill that exists.
   */
  providers: string[];
}

/** The window the console reports on. */
export const CONSOLE_WINDOW_DAYS = 30;

export function consoleWindowStart(now: number): number {
  return now - CONSOLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Which unit a language counts large numbers in. Chinese groups by 万
 * (10,000), English by thousands; a language that wants a third answer adds
 * itself here rather than at every call site.
 */
export type TokenScale = "wan" | "k";

export function tokenScaleFor(language: string | undefined): TokenScale {
  return language?.startsWith("zh") ? "wan" : "k";
}

/**
 * The number in front of the unit word, which the i18n string supplies.
 *
 * One decimal below ten and none above it: "1.5 万" carries information,
 * "48.3 万" is false precision about a total nobody can act on to that
 * resolution. Anything smaller than one whole unit prints as itself rather
 * than "0.0" — an early reader whose only automatic call cost 900 tokens
 * should see 900, not a rounding artefact.
 */
export function compactTokens(tokens: number, scale: TokenScale): string {
  const step = scale === "wan" ? 10_000 : 1_000;
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  if (safe < step) return String(Math.round(safe));
  const scaled = safe / step;
  return scaled < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
}

/** Whether a token figure needs its unit word at all. */
export function needsUnit(tokens: number, scale: TokenScale): boolean {
  const step = scale === "wan" ? 10_000 : 1_000;
  return Number.isFinite(tokens) && tokens >= step;
}

/**
 * Within a family, the order jobs are worth reading in — earliest moment in
 * a book's life first. Also the tie-break the console sorts rows by, and the
 * i18n key for the "when does this run" label each row carries.
 */
export const TRIGGER_ORDER = ["book_imported", "book_finished", "daily", "batch"] as const;

/**
 * Console groups: by *what a job is for*, not by when it runs.
 *
 * The question this screen answers is "is this one worth my quota", and the
 * answer turns on what the reader gets back — better search, a review to
 * come back to, explanations that fit them. When it runs is a smaller fact,
 * so it stays on the row (next to that row's call count) instead of
 * organising the page.
 *
 * A job id this build does not know about falls into `other` rather than
 * vanishing: a switch the reader cannot see is a switch they cannot turn off.
 */
export const FAMILY_ORDER = ["retrieval", "review", "personalization", "other"] as const;

const JOB_FAMILY: Record<string, string> = {
  grounding_context: "retrieval",
  person_aliases: "retrieval",
  reading_review: "review",
  review_pile_curation: "review",
  followup_difficulty: "personalization",
  user_profile: "personalization",
};

export function familyOf(jobId: string): string {
  return JOB_FAMILY[jobId] ?? "other";
}

export function groupJobsByFamily(jobs: AutoAnalysisJobView[]): [string, AutoAnalysisJobView[]][] {
  const triggerRank = (trigger: string) => {
    const index = (TRIGGER_ORDER as readonly string[]).indexOf(trigger);
    return index === -1 ? TRIGGER_ORDER.length : index;
  };
  const groups = new Map<string, AutoAnalysisJobView[]>();
  for (const job of jobs) {
    const family = familyOf(job.id);
    const bucket = groups.get(family);
    if (bucket) bucket.push(job);
    else groups.set(family, [job]);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => triggerRank(a.trigger) - triggerRank(b.trigger));
  }
  const rank = (family: string) => {
    const index = (FAMILY_ORDER as readonly string[]).indexOf(family);
    return index === -1 ? FAMILY_ORDER.length : index;
  };
  return [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
}
