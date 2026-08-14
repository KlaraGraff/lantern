/**
 * 出卷设置屏（docs/impls/cijuan-merge-mockup.html §B，词卷页「出卷」标签）。
 *
 * 两列：左边词从哪来（粘贴 + 从生词本导入 + 错词重现自动混入），右边卷子长什么样
 * （难度、题型、遮词自检）。三项设置（难度/题型/遮词自检）持久化进 useSettings。
 *
 * 词的三档来路（today/vocab/recur）只用于设置屏的预览 chip 着色——生成出的卷面
 * 本身不带来路标记（§B「联动」横幅、§H 已拍板：不给考试提示）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { Check, ImagePlus, Loader2, Sparkles } from "lucide-react";
import Button from "../../components/ui/Button";
import { nextRadioIndex } from "../../components/ui/radio-group.ts";
import { openSettings } from "../../components/settings-open";
import { useSettings } from "../../hooks/useSettings.ts";
import { parseWordInput, isWeakWord } from "../../quiz/split.ts";
import { extractWordsFromImage, mergeExtractedWords, classifyExtractError } from "../../quiz/image-words.ts";
import { parseQuizAiProfileId } from "../../quiz/transport.ts";
import { aiErrorMessageKey, isAiSettingsError, type AiErrorCode } from "../../utils/aiError.ts";
import { WORDS_PER_PASSAGE, type Difficulty, type QuestionType, type QuizWord, type WordOrigin } from "../../quiz/types.ts";
import { compressImageToDataUri } from "./image-compress.ts";
import { useVocabImport, type VocabImportWord } from "./useVocabImport.ts";
import { useWrongWordPool } from "./useWrongWordPool.ts";
import { useQuizHistory, formatQuizDate } from "./useQuizHistory.ts";

const DIFFICULTIES: Difficulty[] = ["cet4", "cet6", "ielts", "kaoyan"];
const WARN_WORD_COUNT = 40;
const MAX_WORD_COUNT = 60;
const VOCAB_VISIBLE_COUNT = 4;

interface SetupTabProps {
  onGenerate: (words: QuizWord[], config: { difficulty: Difficulty; types: QuestionType[]; maskedCheck: boolean }) => void;
}

/**
 * 图片取词的一张图 = 一个 job。识别成功的 chip 直接消失（词已进输入框），
 * 失败的留下来带重试/移除；seq 是「截图 N」的展示编号，删除不回收。
 */
interface ImageJob {
  id: number;
  seq: number;
  thumbUrl: string;
  blob: Blob;
  status: "queued" | "running" | "failed";
}

/** 一批图识别完后的小结（成功的图数 / 新加词数 / 与已有重复数） */
interface ExtractSummary {
  images: number;
  added: number;
  dup: number;
}

/**
 * 致命错误横幅：vision = 出题模型看不了图；ai = 设置类错误码（如钉住的
 * profile 被停用）。两者继续跑队列只会烧钱重复失败，所以整批停下。
 */
type ExtractBanner = { kind: "vision" } | { kind: "ai"; code: AiErrorCode };

function dedupeWords(...groups: { words: string[]; origin: WordOrigin }[]): QuizWord[] {
  const seen = new Set<string>();
  const result: QuizWord[] = [];
  for (const group of groups) {
    for (const word of group.words) {
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ word, origin: group.origin });
    }
  }
  return result;
}

