import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import Button from "../ui/Button";
import Input from "../ui/Input";
import Select from "../ui/Select";
import {
  CEFR_LEVELS,
  EXAM_OPTIONS,
  EXAM_SCORE_RULES,
  resolveInitialCefrLevel,
  scoreWithinRule,
  type CefrLevel,
} from "../settings/cefr";

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
  onSkip: () => void;
}

/**
 * Step 1 of onboarding — pick (or estimate) an English level. Reuses the same
 * six-level scale and exam-conversion command as Settings → General, but
 * trimmed to just the overall score: onboarding is meant to take seconds, and
 * the fuller reading-score / ambiguous-range flow stays available later in
 * Settings for anyone who wants that precision.
 */
export default function StepLevel({ settings, save, onNext, onSkip }: StepLevelProps) {
  const { t } = useTranslation();
  const [level, setLevel] = useState<CefrLevel>(() => resolveInitialCefrLevel(settings));
  const [source, setSource] = useState("manual");
  const [examOpen, setExamOpen] = useState(false);
  const [examType, setExamType] = useState("ielts");
  const [score, setScore] = useState("");
  const [converting, setConverting] = useState(false);
  const [conversionError, setConversionError] = useState(false);
  const [conversionResult, setConversionResult] = useState<{ level: string; examLabel: string; score: string } | null>(null);
  const [saving, setSaving] = useState(false);

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
      await Promise.all([save("cefr_level", level), save("cefr_source", source)]);
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

      <div className="mt-6 flex items-center justify-between border-t border-border-light pt-4">
        <button
          type="button"
          onClick={onSkip}
          className="text-[13px] font-medium text-text-muted hover:text-text-secondary"
        >
          {t("onboarding.skip")}
        </button>
        <Button variant="primary" size="md" disabled={saving} onClick={() => void handleNext()}>
          {saving && <Loader2 size={13} className="animate-spin" />}
          {t("onboarding.next")}
        </Button>
      </div>
    </div>
  );
}
