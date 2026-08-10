/**
 * Pure helpers for turning the mastery `detail` JSON into i18n keys and
 * interpolation params. Framework-free so it can be unit-tested without a DOM.
 *
 * Wire contract (see migration 038 and src-tauri/src/commands/mastery_events.rs):
 * `mastery_events.detail` and `vocab_words.mastery_reason` are both caller-
 * provided JSON text that Rust never parses or validates — `mastery_reason`
 * is a verbatim copy of the newest *auto*-sourced event's `detail`, which is
 * why it carries its own `reason` field (there is no sibling column to read
 * it from, unlike an event row).
 *
 * Detail JSON shape this module understands (every field but `reason`
 * optional; a producer omitting a field simply loses the fuller sentence,
 * never breaks the page):
 *   {
 *     "reason": "exposure_promotion",   // only meaningful on mastery_reason
 *     "book_title": "Pride and Prejudice",
 *     "chapter": "Chapter 14",          // unused today, reserved for lookup_demotion
 *     "distinct_days": 3,
 *     "exposures": 4,
 *     "lookups": 0,                     // unused today, reserved
 *     "lookup_count": 3,
 *     "card_count": 1,                  // AI learning cards opened, this window
 *     "glance_count": 2,                // dictionary definitions read
 *     "rating": "good"                  // one of vocab.rating.*
 *   }
 */

export interface MasteryDetail {
  reason?: string;
  book_title?: string;
  chapter?: string;
  distinct_days?: number;
  exposures?: number;
  lookups?: number;
  lookup_count?: number;
  /**
   * The two lookup kinds, counted separately (migration 069). A demotion can
   * be caused by AI cards, by free dictionary definitions, or by a mix, and
   * the sentence has to say which — calling a dictionary check "looking it up"
   * describes something the reader did not do.
   *
   * Absent on every row written before 069, which is exactly the cards-only
   * case, so their sentences are unchanged.
   */
  card_count?: number;
  glance_count?: number;
  rating?: "again" | "hard" | "good" | "easy";
}

/** Every reason code the backend can record — see migration 038's comment (c). */
export const MASTERY_REASON_CODES = [
  "exposure_promotion",
  "lookup_demotion",
  "repeat_lookup_demotion",
  "glance_entry",
  "user_override",
  "review_promotion",
  "review_demotion",
  "watchlist_promoted",
] as const;

export type MasteryReasonCode = (typeof MASTERY_REASON_CODES)[number];

export function isMasteryReasonCode(value: unknown): value is MasteryReasonCode {
  return typeof value === "string" && (MASTERY_REASON_CODES as readonly string[]).includes(value);
}

/**
 * Reason codes the *current-state* explanation ("because") is ever built
 * from. `mastery_source === "auto"` is only ever set by the reading-exposure
 * engine, so `user_override` (source "manual") and the two review reasons
 * (source "review") can never legitimately reach this sentence — treating
 * them the same as an unknown code (render nothing) is the correct decision,
 * not a shortcut.
 */
const BECAUSE_REASON_CODES: readonly MasteryReasonCode[] = [
  "exposure_promotion",
  "lookup_demotion",
  "repeat_lookup_demotion",
  "glance_entry",
];

/**
 * Which of a demotion's sentences is the true one. The two lookup reasons each
 * have three, because a demotion can be earned three ways and only one of them
 * is "you looked it up".
 *
 * `detail` — the cards-only sentence, and the one every pre-069 row gets: no
 * glance counted means the wording that shipped is still exactly right.
 */
type LookupVariant = "detail" | "glances" | "mixed";

function lookupVariant(detail: MasteryDetail | null): LookupVariant {
  const glances = detail?.glance_count ?? 0;
  if (glances <= 0) return "detail";
  return (detail?.card_count ?? 0) > 0 ? "mixed" : "glances";
}

// Fields a variant's fully-interpolated sentence needs, keyed
// `<reason>.<variant>`. Missing any of them falls back to a reason-only
// sentence instead of a string with a hole punched in the middle of it.
const REQUIRED_FIELDS: Record<string, (keyof MasteryDetail)[]> = {
  "exposure_promotion.detail": ["book_title", "distinct_days", "exposures"],
  "lookup_demotion.detail": ["book_title"],
  "lookup_demotion.glances": ["book_title", "glance_count"],
  "lookup_demotion.mixed": ["book_title", "card_count", "glance_count"],
  "repeat_lookup_demotion.detail": ["book_title", "lookup_count"],
  "repeat_lookup_demotion.glances": ["book_title", "glance_count"],
  "repeat_lookup_demotion.mixed": ["book_title", "card_count", "glance_count"],
  "glance_entry.detail": ["book_title", "glance_count"],
  "user_override.detail": [],
  "review_promotion.detail": ["rating"],
  "review_demotion.detail": ["rating"],
  "watchlist_promoted.detail": ["book_title", "lookup_count"],
};

