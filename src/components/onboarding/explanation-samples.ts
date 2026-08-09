import type { CefrLevel } from "../settings/cefr";

export type ExplanationMode = "chinese" | "adaptive_bilingual" | "english_by_level";

/**
 * 引导第一步推荐哪一档讲解语言 —— 跟着等级走，不是一档到底。
 *
 * 讲解语言是把梯子，不是偏好开关：读不动的人需要整段中文托着，读得动的人再看
 * 中文反而是拖累（先读一遍英文、再读一遍中文，多出来的那遍没有产出）。所以
 * B1 及以下推荐中文讲解，B2 推荐中英对照 —— 中文兜底、补一句英文，正好是从
 * 「靠中文理解」过渡到「靠英文理解」的那一档 —— C1/C2 推荐全英文。
 *
 * 界面语言只在梯子的低端起作用：一个把界面切成英文的人不会被推去看全中文讲解，
 * 那一档对他降到中英对照。等级仍然管高端 —— C1/C2 两种界面语言都推全英文。
 *
 * 这只是**推荐**。三档始终都能选，用户手点过之后等级再变也不覆盖他的选择，
 * 见 `StepLevel`。
 */
export function recommendedExplanationMode(level: CefrLevel, uiLanguage: string): ExplanationMode {
  if (level === "C1" || level === "C2") return "english_by_level";
  if (level === "B2") return "adaptive_bilingual";
  return uiLanguage.startsWith("zh") ? "chinese" : "adaptive_bilingual";
}

/** 存过的那一档，只认三个合法值；没存过（或存了别的）返回 `null`。 */
export function storedExplanationMode(value: string | undefined): ExplanationMode | null {
  if (value === "chinese" || value === "adaptive_bilingual" || value === "english_by_level") return value;
  return null;
}

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