export default function SetupTab({ onGenerate }: SetupTabProps) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const locale = i18n.resolvedLanguage || i18n.language || undefined;
  const { settings, save } = useSettings();
  const [rawText, setRawText] = useState("");
  const [vocabExpanded, setVocabExpanded] = useState(false);

  const vocabImport = useVocabImport();
  const wrongPool = useWrongWordPool();
  const history = useQuizHistory();

  // ---- 图片取词（docs/impls/quiz-image-words.md）----
  // pump 是跨多次渲染的异步循环，读状态得走 ref 拿最新值：rawTextRef 镜像
  // 输入框全文（React 18 的函数式 updater 在渲染期才跑，没法同步拿返回值——
  // 同 TakeView 的 onSaveDraftRef 先例），imageJobsRef 镜像队列。
  const [imageJobs, setImageJobs] = useState<ImageJob[]>([]);
  const [extractSummary, setExtractSummary] = useState<ExtractSummary | null>(null);
  const [extractBanner, setExtractBanner] = useState<ExtractBanner | null>(null);
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number } | null>(null);
  const rawTextRef = useRef(rawText);
  const imageJobsRef = useRef<ImageJob[]>(imageJobs);
  const pumpingRef = useRef(false);
  const jobIdRef = useRef(0);
  const jobSeqRef = useRef(0);
  const batchRef = useRef<ExtractSummary>({ images: 0, added: 0, dup: 0 });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 识别用的模型钉在出题模型上（quiz_ai_profile_id，与词卷全部 AI 调用同款）
  const profileIdRef = useRef<string | undefined>(undefined);
  // 渲染期写 ref 被 react-hooks/refs 禁止，镜像同步放 effect 里跑。
  // rawTextRef 的即时性由 onChange/泵内的同步写保证，这里只兜底对齐。
  useEffect(() => {
    rawTextRef.current = rawText;
  }, [rawText]);
  useEffect(() => {
    profileIdRef.current = parseQuizAiProfileId(settings.quiz_ai_profile_id);
  }, [settings.quiz_ai_profile_id]);

  const updateJobs = useCallback((fn: (jobs: ImageJob[]) => ImageJob[]) => {
    imageJobsRef.current = fn(imageJobsRef.current);
    setImageJobs(imageJobsRef.current);
  }, []);

  // 串行泵：一次识别一张，找到下一张 queued 就跑，跑完队列空了出小结。
  // 串行而不是并发——每张的合并结果要接在上一张之后，且失败分类要能把
  // 「后面还没跑的」整批止损。
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const job = imageJobsRef.current.find((j) => j.status === "queued");
        if (!job) break;
        updateJobs((jobs) => jobs.map((j) => (j.id === job.id ? { ...j, status: "running" as const } : j)));
        try {
          const dataUri = await compressImageToDataUri(job.blob);
          const words = await extractWordsFromImage(dataUri, profileIdRef.current);
          const merged = mergeExtractedWords(rawTextRef.current, words);
          if (merged.addedCount > 0) {
            rawTextRef.current = merged.nextRaw;
            setRawText(merged.nextRaw);
            setHighlightRange({
              start: merged.nextRaw.length - merged.appendedText.length,
              end: merged.nextRaw.length,
            });
          }
          batchRef.current.images += 1;
          batchRef.current.added += merged.addedCount;
          batchRef.current.dup += merged.dupCount;
          URL.revokeObjectURL(job.thumbUrl);
          updateJobs((jobs) => jobs.filter((j) => j.id !== job.id));
        } catch (error) {
          const failure = classifyExtractError(error);
          const fatal = failure.kind === "vision" || (failure.kind === "ai" && isAiSettingsError(failure.code));
          if (fatal) {
            // 换模型/改设置才能解决的错，继续跑队列只会对着同一堵墙重复计费
            // ——当前这张和还没跑的整批一起标失败，横幅给出口。
            setExtractBanner(failure.kind === "vision" ? { kind: "vision" } : failure);
            updateJobs((jobs) =>
              jobs.map((j) => (j.id === job.id || j.status === "queued" ? { ...j, status: "failed" as const } : j)),
            );
          } else {
            updateJobs((jobs) => jobs.map((j) => (j.id === job.id ? { ...j, status: "failed" as const } : j)));
          }
        }
      }
      if (batchRef.current.images > 0) {
        setExtractSummary(batchRef.current);
        batchRef.current = { images: 0, added: 0, dup: 0 };
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [updateJobs]);

  const addImages = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setExtractSummary(null);
      setExtractBanner(null);
      const jobs = images.map((blob) => ({
        id: ++jobIdRef.current,
        seq: ++jobSeqRef.current,
        thumbUrl: URL.createObjectURL(blob),
        blob,
        status: "queued" as const,
      }));
      updateJobs((prev) => [...prev, ...jobs]);
      void pump();
    },
    [pump, updateJobs],
  );

  const retryJob = useCallback(
    (id: number) => {
      setExtractBanner(null);
      updateJobs((jobs) => jobs.map((j) => (j.id === id ? { ...j, status: "queued" as const } : j)));
      void pump();
    },
    [pump, updateJobs],
  );

  const removeJob = useCallback(
    (id: number) => {
      const job = imageJobsRef.current.find((j) => j.id === id);
      if (job) URL.revokeObjectURL(job.thumbUrl);
      updateJobs((jobs) => jobs.filter((j) => j.id !== id));
    },
    [updateJobs],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      addImages(files);
    },
    [addImages],
  );

  // 追加完成后用原生选区把新加的词段高亮出来——textarea 里做不了染色
  // span，选中是它唯一的「刚加了这些」视觉反馈。放 effect 里跑：要等
  // value 落进 DOM 之后 setSelectionRange 才有效。
  useEffect(() => {
    if (!highlightRange) return;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(highlightRange.start, highlightRange.end);
    }
    setHighlightRange(null);
  }, [highlightRange]);

  // 卸载时回收所有缩略图 objectURL（成功/移除的路径已各自回收）
  useEffect(
    () => () => {
      for (const job of imageJobsRef.current) URL.revokeObjectURL(job.thumbUrl);
    },
    [],
  );

  const difficulty = (settings.quiz_difficulty as Difficulty) || "cet6";
  const maskedCheck = settings.quiz_masked_check !== "false";
  const types = useMemo<QuestionType[]>(() => {
    const raw = settings.quiz_question_types;
    if (!raw) return ["reading", "grammarFill"];
    const parsed = raw.split(",").filter(Boolean) as QuestionType[];
    return parsed.length > 0 ? parsed : ["reading", "grammarFill"];
  }, [settings.quiz_question_types]);

  const setDifficulty = useCallback((d: Difficulty) => save("quiz_difficulty", d), [save]);
  const setMaskedCheck = useCallback((on: boolean) => save("quiz_masked_check", on ? "true" : "false"), [save]);
  const toggleType = useCallback(
    (type: QuestionType) => {
      const next = types.includes(type) ? types.filter((x) => x !== type) : [...types, type];
      save("quiz_question_types", next.join(","));
    },
    [types, save],
  );

  const parsedAll = useMemo(() => parseWordInput(rawText), [rawText]);
  const ignoredWeak = useMemo(() => parsedAll.filter(isWeakWord), [parsedAll]);
  const todayWords = useMemo(() => parsedAll.filter((w) => !isWeakWord(w)), [parsedAll]);
  const vocabWords = useMemo(() => vocabImport.selectedWords.map((w) => w.word), [vocabImport.selectedWords]);
  const recurWords = useMemo(() => wrongPool.dueEntries.map((e) => e.word), [wrongPool.dueEntries]);

  const finalWords = useMemo(
    () =>
      dedupeWords(
        { words: todayWords, origin: "today" },
        { words: vocabWords, origin: "vocab" },
        { words: recurWords, origin: "recur" },
      ),
    [todayWords, vocabWords, recurWords],
  );

  const totalCount = finalWords.length;
  const passageCount = totalCount > 0 ? Math.ceil(totalCount / WORDS_PER_PASSAGE.max) : 0;
  const overWarn = totalCount > WARN_WORD_COUNT;
  const overMax = totalCount > MAX_WORD_COUNT;
  const noTypesSelected = types.length === 0;
  const canGenerate = totalCount > 0 && !overMax && !noTypesSelected;

  const lastSubmitted = history.papers.find((p) => p.status === "submitted" && p.result);
  const latestUnfinished = history.unfinished[0];

  const handleDifficultyKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = DIFFICULTIES.indexOf(difficulty);
    const next = nextRadioIndex(e.key, idx, DIFFICULTIES.length);
    if (next === null) return;
    e.preventDefault();
    setDifficulty(DIFFICULTIES[next]);
  };

  const visibleVocab = vocabExpanded ? vocabImport.words : vocabImport.words.slice(0, VOCAB_VISIBLE_COUNT);
  const hiddenVocabCount = vocabImport.words.length - visibleVocab.length;

  const handleGenerate = () => {
    if (!canGenerate) return;
    onGenerate(finalWords, { difficulty, types, maskedCheck });
  };

  return (
    // pb carries the home indicator's inset — this tab's scroll wrapper
    // (Quiz.tsx) is unpadded, so the floor here is the physical screen edge.
    <div className="mx-auto max-w-[900px] px-5 pt-6 pb-[calc(var(--spacing-safe-bottom)+1.5rem)]">
      {latestUnfinished && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium text-text-primary">
              {latestUnfinished.status === "generating"
                ? // 生成中卷的题数只算已落库的篇，报出来会偏低——这条横幅不报数
                  t("quiz.setup.unfinishedBanner.titleGenerating", {
                    date: formatQuizDate(latestUnfinished.createdAt, locale),
                  })
                : t("quiz.setup.unfinishedBanner.title", {
                    date: formatQuizDate(latestUnfinished.createdAt, locale),
                    count: latestUnfinished.readingQuestions.length + latestUnfinished.grammarQuestions.length,
                  })}
            </div>
            <div className="mt-1 text-[12.5px] text-text-muted">{t("quiz.setup.unfinishedBanner.body")}</div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => navigate(`/quiz/paper/${latestUnfinished.id}`)}
          >
            {t("quiz.setup.unfinishedBanner.action")}
          </Button>
        </div>
      )}

      {(recurWords.length > 0 || lastSubmitted) && (
        <div className="mb-4 rounded-xl border border-lavender/40 bg-accent-bg/40 p-3.5 text-[13px] text-text-secondary">
          {recurWords.length > 0 && (
            <span>{t("quiz.setup.thisPaperBanner.recur", { count: recurWords.length })} </span>
          )}
          {lastSubmitted?.result && (
            <span>
              {t("quiz.setup.thisPaperBanner.lastPaper", {
                date: formatQuizDate(lastSubmitted.createdAt, locale),
                score: lastSubmitted.result.score,
                total: lastSubmitted.result.total,
              })}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-7 md:grid-cols-2">
        {/* 左列：词从哪来 */}
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 flex items-baseline gap-2">
              <label className="text-[13.5px] font-semibold text-text-primary">{t("quiz.setup.todayWords.label")}</label>
              {totalCount > 0 && (
                <span className="text-[12px] text-text-muted">
                  {t("quiz.setup.todayWords.recognized", {
                    words: t("quiz.setup.wordCount", { count: totalCount }),
                    passages: t("quiz.setup.passageCount", { count: passageCount }),
                  })}
                </span>
              )}
            </div>
            {/* A soft keyboard capitalises the first letter of every line and
              * quietly rewrites what it thinks is a typo — habits that suit
              * prose and ruin a word list. These words are matched against the
              * vocab list and carried into the paper verbatim, so an
              * autocapitalised 「acquaintance → Acquaintance」 is a different
              * string than the one that was saved while reading. */}
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={rawText}
                onChange={(e) => {
                  rawTextRef.current = e.target.value;
                  setRawText(e.target.value);
                }}
                onPaste={handlePaste}
                placeholder={t("quiz.setup.todayWords.placeholder")}
                rows={5}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="w-full resize-none rounded-lg border border-border bg-bg-surface px-3.5 py-3 pb-9 font-serif text-[14px] leading-[1.6] text-text-primary outline-none placeholder:font-sans placeholder:text-text-placeholder focus:border-accent"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute bottom-3 right-2.5 flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-text-muted transition-colors hover:bg-bg-muted hover:text-text-secondary"
              >
                <ImagePlus size={14} />
                {t("quiz.setup.imageWords.button")}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  addImages(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>

            {imageJobs.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {imageJobs.map((job) => (
                  <div
                    key={job.id}
                    className={`flex items-center gap-2 rounded-lg border py-1.5 pl-1.5 pr-2.5 text-[12px] ${
                      job.status === "failed" ? "border-danger/40 bg-danger-bg/50" : "border-border bg-bg-surface"
                    }`}
                  >
                    <img src={job.thumbUrl} alt="" className="size-8 shrink-0 rounded object-cover" />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-text-secondary">{t("quiz.setup.imageWords.chipName", { index: job.seq })}</span>
                      <span
                        className={`flex items-center gap-1 text-[11.5px] ${
                          job.status === "failed" ? "text-danger" : "text-text-muted"
                        }`}
                      >
                        {job.status === "running" && <Loader2 size={11} className="animate-spin" />}
                        {job.status === "queued"
                          ? t("quiz.setup.imageWords.chipQueued")
                          : job.status === "running"
                            ? t("quiz.setup.imageWords.chipRunning")
                            : t("quiz.setup.imageWords.chipFailed")}
                      </span>
                    </div>
                    {job.status === "failed" && (
                      <div className="ml-1 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => retryJob(job.id)}
                          className="cursor-pointer text-[12px] font-medium text-accent-text hover:underline"
                        >
                          {t("quiz.setup.imageWords.retry")}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeJob(job.id)}
                          aria-label={t("quiz.setup.imageWords.remove")}
                          className="cursor-pointer text-[13px] leading-none text-text-muted hover:text-text-secondary"
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {extractSummary && (
              <div className="mt-2 rounded-lg bg-bg-input px-3.5 py-2.5 text-[12.5px] text-text-secondary">
                {extractSummary.added > 0
                  ? t("quiz.setup.imageWords.summary", {
                      // 一句话里三个数，i18next 一个 key 只认一个 count——
                      // 同 generateHint.ready：每个数各自成片段，这里只拼接。
                      images: t("quiz.setup.imageWords.summaryImages", { count: extractSummary.images }),
                      words: t("quiz.setup.wordCount", { count: extractSummary.added }),
                    }) + (extractSummary.dup > 0 ? t("quiz.setup.imageWords.summaryDup", { count: extractSummary.dup }) : "")
                  : extractSummary.dup > 0
                    ? t("quiz.setup.imageWords.summaryNoneNew")
                    : t("quiz.setup.imageWords.summaryNoneFound")}
              </div>
            )}

            {extractBanner && (
              <div className="mt-2 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger-bg/60 px-3.5 py-2.5 text-[12.5px] leading-[1.6]">
                <span className="flex-1 text-danger">
                  {extractBanner.kind === "vision"
                    ? t("quiz.setup.imageWords.visionBanner.body")
                    : t(aiErrorMessageKey(extractBanner.code))}
                </span>
                <button
                  type="button"
                  onClick={() => openSettings({ section: "services", view: "models" })}
                  className="shrink-0 cursor-pointer text-[12.5px] font-medium text-accent-text hover:underline"
                >
                  {t("quiz.setup.imageWords.visionBanner.action")}
                </button>
              </div>
            )}

            {finalWords.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {finalWords.map((w) => (
                  <span
                    key={`${w.origin}:${w.word}`}
                    className={
                      w.origin === "today"
                        ? "rounded-md bg-bg-input px-2 py-0.5 text-[12px] text-text-secondary"
                        : w.origin === "vocab"
                          ? "rounded-md bg-accent-bg px-2 py-0.5 text-[12px] text-accent-text"
                          : "rounded-md border border-dashed border-border px-2 py-0.5 text-[12px] text-text-muted"
                    }
                  >
                    {w.word}
                  </span>
                ))}
              </div>
            )}

            {(todayWords.length > 0 || vocabWords.length > 0 || recurWords.length > 0) && (
              <div className="mt-2 flex flex-wrap gap-3.5 text-[11.5px] text-text-muted">
                <span>{t("quiz.setup.origin.pasted")} {todayWords.length}</span>
                <span>{t("quiz.setup.origin.vocab")} {vocabWords.length}</span>
                <span>{t("quiz.setup.origin.recur")} {recurWords.length}</span>
              </div>
            )}
          </div>

          {ignoredWeak.length > 0 && (
            <div className="rounded-lg border border-border-light bg-bg-muted px-3.5 py-3 text-[12.5px] leading-[1.6] text-text-secondary">
              <span className="mr-1.5 rounded bg-bg-input px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
                {t("quiz.setup.ignoredBanner.tag")}
              </span>
              {t("quiz.setup.ignoredBanner.body", { words: ignoredWeak.join("、") })}
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-baseline gap-2">
              <label className="text-[13.5px] font-semibold text-text-primary">{t("quiz.setup.vocabImport.label")}</label>
              <span className="text-[12px] text-text-muted">{t("quiz.setup.vocabImport.hint")}</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-bg-surface">
              <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
                <VocabCheckbox
                  checked={vocabImport.allSelected}
                  onToggle={() => (vocabImport.allSelected ? vocabImport.clearSelection() : vocabImport.selectAll())}
                  ariaLabel={t("quiz.setup.vocabImport.selectAll")}
                />
                <span className="text-[12.5px] text-text-secondary">
                  {vocabImport.words.length > 0
                    ? t("quiz.setup.vocabImport.dueCount", {
                        count: vocabImport.words.length,
                        selected: vocabImport.selected.size,
                      })
                    : t("quiz.setup.vocabImport.dueCountUnselected", { count: vocabImport.words.length })}
                </span>
              </div>

              {vocabImport.loading && (
                <div className="px-3.5 py-4 text-center text-[12.5px] text-text-muted">{t("quiz.setup.vocabImport.loading")}</div>
              )}
              {!vocabImport.loading && vocabImport.error && (
                <div className="px-3.5 py-4 text-center text-[12.5px] text-text-muted">{t("quiz.setup.vocabImport.loadError")}</div>
              )}
              {!vocabImport.loading && !vocabImport.error && vocabImport.words.length === 0 && (
                <div className="px-3.5 py-4 text-center text-[12.5px] text-text-muted">{t("quiz.setup.vocabImport.empty")}</div>
              )}
              {!vocabImport.loading &&
                visibleVocab.map((w: VocabImportWord) => (
                  <div key={w.id} className="flex items-center gap-2.5 border-b border-border-light px-3.5 py-2.5 text-[13px] last:border-b-0">
                    <VocabCheckbox
                      checked={vocabImport.selected.has(w.id)}
                      onToggle={() => vocabImport.toggle(w.id)}
                      ariaLabel={w.word}
                    />
                    <span className="min-w-[100px] font-serif text-[14px] text-text-primary">{w.word}</span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">{w.definition}</span>
                  </div>
                ))}
              {!vocabExpanded && hiddenVocabCount > 0 && (
                <button
                  type="button"
                  onClick={() => setVocabExpanded(true)}
                  className="block w-full cursor-pointer py-2.5 text-center text-[12.5px] text-text-muted hover:bg-bg-muted"
                >
                  {t("quiz.setup.vocabImport.expandRest", { count: hiddenVocabCount })}
                </button>
              )}
            </div>
            <div className="mt-2.5 rounded-lg border border-lavender/40 bg-accent-bg/40 px-3.5 py-3 text-[12.5px] leading-[1.6] text-text-secondary">
              {t("quiz.setup.vocabImport.linkNote")}
            </div>
          </div>
        </div>

        {/* 右列：卷子长什么样 */}
        <div className="flex flex-col gap-5">
          <div>
            <div className="mb-1.5 text-[13.5px] font-semibold text-text-primary">{t("quiz.setup.difficulty.label")}</div>
            <div role="radiogroup" aria-label={t("quiz.setup.difficulty.label")} className="inline-flex gap-0.5 rounded-lg bg-bg-input p-[3px]">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={difficulty === d}
                  onClick={() => setDifficulty(d)}
                  onKeyDown={handleDifficultyKeyDown}
                  className={`h-8 rounded-md px-3 text-[13px] transition-colors ${
                    difficulty === d
                      ? "bg-bg-surface font-semibold text-accent-text shadow-sm"
                      : "text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {t(`quiz.difficulty.${d}`)}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[12px] text-text-muted">{t("quiz.setup.difficulty.hint")}</div>
          </div>

          <div>
            <div className="mb-1.5 flex items-baseline gap-2">
              <div className="text-[13.5px] font-semibold text-text-primary">{t("quiz.setup.material.label")}</div>
              <span className="text-[12px] text-text-muted">{t("quiz.setup.material.hint")}</span>
            </div>
            <div className="inline-flex gap-0.5 rounded-lg bg-bg-input p-[3px]">
              <button type="button" className="h-8 rounded-md bg-bg-surface px-3 text-[13px] font-semibold text-accent-text shadow-sm">
                {t("quiz.setup.material.aiOriginal")}
              </button>
              <button type="button" disabled className="h-8 cursor-not-allowed rounded-md px-3 text-[13px] text-text-muted opacity-45">
                {t("quiz.setup.material.examAdapted")}
              </button>
              <button type="button" disabled className="h-8 cursor-not-allowed rounded-md px-3 text-[13px] text-text-muted opacity-45">
                {t("quiz.setup.material.examVerbatim")}
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[13.5px] font-semibold text-text-primary">{t("quiz.setup.types.label")}</div>
            <div className="divide-y divide-border-light rounded-xl border border-border">
              <TypeRow
                title={t("quiz.setup.types.reading.title")}
                desc={t("quiz.setup.types.reading.desc")}
                checked={types.includes("reading")}
                onChange={() => toggleType("reading")}
              />
              <TypeRow
                title={t("quiz.setup.types.grammarFill.title")}
                desc={t("quiz.setup.types.grammarFill.desc")}
                checked={types.includes("grammarFill")}
                onChange={() => toggleType("grammarFill")}
              />
              <TypeRow
                title={t("quiz.setup.types.bankedCloze.title")}
                desc={t("quiz.setup.types.bankedCloze.desc")}
                checked={false}
                onChange={() => {}}
                disabled
              />
              <TypeRow
                title={t("quiz.setup.types.maskedCheck.title")}
                desc={t("quiz.setup.types.maskedCheck.desc")}
                checked={maskedCheck}
                onChange={() => setMaskedCheck(!maskedCheck)}
              />
            </div>
          </div>
        </div>
      </div>

      {overWarn && (
        <div className={`mt-5 rounded-lg px-3.5 py-2.5 text-[12.5px] ${overMax ? "bg-danger-bg text-danger" : "bg-bg-input text-text-secondary"}`}>
          {overMax ? t("quiz.setup.wordLimit.blocked", { count: totalCount }) : t("quiz.setup.wordLimit.warn", { count: totalCount })}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3.5 border-t border-border pt-4">
        <Button size="lg" disabled={!canGenerate} onClick={handleGenerate}>
          <Sparkles size={15} />
          {t("quiz.setup.generateButton")}
        </Button>
        <span className="text-[12.5px] text-text-muted">
          {totalCount === 0
            ? t("quiz.setup.generateHint.empty")
            : noTypesSelected
              ? t("quiz.setup.generateHint.noTypes")
              : overMax
                ? t("quiz.setup.generateHint.overMax")
                : t("quiz.setup.generateHint.ready", {
                  // Two counts in one sentence, and i18next pluralises on one
                  // `count` per key — so each number is its own plural-aware
                  // fragment and this key only joins them.
                  words: t("quiz.setup.wordCount", { count: totalCount }),
                  passages: t("quiz.setup.passageCount", { count: passageCount }),
                })}
        </span>
      </div>
    </div>
  );
}

function TypeRow({
  title,
  desc,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-[73px] items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className={`text-[14px] font-medium ${disabled ? "text-text-muted" : "text-text-primary"}`}>{title}</div>
        <div className="mt-0.5 text-[12px] leading-[1.5] text-text-muted">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onChange}
        className={`relative h-6 w-11 shrink-0 overflow-hidden rounded-full transition-colors ${
          disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"
        } ${checked ? "bg-accent" : "bg-border"}`}
      >
        <div
          aria-hidden="true"
          className={`absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

function VocabCheckbox({ checked, onToggle, ariaLabel }: { checked: boolean; onToggle: () => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
      className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
        checked ? "border-accent bg-accent text-white" : "border-border bg-bg-surface"
      }`}
    >
      {checked && <Check size={10} strokeWidth={3.5} />}
    </button>
  );
}
