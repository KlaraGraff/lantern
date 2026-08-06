/**
 * The level observation: the reader's declared CEFR level, held up against
 * what their own lookup record shows, once, at the bottom of the stats page.
 *
 * It is category B in `docs/impls/reading-driven-mastery-and-review.md` §6 —
 * strong evidence, reminder only, never an automatic change. Declared level
 * decides how deeply the AI explains things, which is something the reader
 * feels immediately, so it moves only when they press something.
 */

export type LevelObservationKind =
  /** The record cannot separate "knows these words" from "reads fast and does
   *  not stop". This is a conclusion, not a failure, and it is drawn at the
   *  same weight as the other two. */
  | "unclear"
  /** Looking up words the declared level says should not need looking up. */
  | "declaredHigh"
  /** Reading past words the declared level says should have stopped them. */
  | "declaredLow";

export interface LevelObservation {
  kind: LevelObservationKind;
  /** What the reader told us, e.g. `"B2"`. */
  declaredLevel: string;
  /** What the record points at. `null` when nothing is being suggested —
   *  always the case for `unclear`. */
  suggestedLevel: string | null;
  /** The frequency band the evidence sits in, and its rank window. */
  band: number | null;
  bandFrom: number | null;
  bandTo: number | null;
  /** `declaredLow`: words in that band read twice or more without a lookup. */
  passedWords: number | null;
  /**
   * How much was looked up, and how much of that landed in `band`.
   *
   * Set for `declaredHigh` and for `unclear` — the evidence for both. A count
   * and a share of the reader's own lookups, deliberately, rather than a rate
   * per chapter or per hour: a rate implies a normal value the reader is
   * being held to, and there is no such value here to publish. The only fair
   * denominator for "you look these up a lot" is everything else they looked
   * up.
   */
  totalLookups: number | null;
  concentratedLookups: number | null;
  /** Days of record the observation is drawn from. */
  windowDays: number;
}

/**
 * THE sentence. It appears under every variant, unconditionally, and it is the
 * whole reason this row is allowed to exist at all: the observation is only
 * ever a remark, and the reader's setting is only ever changed by the reader.
 *
 * Rendered outside the variant switch so no future branch can drop it, and
 * named here so a test can assert its presence in each variant's key list.
 */
export const LEVEL_OBSERVATION_RULE_KEY = "readingStats.levelObservation.rule";

/**
 * The fine print under each variant, in order. The mandatory sentence is
 * always first; the rest depend on whether there was anything to press.
 */
export function levelObservationRuleKeys(kind: LevelObservationKind): string[] {
  const keys = [LEVEL_OBSERVATION_RULE_KEY];
  if (kind !== "unclear") keys.push("readingStats.levelObservation.ruleChoice");
  keys.push("readingStats.levelObservation.ruleLocal");
  // Every variant can be stopped, so every variant says what stopping does.
  // `unclear` has no suggestion to keep or apply, so it gets the shorter
  // sentence — the one that only describes the button it actually has.
  keys.push(kind === "unclear"
    ? "readingStats.levelObservation.ruleSuppressionStop"
    : "readingStats.levelObservation.ruleSuppression");
  if (kind === "declaredHigh") keys.push("readingStats.levelObservation.ruleSettings");
  return keys;
}

/** The observation sentence itself, one key per variant. */
export function levelObservationBodyKey(kind: LevelObservationKind): string {
  return `readingStats.levelObservation.body.${kind}`;
}

/**
 * What changes if the reader presses the button — stated as consequence, never
 * as "your level is wrong". `null` when there is no button to press.
 */
export function levelObservationEffectKey(kind: LevelObservationKind): string | null {
  if (kind === "unclear") return "readingStats.levelObservation.effect.unclear";
  return `readingStats.levelObservation.effect.${kind}`;
}

/** Every key a variant can ask for, for the locale test to walk. */
export const LEVEL_OBSERVATION_KINDS: readonly LevelObservationKind[] = [
  "unclear",
  "declaredHigh",
  "declaredLow",
];

export function levelObservationKeys(kind: LevelObservationKind): string[] {
  const keys = [levelObservationBodyKey(kind), ...levelObservationRuleKeys(kind)];
  const effect = levelObservationEffectKey(kind);
  if (effect) keys.push(effect);
  return keys;
}
