// Explicit extension: this module is loaded directly by the node test runner,
// which does not resolve extensionless imports the way Vite does.
import { CEFR_LEVELS, DEFAULT_CEFR_LEVEL, type CefrLevel } from "../settings/cefr.ts";

export type ExplanationMode = "chinese" | "adaptive_bilingual" | "english_by_level";

export const EXPLANATION_MODE_SETTING_KEY = "explanation_mode";

/**
 * 讲解语言这一档是谁定的：`level` 表示跟着等级的推荐来，`manual` 表示读者自己
 * 挑过。跟 `learning_card_source` 同一条规矩 —— 等级是输入，这个键记的是谁说了
 * 最后一句话。
 */
export const EXPLANATION_MODE_SOURCE_SETTING_KEY = "explanation_mode_source";
export const EXPLANATION_MODE_SOURCE_LEVEL = "level";
export const EXPLANATION_MODE_SOURCE_MANUAL = "manual";

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
 * 改等级时该不该顺手把讲解语言也换成新等级的推荐档。
 *
 * 没有 `explanation_mode_source` 的老数据 —— 也就是这个键存在之前走完引导的人
 * —— 不能照搬学习卡那条「存过就算他自己挑的」：引导**总是**写 `explanation_mode`，
 * 哪怕读者一下都没点，存下来的也只是那一档推荐值。照搬的话谁都跟不上等级，
 * 要修的那个缺口原样留着。
 *
 * 所以未标记时改看值本身：存的正好是**当时那个等级**会推荐的一档，就说明他没
 * 偏离过推荐，当作跟随；存的是别的一档，那是他主动挑的，不动。界面语言换过的
 * 人可能被误判成「自己挑过」（推荐值跟着界面语言变），这一侧偏保守 ——
 * 少跟一次只是维持现状，多覆盖一次却会掀掉读者明确表过的态。
 */
export function explanationModeFollowsLevel(
  settings: Record<string, string | undefined>,
  uiLanguage: string,
): boolean {
  const source = settings[EXPLANATION_MODE_SOURCE_SETTING_KEY];
  if (source === EXPLANATION_MODE_SOURCE_MANUAL) return false;
  if (source === EXPLANATION_MODE_SOURCE_LEVEL) return true;
  const stored = storedExplanationMode(settings[EXPLANATION_MODE_SETTING_KEY]);
  if (!stored) return true;
  const level = settings.cefr_level;
  const storedLevel = (CEFR_LEVELS as readonly string[]).includes(level ?? "")
    ? (level as CefrLevel)
    : DEFAULT_CEFR_LEVEL;
  return stored === recommendedExplanationMode(storedLevel, uiLanguage);
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
