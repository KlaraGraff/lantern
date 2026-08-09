import type { CefrLevel } from "../settings/cefr";

export type ExplanationMode = "chinese" | "adaptive_bilingual" | "english_by_level";

/**
 * Which i18n key holds the onboarding sample copy for a given explanation
 * mode. The English-only mode additionally bands by the CEFR level currently
 * selected in the grid above — A1/A2 read a plainer sample than C1/C2, same
 * as the real explanations would. The other two modes have one fixed sample.
 */
export function explanationSampleKey(mode: ExplanationMode, level: CefrLevel): string {
  if (mode === "chinese") return "onboarding.step1.sampleChinese";
  if (mode === "adaptive_bilingual") return "onboarding.step1.sampleBilingual";
  if (level === "A1" || level === "A2") return "onboarding.step1.sampleEnglishBeginner";
  if (level === "B1" || level === "B2") return "onboarding.step1.sampleEnglishMid";
  return "onboarding.step1.sampleEnglishAdvanced";
}
