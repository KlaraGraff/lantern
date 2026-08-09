import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Select from "../ui/Select";
import {
  LEARNING_CARD_CONFIG_SETTING_KEY,
  LEARNING_CARD_SOURCE_LEVEL,
  LEARNING_CARD_SOURCE_SETTING_KEY,
  cardDesignConfigForLevel,
  cardPresetFollowsLevel,
  serializeCardDesignConfig,
} from "../learning-card";
import {
  CEFR_LEVELS,
  EXAM_OPTIONS,
  EXAM_SCORE_RULES,
  resolveInitialCefrLevel,
  scoreWithinRule,
  type CefrLevel,
} from "../settings/cefr";
import {
  explanationSampleKey,
  recommendedExplanationMode,
  storedExplanationMode,
  type ExplanationMode,
} from "./explanation-samples";

const EXPLANATION_MODES: ExplanationMode[] = ["chinese", "adaptive_bilingual", "english_by_level"];

const MODE_NAME_KEY: Record<ExplanationMode, string> = {
  chinese: "settings.learner.chinese",
  adaptive_bilingual: "settings.learner.adaptiveBilingual",
  english_by_level: "settings.learner.englishByLevel",
};

const MODE_NOTE_KEY: Record<ExplanationMode, string> = {
  chinese: "onboarding.step1.noteChinese",
  adaptive_bilingual: "onboarding.step1.noteBilingual",
  english_by_level: "onboarding.step1.noteEnglish",
};

interface CefrEstimate {
  estimated_cefr: string;
  lower_cefr: string | null;
  upper_cefr: string | null;
  confidence: string;
  needs_confirmation: boolean;
}

interface LanguageAssessment extends CefrEstimate {
  id: string;
}

interface StepLevelProps {
  settings: Record<string, string>;
  save: (key: string, value: string) => Promise<void>;
  onNext: () => void;
}

/**
 * Step 1 of onboarding — pick (or estimate) an English level. Reuses the same
 * six-level scale and exam-conversion command as Settings → General, but
 * trimmed to just the overall score: onboarding is meant to take seconds, and
 * the fuller reading-score / ambiguous-range flow stays available later in
 * Settings for anyone who wants that precision.
 */