/** Safe JSON.parse: malformed, empty, or non-object input degrades to null. */
export function parseMasteryDetail(json: string | null | undefined): MasteryDetail | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as MasteryDetail;
  } catch {
    return null;
  }
}

/**
 * The variant suffix to render, or `"plain"` when the facts the fuller
 * sentence needs are not all there.
 *
 * Which variant is *true* is decided by what the reader did, so the shape of
 * the detail picks it; whether it can be *rendered* is decided by the fields
 * present. A row claiming a mix but carrying only one of the two counts falls
 * back rather than rendering a hole.
 */
function variantFor(reason: MasteryReasonCode, detail: MasteryDetail | null): string {
  const variant =
    reason === "lookup_demotion" || reason === "repeat_lookup_demotion"
      ? lookupVariant(detail)
      : "detail";
  const required = REQUIRED_FIELDS[`${reason}.${variant}`] ?? [];
  return required.every((field) => detail?.[field] != null) ? variant : "plain";
}

function detailParams(detail: MasteryDetail | null): Record<string, string | number> {
  if (!detail) return {};
  const params: Record<string, string | number> = {};
  if (typeof detail.book_title === "string") params.bookTitle = detail.book_title;
  if (typeof detail.chapter === "string") params.chapter = detail.chapter;
  if (typeof detail.distinct_days === "number") params.days = detail.distinct_days;
  if (typeof detail.exposures === "number") params.exposures = detail.exposures;
  if (typeof detail.lookups === "number") params.lookups = detail.lookups;
  if (typeof detail.lookup_count === "number") params.lookupCount = detail.lookup_count;
  if (typeof detail.card_count === "number") params.cardCount = detail.card_count;
  if (typeof detail.glance_count === "number") params.glanceCount = detail.glance_count;
  if (typeof detail.rating === "string") params.rating = detail.rating;
  return params;
}

export interface MasteryExplanation {
  key: string;
  params: Record<string, string | number>;
}

/** Low to high — 'familiar' sits between 'learning' and 'mastered' (migration 038). */
const TIER_RANK: Record<string, number> = { new: 0, learning: 1, familiar: 2, mastered: 3 };

/**
 * Whether a timeline row reads as a promotion, a demotion, or neither — an
 * unrecognized tier name (never expected, but `from_mastery`/`to_mastery` are
 * plain TEXT columns with no CHECK constraint) ranks as flat rather than
 * throwing, so a bad row still renders instead of blanking the timeline.
 */
export function masteryTransitionDirection(fromMastery: string, toMastery: string): "up" | "down" | "flat" {
  const from = TIER_RANK[fromMastery];
  const to = TIER_RANK[toMastery];
  if (from == null || to == null || from === to) return "flat";
  return to > from ? "up" : "down";
}

/**
 * The purple "because" sentence, built from `vocab_words.mastery_reason`.
 * Null means render nothing at all: a missing reason, a malformed blob, and
 * a reason code that could never legitimately appear here are all the same
 * "nothing to show" case, not an error the UI apologizes for.
 */
export function masteryBecauseExplanation(reasonJson: string | null | undefined): MasteryExplanation | null {
  const detail = parseMasteryDetail(reasonJson);
  const reason = detail?.reason;
  if (!isMasteryReasonCode(reason) || !BECAUSE_REASON_CODES.includes(reason)) return null;
  const variant = variantFor(reason, detail);
  return { key: `vocab.mastery.because.${reason}.${variant}`, params: detailParams(detail) };
}

/**
 * One timeline row's i18n key + params. Keyed off the event's own `reason`
 * *column* (always present, authoritative) rather than anything inside
 * `detail` — unlike the "because" sentence, a timeline row cannot simply
 * disappear when its reason is unrecognized (it is a literal log, not a
 * curated summary), so an unfamiliar code still gets a generic transition
 * sentence built only from `from`/`to`, which every row always has.
 */
export function timelineEventExplanation(
  reason: string,
  detailJson: string | null | undefined,
  fromMastery: string,
  toMastery: string,
): MasteryExplanation {
  const detail = parseMasteryDetail(detailJson);
  const params = { ...detailParams(detail), from: fromMastery, to: toMastery };
  if (!isMasteryReasonCode(reason)) {
    return { key: "vocab.mastery.timeline.generic", params };
  }
  const variant = variantFor(reason, detail);
  return { key: `vocab.mastery.timeline.${reason}.${variant}`, params };
}
