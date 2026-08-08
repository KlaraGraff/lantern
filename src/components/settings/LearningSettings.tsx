import { useCallback, useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import i18n from "../../i18n";
import Select from "../ui/Select";
import { ROW_CONTROL_WIDTH, type SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";
import { notifyAllReaders } from "../../utils/notifyReaders";
import {
  CEFR_LEVELS,
  EXAM_OPTIONS,
  EXAM_SCORE_RULES,
  scoreWithinRule,
  type ScoreRule,
} from "./cefr";

interface CefrEstimate {
  estimated_cefr: string;
  lower_cefr: string | null;
  upper_cefr: string | null;
  confidence: string;
  needs_confirmation: boolean;
}

interface LanguageAssessment extends CefrEstimate {
  id: string;
  exam_type: string;
  overall_score: number;
  reading_score: number | null;
  exam_date: string | null;
  mapping_version: string;
  created_at: number;
  updated_at: number;
}

interface LanguageAssessmentSummary extends CefrEstimate {
  assessment_count: number;
  reading_assessment_count: number;
  official_assessment_count: number;
  latest_exam_date: string | null;
  primary_assessment_id: string;
}

function normalizedExplanationMode(value: string | undefined): string {
  if (value === "english_by_level" || value === "chinese") return value;
  return "adaptive_bilingual";
}

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localDateInputValue(date = new Date()): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

/**
 * 学习 — everything about *how Lantern explains English to this reader*:
 * level, explanation language, translation language, exam-based estimates,
 * and (since lookup history is learning data, not app data) how long lookup
 * records are kept. Moved here verbatim from `GeneralSettings.tsx`, where it
 * used to sit between display name and interface language — the reason this
 * section exists at all.
 */
export default function LearningSettings({ settings, loading, save, saveBulk, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [lookupHistoryRetention, setLookupHistoryRetention] = useState("0");
  const [profileSoftLimit, setProfileSoftLimit] = useState("1200");
  const [cefrLevel, setCefrLevel] = useState("B1");
  const [cefrSource, setCefrSource] = useState("manual");
  const [explanationMode, setExplanationMode] = useState("adaptive_bilingual");
  const [translationLanguage, setTranslationLanguage] = useState("zh");
  const [levelWordClass, setLevelWordClass] = useState("ai");
  const [lowLevelEnglishAcknowledged, setLowLevelEnglishAcknowledged] = useState(false);
  const [showLowLevelEnglishWarning, setShowLowLevelEnglishWarning] = useState(false);
  const [examFormOpen, setExamFormOpen] = useState(false);
  const [examType, setExamType] = useState("ielts");
  const [overallScore, setOverallScore] = useState("");
  const [readingScore, setReadingScore] = useState("");
  const [examDate, setExamDate] = useState("");
  const [assessments, setAssessments] = useState<LanguageAssessment[]>([]);
  const [assessmentSummary, setAssessmentSummary] = useState<LanguageAssessmentSummary | null>(null);
  const [assessmentsLoading, setAssessmentsLoading] = useState(true);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [assessmentLoadFailed, setAssessmentLoadFailed] = useState(false);
  const [savingAssessment, setSavingAssessment] = useState(false);
  const [deletingAssessmentId, setDeletingAssessmentId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const migratedLanguageSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (settings.lookup_history_retention_days) {
      setLookupHistoryRetention(settings.lookup_history_retention_days);
    }
    if (settings["profile.soft_limit"]) {
      setProfileSoftLimit(settings["profile.soft_limit"]);
    }
    setCefrLevel(settings.cefr_level || "B1");
    setCefrSource(settings.cefr_source || "manual");
    const translatedTo = settings.translation_language || "zh";
    const mode = normalizedExplanationMode(settings.explanation_mode);
    setExplanationMode(mode);
    setTranslationLanguage(translatedTo);
    setLevelWordClass(settings.level_observation_word_class === "local" ? "local" : "ai");
    const acknowledged = settings.cefr_low_level_english_warning_ack === "true";
    setLowLevelEnglishAcknowledged(acknowledged);
    setShowLowLevelEnglishWarning(
      !acknowledged
      && (settings.cefr_level === "A1" || settings.cefr_level === "A2")
      && mode === "english_by_level",
    );
    const migration: Record<string, string> = {};
    if (!settings.translation_language) migration.translation_language = translatedTo;
    const migrationSignature = JSON.stringify(migration);
    if (Object.keys(migration).length > 0
      && migratedLanguageSignatureRef.current !== migrationSignature) {
      migratedLanguageSignatureRef.current = migrationSignature;
      void saveBulk(migration).catch((error) => {
        if (migratedLanguageSignatureRef.current === migrationSignature) {
          migratedLanguageSignatureRef.current = null;
        }
        console.error("Failed to migrate language settings:", error);
      });
    }
  }, [settings, loading, saveBulk]);

  const refreshAssessments = useCallback(async () => {
    setAssessmentsLoading(true);
    setAssessmentError(null);
    setAssessmentLoadFailed(false);
    try {
      const [history, summary] = await Promise.all([
        invoke<LanguageAssessment[]>("list_language_assessments"),
        invoke<LanguageAssessmentSummary | null>("summarize_language_assessments"),
      ]);
      setAssessments(history);
      setAssessmentSummary(summary);
    } catch {
      setAssessmentError(t("settings.learner.loadFailed"));
      setAssessmentLoadFailed(true);
    } finally {
      setAssessmentsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshAssessments();
  }, [refreshAssessments]);

  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const formatExamDate = (date: string | null) => {
    if (!date) return t("settings.learner.noExamDate");
    const parsed = new Date(`${date}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? date : dateFormatter.format(parsed);
  };

  const levelDescription = t(`settings.learner.levels.${cefrLevel}`, { defaultValue: "" });
  const examLabel = (type: string) => EXAM_OPTIONS.find((option) => option.value === type)?.label ?? type;
  const confidenceLabel = (confidence: string) => t(`settings.learner.confidence.${confidence}`, {
    defaultValue: confidence,
  });
  const basisLabel = (assessment: LanguageAssessment) => assessment.reading_score != null
    ? t("settings.learner.basisReading", { score: assessment.reading_score })
    : t("settings.learner.basisOverall", { score: assessment.overall_score });
  const summaryLevels = assessmentSummary?.needs_confirmation
    ? CEFR_LEVELS.filter((level) => {
        const lower = CEFR_LEVELS.indexOf(assessmentSummary.lower_cefr as typeof CEFR_LEVELS[number]);
        const upper = CEFR_LEVELS.indexOf(assessmentSummary.upper_cefr as typeof CEFR_LEVELS[number]);
        const current = CEFR_LEVELS.indexOf(level);
        return current >= lower && current <= upper;
      })
    : [];
  const examScoreRules = EXAM_SCORE_RULES[examType] ?? EXAM_SCORE_RULES.ielts;
  const scorePlaceholder = (rule: ScoreRule) => t(
    rule.step === 1 ? "settings.learner.scoreRange" : "settings.learner.scoreRangeStep",
    { min: rule.min, max: rule.max, step: rule.step },
  );

  const applyAssessmentLevel = async (level: string, source: string) => {
    setCefrLevel(level);
    setCefrSource(source);
    setShowLowLevelEnglishWarning(
      (level === "A1" || level === "A2")
      && explanationMode === "english_by_level"
      && !lowLevelEnglishAcknowledged,
    );
    await save("cefr_level", level);
    await save("cefr_source", source);
    showSavedToast(t("settings.learner.levelApplied"));
  };

  const saveAssessment = async () => {
    setAssessmentError(null);
    setAssessmentLoadFailed(false);
    if (overallScore.trim() === "" || !Number.isFinite(Number(overallScore))) {
      setAssessmentError(t("settings.learner.scoreRequired"));
      return;
    }
    if (readingScore.trim() !== "" && !Number.isFinite(Number(readingScore))) {
      setAssessmentError(t("settings.learner.readingInvalid"));
      return;
    }
    if (!scoreWithinRule(Number(overallScore), examScoreRules.overall)
      || (readingScore.trim() !== "" && !scoreWithinRule(Number(readingScore), examScoreRules.reading))) {
      setAssessmentError(t("settings.learner.scoreOutOfRange"));
      return;
    }
    setSavingAssessment(true);
    try {
      await invoke<LanguageAssessment>("save_language_assessment", {
        examType,
        overallScore: Number(overallScore),
        readingScore: readingScore.trim() === "" ? null : Number(readingScore),
        examDate: examDate || null,
      });
      setOverallScore("");
      setReadingScore("");
      setExamDate("");
      setExamFormOpen(false);
      await refreshAssessments();
      showSavedToast(t("settings.learner.assessmentSaved"));
    } catch (error) {
      const code = errorCode(error);
      setAssessmentError(
        code.includes("LANGUAGE_SCORE_INVALID")
          ? t("settings.learner.scoreOutOfRange")
          : code.includes("LANGUAGE_EXAM_DATE_IN_FUTURE")
            ? t("settings.learner.dateInFuture")
            : code.includes("LANGUAGE_EXAM_DATE_INVALID")
              ? t("settings.learner.dateInvalid")
              : t("settings.learner.assessmentFailed"),
      );
    } finally {
      setSavingAssessment(false);
    }
  };

  const deleteAssessment = async (id: string) => {
    setDeletingAssessmentId(id);
    setAssessmentError(null);
    setAssessmentLoadFailed(false);
    try {
      await invoke("delete_language_assessment", { id });
      setConfirmDeleteId(null);
      await refreshAssessments();
      showSavedToast(t("settings.learner.assessmentDeleted"));
    } catch {
      setAssessmentError(t("settings.learner.deleteFailed"));
    } finally {
      setDeletingAssessmentId(null);
    }
  };

  return (
    <div>
      <div className="flex min-h-[96px] flex-wrap items-center justify-between gap-4 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-[14px] font-medium text-text-primary">
            {t("settings.learner.cefr", { defaultValue: "Learning level" })}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5">
            {t("settings.learner.cefrHint", { defaultValue: "Controls the vocabulary used by English explanations" })}
          </p>
          <p className="mt-1.5 text-[12px] leading-5 text-text-secondary">
            <span className="font-semibold text-text-primary">{cefrLevel}</span>
            {levelDescription ? ` · ${levelDescription}` : ""}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {cefrSource === "manual"
              ? t("settings.learner.manualSource")
              : t("settings.learner.assessmentSource")}
          </p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={cefrLevel}
          onChange={(level) => {
            setCefrLevel(level);
            setCefrSource("manual");
            const lowLevel = level === "A1" || level === "A2";
            setShowLowLevelEnglishWarning(
              lowLevel && explanationMode === "english_by_level" && !lowLevelEnglishAcknowledged,
            );
            void Promise.all([
              save("cefr_level", level),
              save("cefr_source", "manual"),
            ]).then(() => showSavedToast(t("settings.learner.manualLevelSaved")));
          }}
          options={CEFR_LEVELS.map((level) => ({ value: level, label: level }))}
        />
      </div>
      <div className="flex min-h-[82px] flex-wrap items-center justify-between gap-4 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-[14px] font-medium text-text-primary">
            {t("settings.learner.explanationMode", { defaultValue: "Explanation language" })}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5 max-w-[290px]">
            {t("settings.learner.explanationModeHint", { defaultValue: "A1-A2 use accurate Chinese plus simple English; higher levels gradually use more English" })}
          </p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={explanationMode}
          onChange={(mode) => {
            setExplanationMode(mode);
            setShowLowLevelEnglishWarning(
              mode === "english_by_level"
              && (cefrLevel === "A1" || cefrLevel === "A2")
              && !lowLevelEnglishAcknowledged,
            );
            void save("explanation_mode", mode).then(() => showSavedToast());
          }}
          options={[
            { value: "adaptive_bilingual", label: t("settings.learner.adaptiveBilingual", { defaultValue: "Adaptive bilingual" }) },
            { value: "english_by_level", label: t("settings.learner.englishByLevel", { defaultValue: "English by level" }) },
            { value: "chinese", label: t("settings.learner.chinese", { defaultValue: "Chinese" }) },
          ]}
        />
      </div>
      <div className="flex min-h-[82px] flex-wrap items-center justify-between gap-4 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-[14px] font-medium text-text-primary">
            {t("settings.learner.translationLanguage")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5 max-w-[290px]">
            {t("settings.learner.translationLanguageHint")}
          </p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={translationLanguage}
          onChange={(value) => {
            setTranslationLanguage(value);
            void save("translation_language", value).then(() => showSavedToast());
          }}
          options={LANGUAGE_OPTIONS}
        />
      </div>
      <div className="flex min-h-[82px] flex-wrap items-center justify-between gap-4 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-[14px] font-medium text-text-primary">
            {t("settings.learner.levelWordClass")}
          </p>
          <p className="text-[12px] text-text-muted mt-0.5 max-w-[290px]">
            {t("settings.learner.levelWordClassHint")}
          </p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={levelWordClass}
          onChange={(value) => {
            setLevelWordClass(value);
            void save("level_observation_word_class", value).then(() => showSavedToast());
          }}
          options={[
            { value: "ai", label: t("settings.learner.levelWordClassAi") },
            { value: "local", label: t("settings.learner.levelWordClassLocal") },
          ]}
        />
      </div>

      {showLowLevelEnglishWarning && (
        <div role="status" className="mb-4 flex items-start gap-2 rounded-md border border-accent/25 bg-accent-bg px-3 py-2.5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent-text" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] leading-5 text-text-secondary">
              {t("settings.learner.lowLevelEnglishWarning")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setLowLevelEnglishAcknowledged(true);
                  setShowLowLevelEnglishWarning(false);
                  void save("cefr_low_level_english_warning_ack", "true").then(() => showSavedToast());
                }}
                className="h-7 rounded-md border border-border bg-bg-surface px-2.5 text-[11px] font-medium text-text-secondary hover:border-accent"
              >
                {t("settings.learner.continueEnglish")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setExplanationMode("adaptive_bilingual");
                  setShowLowLevelEnglishWarning(false);
                  void save("explanation_mode", "adaptive_bilingual").then(() => showSavedToast());
                }}
                className="h-7 rounded-md bg-accent px-2.5 text-[11px] font-medium text-white"
              >
                {t("settings.learner.useAdaptiveBilingual")}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="mb-5 border-t border-border-light pt-4" aria-labelledby="exam-estimate-title">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-[220px] flex-1">
            <p id="exam-estimate-title" className="text-[13px] font-medium text-text-primary">
              {t("settings.learner.examEstimate", { defaultValue: "Estimate from an exam score" })}
            </p>
            <p className="mt-0.5 text-[11px] leading-5 text-text-muted">
              {t("settings.learner.examEstimateHint", { defaultValue: "An estimate is guidance only. Manual level selection always takes priority." })}
            </p>
          </div>
          <button
            type="button"
            aria-expanded={examFormOpen}
            onClick={() => {
              setExamFormOpen((open) => !open);
              setAssessmentError(null);
              setAssessmentLoadFailed(false);
            }}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-surface px-2.5 text-[12px] font-medium text-text-secondary hover:border-accent"
          >
            <Plus size={14} />
            {t("settings.learner.addAssessment")}
            {examFormOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        </div>

        {examFormOpen && (
          <form
            noValidate
            className="mt-3 rounded-md border border-border bg-bg-muted p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAssessment();
            }}
          >
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr))]">
              <Select
                label={t("settings.learner.examType")}
                value={examType}
                onChange={(value) => {
                  setExamType(value);
                  setAssessmentError(null);
                  setAssessmentLoadFailed(false);
                }}
                options={EXAM_OPTIONS}
              />
              <label className="block text-[14px] font-semibold text-text-primary">
                {t("settings.learner.overall")}
                <input
                  type="number"
                  min={examScoreRules.overall.min}
                  max={examScoreRules.overall.max}
                  step={examScoreRules.overall.step}
                  required
                  value={overallScore}
                  placeholder={scorePlaceholder(examScoreRules.overall)}
                  onChange={(event) => setOverallScore(event.target.value)}
                  className="mt-1.5 h-9 w-full min-w-0 rounded-lg border border-transparent bg-bg-input px-3 text-[13px] font-medium text-text-primary placeholder:font-normal placeholder:text-text-placeholder outline-none hover:border-border focus:border-accent"
                />
              </label>
              <label className="block text-[14px] font-semibold text-text-primary">
                {t("settings.learner.readingOptional")}
                <input
                  type="number"
                  min={examScoreRules.reading.min}
                  max={examScoreRules.reading.max}
                  step={examScoreRules.reading.step}
                  value={readingScore}
                  placeholder={scorePlaceholder(examScoreRules.reading)}
                  onChange={(event) => setReadingScore(event.target.value)}
                  className="mt-1.5 h-9 w-full min-w-0 rounded-lg border border-transparent bg-bg-input px-3 text-[13px] font-medium text-text-primary placeholder:font-normal placeholder:text-text-placeholder outline-none hover:border-border focus:border-accent"
                />
              </label>
              <label className="block text-[14px] font-semibold text-text-primary">
                {t("settings.learner.examDateOptional")}
                <input
                  type="date"
                  max={localDateInputValue()}
                  value={examDate}
                  onChange={(event) => setExamDate(event.target.value)}
                  className="mt-1.5 h-9 w-full min-w-0 rounded-lg border border-transparent bg-bg-input px-3 text-[13px] font-medium text-text-primary outline-none hover:border-border focus:border-accent"
                />
              </label>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-text-muted">
              {t("settings.learner.readingPriorityHint")}
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setExamFormOpen(false);
                  setAssessmentError(null);
                  setAssessmentLoadFailed(false);
                }}
                className="h-8 rounded-md px-3 text-[12px] font-medium text-text-muted hover:bg-bg-input"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={savingAssessment || overallScore.trim() === ""}
                className="h-8 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-40"
              >
                {savingAssessment ? t("settings.learner.saving") : t("settings.learner.saveAndEstimate")}
              </button>
            </div>
          </form>
        )}

        {assessmentError && (
          <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-md bg-danger-bg px-3 py-2 text-[11px] leading-5 text-danger-text">
            <span className="break-words">{assessmentError}</span>
            {assessmentLoadFailed && (
              <button type="button" onClick={() => void refreshAssessments()} className="shrink-0 font-medium underline">
                {t("common.retry")}
              </button>
            )}
          </div>
        )}

        {assessmentSummary && (
          <div className="mt-4 border-y border-border-light py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-[220px] flex-1">
                <p className="text-[12px] font-medium text-text-primary">
                  {assessmentSummary.needs_confirmation
                    ? t("settings.learner.combinedRange", {
                        lower: assessmentSummary.lower_cefr,
                        upper: assessmentSummary.upper_cefr,
                      })
                    : t("settings.learner.combinedResult", { level: assessmentSummary.estimated_cefr })}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-text-muted">
                  {t("settings.learner.combinedBasis", {
                    count: assessmentSummary.assessment_count,
                    reading: assessmentSummary.reading_assessment_count,
                    official: assessmentSummary.official_assessment_count,
                    date: formatExamDate(assessmentSummary.latest_exam_date),
                  })}
                  {` · ${confidenceLabel(assessmentSummary.confidence)}`}
                </p>
              </div>
              {!assessmentSummary.needs_confirmation && (
                <button
                  type="button"
                  onClick={() => void applyAssessmentLevel(assessmentSummary.estimated_cefr, "assessment:combined")}
                  className="h-8 shrink-0 rounded-md border border-border bg-bg-surface px-3 text-[12px] font-medium text-text-secondary hover:border-accent"
                >
                  {t("settings.learner.useEstimate", { defaultValue: "Use this level" })}
                </button>
              )}
            </div>
            {assessmentSummary.needs_confirmation && (
              <div className="mt-3">
                <p className="text-[11px] leading-5 text-text-secondary">
                  {t("settings.learner.conflictConfirmation")}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {summaryLevels.map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => void applyAssessmentLevel(level, "assessment:confirmed")}
                      className="h-8 min-w-10 rounded-md border border-border bg-bg-surface px-3 text-[12px] font-semibold text-text-secondary hover:border-accent hover:text-accent-text"
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="text-[12px] font-medium text-text-primary">
            {t("settings.learner.assessmentHistory")}
          </p>
          {!assessmentsLoading && assessments.length > 0 && (
            <span className="text-[11px] text-text-muted">
              {t("settings.learner.assessmentCount", { count: assessments.length })}
            </span>
          )}
        </div>

        {assessmentsLoading ? (
          <p className="mt-3 text-[11px] text-text-muted">{t("settings.learner.loadingAssessments")}</p>
        ) : assessments.length === 0 ? (
          <p className="mt-3 rounded-md bg-bg-muted px-3 py-3 text-[11px] leading-5 text-text-muted">
            {t("settings.learner.noAssessments")}
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {assessments.map((assessment) => {
              const isPrimary = assessment.id === assessmentSummary?.primary_assessment_id;
              const formattedDate = formatExamDate(assessment.exam_date);
              return (
                <article key={assessment.id} className="rounded-md border border-border bg-bg-surface px-3 py-2.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-[12px] font-semibold text-text-primary">{examLabel(assessment.exam_type)}</p>
                        <span className="text-[11px] text-text-muted">{formattedDate}</span>
                        {isPrimary && (
                          <span className="rounded bg-accent-bg px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                            {t("settings.learner.primaryEvidence")}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[12px] text-text-secondary">
                        {assessment.needs_confirmation
                          ? t("settings.learner.recordRange", {
                              lower: assessment.lower_cefr,
                              upper: assessment.upper_cefr,
                            })
                          : t("settings.learner.recordResult", { level: assessment.estimated_cefr })}
                        {` · ${confidenceLabel(assessment.confidence)}`}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-text-muted">
                        {basisLabel(assessment)}
                        {assessment.reading_score != null
                          ? ` · ${t("settings.learner.overallReference", { score: assessment.overall_score })}`
                          : ""}
                        {` · ${t("settings.learner.mappingVersion", { version: assessment.mapping_version })}`}
                      </p>
                    </div>
                    {confirmDeleteId === assessment.id ? (
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          disabled={deletingAssessmentId === assessment.id}
                          onClick={() => void deleteAssessment(assessment.id)}
                          className="h-7 rounded-md bg-danger-bg px-2 text-[11px] font-medium text-danger-text disabled:opacity-40"
                        >
                          {t("common.confirm")}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="h-7 rounded-md px-2 text-[11px] text-text-muted hover:bg-bg-input"
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(assessment.id)}
                        title={t("settings.learner.deleteAssessment")}
                        aria-label={t("settings.learner.deleteAssessment")}
                        className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between min-h-[73px] py-3">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.general.lookupHistoryRetention")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.lookupHistoryRetentionHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={lookupHistoryRetention}
          onChange={async (days) => {
            setLookupHistoryRetention(days);
            await save("lookup_history_retention_days", days);
            await invoke("prune_lookup_records", { retentionDays: Number(days) || null });
            // Retention is library-wide, so this one is not about a book and
            // every open reader has to redraw.
            notifyAllReaders("lookup-record-changed");
            showSavedToast();
          }}
          options={[
            { value: "0", label: t("settings.general.lookupHistoryForever") },
            { value: "30", label: t("settings.general.lookupHistory30Days") },
            { value: "90", label: t("settings.general.lookupHistory90Days") },
            { value: "365", label: t("settings.general.lookupHistory1Year") },
          ]}
        />
      </div>

      <div className="flex items-center justify-between min-h-[73px] py-3 border-t border-black/10">
        <div>
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.learner.profileSoftLimit")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.learner.profileSoftLimitHint")}</p>
        </div>
        <input
          type="number"
          min={200}
          max={10000}
          step={100}
          value={profileSoftLimit}
          onChange={(event) => setProfileSoftLimit(event.target.value)}
          onBlur={async () => {
            const parsed = Math.max(200, Math.min(10000, parseInt(profileSoftLimit, 10) || 1200));
            const normalized = String(parsed);
            setProfileSoftLimit(normalized);
            if (normalized !== settings["profile.soft_limit"]) {
              await save("profile.soft_limit", normalized);
              showSavedToast();
            }
          }}
          className={`${ROW_CONTROL_WIDTH} h-9 rounded-lg border border-transparent bg-bg-input px-3 text-[13px] font-medium text-text-primary text-center outline-none hover:border-border focus:border-accent`}
        />
      </div>
    </div>
  );
}