export default function StepLevel({ settings, save, onNext }: StepLevelProps) {
  const { t, i18n } = useTranslation();
  const [level, setLevel] = useState<CefrLevel>(() => resolveInitialCefrLevel(settings));
  const [source, setSource] = useState("manual");
  const [examOpen, setExamOpen] = useState(false);
  const [examType, setExamType] = useState("ielts");
  const [score, setScore] = useState("");
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState(false);
  const [conversionResult, setConversionResult] = useState<{ level: string; examLabel: string; score: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // `null` = 还没自己挑过，跟着等级的推荐走。改过等级就换一档推荐，这是这一步
  // 最想说清的那件事：等级不只调解释的难度，也调用什么语言解释。重放引导时把
  // 存过的那一档当成「自己挑过」—— 已经表过态的选择不该被等级重新覆盖一遍。
  const [pickedMode, setPickedMode] = useState<ExplanationMode | null>(() =>
    storedExplanationMode(settings.explanation_mode),
  );
  const [touched, setTouched] = useState(false);
  // 读一次就够：引导这一步不会有别人来改卡片配置，而每次渲染都重算会让说明文案
  // 在保存后自己消失。
  const [followsLevel] = useState(() => cardPresetFollowsLevel(settings));
  const recommendedMode = recommendedExplanationMode(level, i18n.language);
  const explanationMode = pickedMode ?? recommendedMode;

  const examScoreRule = EXAM_SCORE_RULES[examType]?.overall ?? EXAM_SCORE_RULES.ielts.overall;
  const examLabel = EXAM_OPTIONS.find((option) => option.value === examType)?.label ?? examType;

  const convert = async () => {
    if (score.trim() === "" || !scoreWithinRule(Number(score), examScoreRule)) {
      setConversionError(true);
      setConversionResult(null);
      return;
    }
    setConverting(true);
    setConversionError(false);
    try {
      const assessment = await invoke<LanguageAssessment>("save_language_assessment", {
        examType,
        overallScore: Number(score),
        readingScore: null,
        examDate: null,
      });
      setLevel(assessment.estimated_cefr as CefrLevel);
      setSource("assessment:onboarding");
      setConversionResult({ level: assessment.estimated_cefr, examLabel, score });
      setTouched(true);
    } catch {
      setConversionError(true);
      setConversionResult(null);
    } finally {
      setConverting(false);
    }
  };

  const handleNext = async () => {
    setSaving(true);
    try {
      await Promise.all([
        save("cefr_level", level),
        save("cefr_source", source),
        save("explanation_mode", explanationMode),
        // 等级换的是学习卡默认显示哪几块 —— A 档卡在句子上，C 档卡在词的分寸
        // 上。只在读者没自己动过卡片时写，见 `cardPresetFollowsLevel`。
        ...(followsLevel
          ? [
              save(LEARNING_CARD_CONFIG_SETTING_KEY, serializeCardDesignConfig(cardDesignConfigForLevel(level))),
              save(LEARNING_CARD_SOURCE_SETTING_KEY, LEARNING_CARD_SOURCE_LEVEL),
            ]
          : []),
      ]);
      onNext();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-text-primary">{t("onboarding.step1.title")}</h2>
      <p className="mt-2 text-[13px] leading-5 text-text-secondary">{t("onboarding.step1.why")}</p>

      <div className="mt-5 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {CEFR_LEVELS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setLevel(option);
              setSource("manual");
              setConversionResult(null);
              setTouched(true);
            }}
            className={`h-11 rounded-md border text-[13px] font-semibold transition-colors ${
              level === option
                ? "border-accent bg-accent-bg text-accent-text"
                : "border-border bg-bg-surface text-text-secondary hover:border-accent"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {followsLevel && (
        <p className="mt-2.5 text-[11.5px] leading-[17px] text-text-muted">
          {t("onboarding.step1.cardPresetNote", { section: t("settings.tools.title") })}
        </p>
      )}

      <div className="mt-4 border-t border-border-light pt-3">
        <button
          type="button"
          aria-expanded={examOpen}
          onClick={() => setExamOpen((open) => !open)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-accent-text"
        >
          {examOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("onboarding.step1.examDisclosure")}
        </button>

        {examOpen && (
          <div className="mt-3 rounded-md border border-border bg-bg-muted p-3">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto]">
              <Select
                value={examType}
                onChange={(value) => {
                  setExamType(value);
                  setConversionError(false);
                  setConversionResult(null);
                }}
                options={EXAM_OPTIONS}
              />
              <Input
                type="number"
                min={examScoreRule.min}
                max={examScoreRule.max}
                step={examScoreRule.step}
                value={score}
                onChange={(event) => {
                  setScore(event.target.value);
                  setConversionError(false);
                }}
                placeholder={`${examScoreRule.min}–${examScoreRule.max}`}
              />
              <Button
                variant="primary"
                size="md"
                disabled={converting || score.trim() === ""}
                onClick={() => void convert()}
              >
                {converting && <Loader2 size={13} className="animate-spin" />}
                {converting ? t("onboarding.step1.examConverting") : t("onboarding.step1.examConvert")}
              </Button>
            </div>
            {conversionResult && (
              <p className="mt-2 text-[12px] leading-5 text-accent-text">
                {t("onboarding.step1.conversionResult", conversionResult)}
              </p>
            )}
            {conversionError && (
              <p role="alert" className="mt-2 text-[12px] text-danger-text">
                {t("onboarding.step1.conversionFailed")}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-border-light pt-3.5">
        <p className="text-[13px] font-semibold text-text-primary">{t("onboarding.step1.langHead")}</p>
        <p className="mt-1 text-[12px] leading-[18px] text-text-muted">{t("onboarding.step1.langSub")}</p>

        <div className="mt-3 flex flex-col gap-2">
          {EXPLANATION_MODES.map((mode) => {
            const selected = explanationMode === mode;
            return (
              <div
                key={mode}
                className={`overflow-hidden rounded-md border bg-bg-surface ${
                  selected ? "border-accent" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    setPickedMode(mode);
                    setTouched(true);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                >
                  <span
                    className={`relative size-[15px] flex-none rounded-full border-[1.5px] ${
                      selected ? "border-accent" : "border-border"
                    }`}
                  >
                    {selected && (
                      <span className="absolute inset-[3px] rounded-full bg-accent" />
                    )}
                  </span>
                  <span className="text-[13px] font-semibold text-text-primary">{t(MODE_NAME_KEY[mode])}</span>
                  {mode === recommendedMode && (
                    <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[11px] font-medium text-accent-text">
                      {t("onboarding.step1.recommendedTag")}
                    </span>
                  )}
                  <span className="ml-auto text-[12px] text-text-muted">{t(MODE_NOTE_KEY[mode])}</span>
                </button>

                {selected && (
                  <div className="border-t border-dashed border-border bg-bg-muted px-3 py-2.5 pl-[37px]">
                    <p className="mb-1.5 flex items-center gap-1 text-[11px] text-text-muted">
                      {mode === "english_by_level"
                        ? t("onboarding.step1.sampleLabelLeveled", { level })
                        : t("onboarding.step1.sampleLabel")}
                    </p>
                    <p className="mb-1.5 text-[12px] italic text-text-muted">
                      {t("onboarding.step1.sampleBefore")}
                      <b className="border-b-[1.5px] border-accent font-normal not-italic text-text-secondary">
                        {t("onboarding.step1.sampleWord")}
                      </b>
                      {t("onboarding.step1.sampleAfter")}
                    </p>
                    <p className="text-[12.5px] leading-[19px] text-text-secondary">
                      {t(explanationSampleKey(mode, level))}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p className="mt-2.5 text-[11.5px] leading-[17px] text-text-muted">{t("onboarding.step1.langFootnote")}</p>
      </div>

      <div className="mt-5 flex items-center justify-end border-t border-border-light pt-4">
        <Button variant="primary" size="md" disabled={saving} onClick={() => void handleNext()}>
          {saving && <Loader2 size={13} className="animate-spin" />}
          {touched ? t("onboarding.next") : t("onboarding.step1.nextRecommended")}
        </Button>
      </div>
    </div>
  );
}
