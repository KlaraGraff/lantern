/**
 * CEFR levels and exam-score conversion, shared between the General settings
 * tab and the first-launch onboarding card. Both need the same six levels,
 * the same exam catalog, and the same score validation — this is the one
 * place that owns them so neither can drift from the other.
 */

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** The safest default: wrong-but-too-easy costs a little wordiness, wrong-but-too-hard
 * costs comprehension. B1 is the level least likely to make explanations useless. */
export const DEFAULT_CEFR_LEVEL: CefrLevel = "B1";

export const EXAM_OPTIONS = [
  { value: "ielts", label: "IELTS" },
  { value: "toefl_ibt", label: "TOEFL iBT" },
  { value: "toeic_lr", label: "TOEIC Listening & Reading" },
  { value: "cambridge", label: "Cambridge English Scale" },
  { value: "det", label: "Duolingo English Test" },
  { value: "cet4", label: "CET-4" },
  { value: "cet6", label: "CET-6" },
];

export interface ScoreRule {
  min: number;
  max: number;
  step: number;
}

export interface ExamScoreRules {
  overall: ScoreRule;
  reading: ScoreRule;
}

export const EXAM_SCORE_RULES: Record<string, ExamScoreRules> = {
  ielts: {
    overall: { min: 0, max: 9, step: 0.5 },
    reading: { min: 0, max: 9, step: 0.5 },
  },
  toefl_ibt: {
    overall: { min: 0, max: 120, step: 1 },
    reading: { min: 0, max: 30, step: 1 },
  },
  toeic_lr: {
    overall: { min: 10, max: 990, step: 1 },
    reading: { min: 5, max: 495, step: 1 },
  },
  cambridge: {
    overall: { min: 80, max: 230, step: 1 },
    reading: { min: 80, max: 230, step: 1 },
  },
  det: {
    overall: { min: 10, max: 160, step: 1 },
    reading: { min: 10, max: 160, step: 1 },
  },
  cet4: {
    overall: { min: 0, max: 710, step: 1 },
    reading: { min: 0, max: 249, step: 1 },
  },
  cet6: {
    overall: { min: 0, max: 710, step: 1 },
    reading: { min: 0, max: 249, step: 1 },
  },
};

export function scoreWithinRule(value: number, rule: ScoreRule): boolean {
  if (!Number.isFinite(value) || value < rule.min || value > rule.max) return false;
  const steps = (value - rule.min) / rule.step;
  return Math.abs(steps - Math.round(steps)) < 1e-8;
}

/** The inclusive CEFR band between two levels, in ascending order. Used when
 * an exam estimate "needs confirmation" — two conflicting scores narrow the
 * guess to a range instead of a single level, and the person picks within it. */
export function levelsInRange(lower: string, upper: string): CefrLevel[] {
  const lowerIndex = CEFR_LEVELS.indexOf(lower as CefrLevel);
  const upperIndex = CEFR_LEVELS.indexOf(upper as CefrLevel);
  if (lowerIndex === -1 || upperIndex === -1) return [];
  return CEFR_LEVELS.filter((_level, index) => index >= lowerIndex && index <= upperIndex);
}

/** `cefr_level` is never seeded — its absence means "never explicitly set,"
 * distinct from having been set and then reverted to the default. */
export function resolveInitialCefrLevel(settings: Record<string, string>): CefrLevel {
  const value = settings.cefr_level;
  return (CEFR_LEVELS as readonly string[]).includes(value) ? (value as CefrLevel) : DEFAULT_CEFR_LEVEL;
}
