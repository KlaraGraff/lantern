/**
 * 翻卡独立页：从 DictionaryContent 的弹窗复习会话拆出（拍板：弹窗退役，
 * 词表行「复习」、标题行「翻卡」入口与堆卡入口都改为跳转本页）。
 * 样张：docs/impls/cijuan-merge-mockup.html §A3 — "只换容器，不换逻辑"：
 * 出处行、挖空句、发音、看句子中文、显示答案、四档评分、进度条、合并条目
 * 提示、完成态，全部照搬原弹窗实现，只是外层从 520px 弹层换成整页。
 *
 * 三种入口：
 * - 直接跳转（标题行「翻卡」按钮）：复习当前到期词。
 * - `?word=<mergeKey>`（词表行「复习」按钮）：该词排在队首，其余到期词
 *   跟在后面 —— 对应原 openReview(entry) 的排序。
 * - `?pile=<pileKey>`（回顾板堆卡，范围新增）：只翻这一堆的词，不看是否
 *   到期 —— 堆本身就是行为触发的理由，不是到期状态。页头标题带上堆名。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, BookOpen, CheckCircle2, Eye, RotateCcw } from "lucide-react";

import Button from "../components/ui/Button";
import PronounceButton from "../components/speech/PronounceButton";
import { useSettings } from "../hooks/useSettings";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { useEdgeSwipeBack } from "../hooks/useEdgeSwipeBack";
import type { DictionaryWord } from "../hooks/useDictionary";
import { dueMergedEntries, mergeVocabWords, type MergedVocabEntry } from "../components/vocab/merge";
import {
  contextualReviewAnswer,
  contextualReviewCloze,
  contextualReviewProgress,
  contextualReviewSource,
  contextualSentenceMeaning,
} from "../components/vocab/contextual-review";
import { pileKey, type ReviewPile, type ReviewPileKind } from "../components/review/review-piles";
import { notifyReaders } from "../utils/notifyReaders";
import { TOP_INSET } from "../utils/top-inset";

type Rating = "again" | "hard" | "good" | "easy";

/** One key cap plus what it does, for the review card's shortcut footer. */
function ReviewShortcut({ cap, label }: { cap: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border border-b-2 bg-bg-muted px-1 font-sans text-[10px] leading-none text-text-secondary">{cap}</kbd>
      {label}
    </span>
  );
}

/**
 * A short label for the page header suffix ("翻卡复习 · 《书名》"). Deliberately
 * not `pileTitleKey` — that returns a full descriptive sentence, not a short
 * label. Kinds with nothing book/chapter-shaped to show (promoted, long unseen)
 * get no suffix at all rather than a repeated generic word.
 */
function pileShortLabel(kind: ReviewPileKind): string | null {
  switch (kind.kind) {
    case "repeat_lookups_in_book":
      return kind.book_title;
    case "recent_chapter_lookups":
      return kind.chapter;
    default:
      return null;
  }
}

export default function FlashcardReview() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pileParam = searchParams.get("pile");
  const wordParam = searchParams.get("word");

  const [now] = useState(() => Date.now());
  const [words, setWords] = useState<DictionaryWord[] | null>(null);
  const [piles, setPiles] = useState<ReviewPile[] | null>(null);
  const { settings, loading: settingsLoading } = useSettings();

  useEffect(() => {
    let cancelled = false;
    invoke<DictionaryWord[]>("list_all_vocab_words")
      .then((result) => {
        if (!cancelled) setWords(result.filter((word) => word.list_status === "confirmed"));
      })
      .catch((err) => {
        console.error("Failed to load vocab words:", err);
        if (!cancelled) setWords([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!pileParam) {
      setPiles([]);
      return;
    }
    let cancelled = false;
    invoke<ReviewPile[]>("list_review_piles")
      .then((result) => { if (!cancelled) setPiles(result); })
      .catch((err) => {
        console.error("Failed to load review piles:", err);
        if (!cancelled) setPiles([]);
      });
    return () => { cancelled = true; };
  }, [pileParam]);

  const primaryOverrides = useMemo<Record<string, string>>(() => {
    const raw = settings.vocab_primary_definition;
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string") as Array<[string, string]>,
      );
    } catch {
      return {};
    }
  }, [settings.vocab_primary_definition]);

  const dataReady = words !== null && piles !== null && !settingsLoading;
  const allEntries = useMemo(() => (words ? mergeVocabWords(words, primaryOverrides) : []), [words, primaryOverrides]);
  const dueEntries = useMemo(() => dueMergedEntries(allEntries, now), [allEntries, now]);
  const matchedPile = useMemo(() => {
    if (!pileParam || !piles) return null;
    return piles.find((pile) => pileKey(pile) === pileParam) ?? null;
  }, [pileParam, piles]);
  const pileSuffix = matchedPile ? pileShortLabel(matchedPile.kind) : null;

  // Built once, from whichever source the URL named, and frozen from then on:
  // rating a card changes its schedule, which must not reshuffle or shrink the
  // round already in progress. Re-fires harmlessly if deps change before the
  // guard trips, but never again after.
  const [queue, setQueue] = useState<MergedVocabEntry[] | null>(null);
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || !dataReady) return;
    initializedRef.current = true;

    if (pileParam) {
      if (!matchedPile) {
        setQueue([]);
        return;
      }
      const byRowId = new Map<string, MergedVocabEntry>();
      for (const entry of allEntries) {
        for (const row of entry.rows) byRowId.set(row.id, entry);
      }
      const seen = new Set<string>();
      const built: MergedVocabEntry[] = [];
      for (const id of matchedPile.word_ids) {
        const entry = byRowId.get(id);
        if (entry && !seen.has(entry.key)) {
          seen.add(entry.key);
          built.push(entry);
        }
      }
      setQueue(built);
      return;
    }

    if (wordParam) {
      const target = allEntries.find((entry) => entry.key === wordParam);
      if (target) {
        setQueue([target, ...dueEntries.filter((entry) => entry.key !== target.key)]);
        return;
      }
    }

    setQueue(dueEntries);
  }, [dataReady, pileParam, wordParam, matchedPile, allEntries, dueEntries]);

  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewAnswerVisible, setReviewAnswerVisible] = useState(false);
  const [reviewMeaningVisible, setReviewMeaningVisible] = useState(false);
  const [reviewComplete, setReviewComplete] = useState(false);
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState(false);
  const [reviewContextIndex, setReviewContextIndex] = useState(0);
  const [reviewContextPickerOpen, setReviewContextPickerOpen] = useState(false);

  const mainRef = useRef<HTMLElement | null>(null);
  const reviewRevealRef = useRef<HTMLButtonElement | null>(null);
  const reviewPronounceRef = useRef<HTMLSpanElement | null>(null);
  const reviewSubmittingRef = useRef(false);

  // An immediately-empty queue (stale pile link, or nothing due) reads as the
  // same "done" screen a finished round does — no separate empty state to
  // design or word for.
  const done = reviewComplete || queue?.length === 0;
  const reviewing = queue && !done ? (queue[reviewIndex] ?? null) : null;

  const reviewContexts = useMemo(
    () => (reviewing ? reviewing.rows.filter((row) => (row.context_sentence?.trim() ?? "") !== "") : []),
    [reviewing],
  );
  const reviewRow = reviewContexts[reviewContextIndex] ?? reviewing?.representative ?? null;
  const reviewCloze = useMemo(() => (reviewRow ? contextualReviewCloze(reviewRow.context_sentence, reviewRow.word) : null), [reviewRow]);
  const reviewAnswer = useMemo(() => (reviewRow ? contextualReviewAnswer(reviewRow.context_sentence, reviewRow.word) : null), [reviewRow]);
  const reviewMeaning = useMemo(() => (reviewRow ? contextualSentenceMeaning(reviewRow.context_explanation) : null), [reviewRow]);
  const reviewProgress = useMemo(() => contextualReviewProgress(reviewIndex, queue?.length ?? 0), [reviewIndex, queue]);
  const reviewSource = useMemo(
    () => (reviewRow ? contextualReviewSource(reviewRow.book_title, reviewRow.chapter, t("common.unknownBook")) : null),
    [reviewRow, t],
  );

  const goBack = useCallback(() => {
    if (reviewSubmittingRef.current) return;
    navigate(-1);
  }, [navigate]);

  // 左滑返回 = 页头返回按钮的触屏拼法；goBack 自带「评分提交中不退出」的闸。
  const isNarrow = useIsNarrow();
  const { ref: swipeBackRef, pointerHandlers: swipeBackHandlers } = useEdgeSwipeBack<HTMLElement>({
    enabled: isNarrow,
    onBack: goBack,
  });

  const recordReview = useCallback(async (id: string, rating: Rating) => {
    const reviewed = await invoke<DictionaryWord>("record_vocab_review", { id, rating });
    notifyReaders("vocab-changed", { bookId: reviewed.book_id, cfi: reviewed.cfi });
    return reviewed;
  }, []);

  const completeReview = useCallback(async (rating: Rating) => {
    if (!reviewing || !queue || reviewSubmittingRef.current) return;
    reviewSubmittingRef.current = true;
    setReviewSubmitting(true);
    setReviewError(false);
    try {
      // One rating for the word. The backend writes the resulting schedule
      // through to the word's other records.
      await recordReview(reviewing.representative.id, rating);
      const nextIndex = reviewIndex + 1;
      if (nextIndex < queue.length) setReviewIndex(nextIndex);
      else setReviewComplete(true);
    } catch {
      setReviewError(true);
    } finally {
      reviewSubmittingRef.current = false;
      setReviewSubmitting(false);
    }
  }, [reviewing, queue, reviewIndex, recordReview]);

  // "只看，不测": the genuine exit from being quizzed. It reveals the
  // definition (if not already visible) and moves on — never recordReview,
  // never an FSRS rating, not even a disguised "again". Available the whole
  // time the card is up, same as the rating buttons.
  const justLook = useCallback(() => {
    if (!reviewing || !queue) return;
    if (!reviewAnswerVisible) {
      setReviewAnswerVisible(true);
      return;
    }
    const nextIndex = reviewIndex + 1;
    if (nextIndex < queue.length) setReviewIndex(nextIndex);
    else setReviewComplete(true);
  }, [reviewing, queue, reviewAnswerVisible, reviewIndex]);

  // "获取提示" is one action with two possible carriers: the saved sentence
  // meaning when the row has one, otherwise the pronunciation, which every
  // card can offer. Keeping the fallback means the advertised shortcut always
  // does something. Clicking the rendered pronounce button (rather than
  // calling the speech hook here) keeps the button's own playback state and
  // the keyboard path identical.
  const revealReviewHint = useCallback(() => {
    // The meaning box only exists on the contextual card, so a word-first
    // fallback row with a saved explanation still gets the audio hint rather
    // than a toggle nothing renders.
    if (reviewCloze && reviewMeaning) {
      setReviewMeaningVisible((visible) => !visible);
      return;
    }
    reviewPronounceRef.current?.querySelector("button")?.click();
  }, [reviewCloze, reviewMeaning]);

  useEffect(() => {
    setReviewAnswerVisible(false);
    setReviewMeaningVisible(false);
    setReviewError(false);
    setReviewContextIndex(0);
    setReviewContextPickerOpen(false);
    const frame = window.requestAnimationFrame(() => (reviewing ? reviewRevealRef.current?.focus() : mainRef.current?.focus()));
    return () => window.cancelAnimationFrame(frame);
  }, [reviewComplete, reviewing]);

  useEffect(() => {
    if (!reviewing && !done) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        goBack();
        return;
      }
      const target = event.target as HTMLElement | null;
      // The hint key is checked before the "focus is on a control" guard
      // below: the reveal button holds focus by default, and H does nothing
      // native on a button, so deferring there would make the advertised
      // shortcut dead exactly where the reader starts. Typing targets are
      // still excluded.
      if (
        reviewing
        && !reviewAnswerVisible
        && !event.metaKey && !event.ctrlKey && !event.altKey
        && (event.key === "h" || event.key === "H")
        && !target?.closest("input, select, textarea, [contenteditable='true']")
      ) {
        event.preventDefault();
        revealReviewHint();
        return;
      }
      if (target?.closest("button, input, select, textarea, [contenteditable='true']")) return;
      if (reviewing && !reviewAnswerVisible && event.code === "Space") {
        event.preventDefault();
        setReviewAnswerVisible(true);
        return;
      }
      if (reviewing && reviewAnswerVisible && !reviewSubmitting && /^[1-4]$/.test(event.key)) {
        const ratings = ["again", "hard", "good", "easy"] as const;
        event.preventDefault();
        void completeReview(ratings[Number(event.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [reviewing, done, reviewAnswerVisible, reviewSubmitting, goBack, completeReview, revealReviewHint]);

  useEffect(() => {
    if (!reviewing || !reviewAnswerVisible) return;
    const frame = window.requestAnimationFrame(() => mainRef.current?.querySelector<HTMLButtonElement>("[data-review-rating]")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [reviewAnswerVisible, reviewing]);

  return (
    <main
      ref={(node) => {
        mainRef.current = node;
        swipeBackRef(node);
      }}
      tabIndex={-1}
      className="flex h-screen flex-col bg-bg-page text-text-primary outline-none"
      {...swipeBackHandlers}
    >
      <header className={`sticky top-0 z-10 flex min-h-[52px] shrink-0 items-center gap-3 border-b border-border bg-bg-surface/95 px-4 backdrop-blur ${TOP_INSET}`}>
        <button
          type="button"
          onClick={goBack}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] text-text-secondary hover:bg-bg-input hover:text-text-primary cursor-pointer"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {t("common.back")}
        </button>
        <h1 className="flex-1 min-w-0 truncate text-center text-[15px] font-semibold text-text-primary">
          {t("flashcards.title")}
          {pileSuffix && <span className="font-normal text-text-muted"> · {pileSuffix}</span>}
        </h1>
        <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-text-muted">
          {!done && queue ? `${reviewProgress.position} / ${reviewProgress.total}` : ""}
        </span>
      </header>
      <div
        role="progressbar"
        aria-hidden={done || !reviewing}
        aria-valuemin={1}
        aria-valuemax={reviewProgress.total}
        aria-valuenow={reviewProgress.position}
        aria-valuetext={t("vocab.reviewProgressLabel", { position: reviewProgress.position, total: reviewProgress.total })}
        className="h-[2px] w-full shrink-0 overflow-hidden bg-bg-muted"
      >
        <div className="h-full bg-accent transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${reviewProgress.ratio * 100}%` }} />
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-8">
        {queue === null ? null : done ? (
          <div className="mx-auto max-w-[520px] py-10 text-center">
            <CheckCircle2 size={34} className="mx-auto text-accent" />
            <h2 className="mt-3 text-[16px] font-semibold text-text-primary">{t("vocab.reviewComplete")}</h2>
            <p className="mt-2 text-[13px] text-text-secondary">{t("vocab.reviewCompleteSub")}</p>
            <Button className="mt-6" variant="primary" size="md" onClick={goBack}>{t("common.back")}</Button>
          </div>
        ) : reviewing && (
          <div className="mx-auto w-full max-w-[520px]">
            {reviewing.books.length > 1 && (
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-accent-bg px-3 py-2 text-[11px] leading-4 text-accent-text">
                <RotateCcw size={12} className="mt-px shrink-0" />
                {t("vocab.review.mergedBanner", { count: reviewing.books.length })}
              </p>
            )}
            {!reviewAnswerVisible ? (
              <div className="flex min-h-[300px] flex-col text-center">
                <p className="flex items-center justify-center gap-1.5 text-[12px] text-text-muted">
                  <BookOpen size={12} className="shrink-0" />
                  {reviewContexts.length > 1 && <span className="shrink-0">{t("vocab.review.contextFrom")}</span>}
                  <span className="max-w-[220px] truncate">{reviewSource?.bookTitle}</span>
                  {reviewSource?.chapter && <>
                    <span aria-hidden="true" className="text-text-muted/60">·</span>
                    <span className="max-w-[180px] truncate">{reviewSource.chapter}</span>
                  </>}
                  {reviewContexts.length > 1 && (
                    <button
                      type="button"
                      aria-expanded={reviewContextPickerOpen}
                      onClick={() => setReviewContextPickerOpen((open) => !open)}
                      className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-text-secondary hover:border-accent hover:bg-accent-bg hover:text-accent-text cursor-pointer"
                    >
                      <RotateCcw size={11} />
                      {t("vocab.review.swapContext")}
                    </button>
                  )}
                </p>
                {reviewContextPickerOpen && reviewContexts.length > 1 && (
                  <div className="mx-auto mt-3 flex w-full max-w-md flex-col gap-1.5 rounded-md border border-border-light bg-bg-muted p-2 text-left">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.4px] text-text-muted">
                      {t("vocab.review.otherContexts", { count: reviewContexts.length - 1 })}
                    </p>
                    {reviewContexts.map((row, index) => (
                      <button
                        key={row.id}
                        type="button"
                        aria-pressed={index === reviewContextIndex}
                        onClick={() => { setReviewContextIndex(index); setReviewContextPickerOpen(false); }}
                        className={`rounded-md border px-2 py-1.5 text-left cursor-pointer ${
                          index === reviewContextIndex
                            ? "border-accent bg-accent-bg"
                            : "border-border bg-bg-surface hover:border-accent"
                        }`}
                      >
                        <span className="block text-[10px] text-text-muted">
                          {row.book_title || t("common.unknownBook")}
                          {row.chapter ? ` · ${row.chapter}` : ""}
                        </span>
                        <span className="mt-0.5 block font-serif text-[12px] leading-[1.6] text-text-secondary line-clamp-2">
                          {row.context_sentence}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {reviewCloze ? <>
                  <p className="mt-4 text-[12px] text-text-muted">{t("vocab.contextReviewPrompt")}</p>
                  <p className="mt-3 font-serif text-[20px] leading-9 text-text-primary">
                    {reviewCloze.segments.map((segment, index) => segment.hidden
                      ? <span key={index} aria-label={t("vocab.hiddenWord")} className="mx-1 inline-block w-28 border-b-2 border-accent align-baseline" />
                      : <span key={index}>{segment.text}</span>)}
                  </p>
                  <div className="mt-5 flex justify-center gap-2">
                    <span ref={reviewPronounceRef} className="inline-flex"><PronounceButton text={reviewing.word} size="md" /></span>
                    {reviewMeaning && <button type="button" onClick={() => setReviewMeaningVisible((visible) => !visible)} className="h-7 rounded-md border border-border px-2 text-[12px] text-text-secondary hover:border-accent hover:bg-accent-bg hover:text-accent-text">{t(reviewMeaningVisible ? "vocab.hideSentenceMeaning" : "vocab.showSentenceMeaning")}</button>}
                  </div>
                  {reviewMeaningVisible && <p className="mx-auto mt-3 max-w-md rounded-md bg-accent-bg px-3 py-2 text-[13px] leading-5 text-text-secondary">{reviewMeaning}</p>}
                </> : <>
                  <div className="mt-12 flex items-center justify-center gap-2">
                    <p className="text-[24px] font-semibold text-text-primary">{reviewing.word}</p>
                    <span ref={reviewPronounceRef} className="inline-flex"><PronounceButton text={reviewing.word} size="md" /></span>
                  </div>
                  <p className="mt-3 text-[12px] text-text-muted">{t("vocab.reviewNoContext")}</p>
                </>}
                <Button ref={reviewRevealRef} className="mt-auto w-full justify-center" variant="primary" size="lg" onClick={() => setReviewAnswerVisible(true)}>{t("vocab.showAnswer")}</Button>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-center gap-2">
                  <p className="text-[22px] font-semibold text-text-primary">{reviewing.word}</p>
                  <PronounceButton text={reviewing.word} size="md" />
                </div>
                {!reviewCloze && <p className="mt-3 rounded-md bg-bg-muted px-3 py-2 text-center text-[12px] text-text-muted">{t("vocab.reviewNoContext")}</p>}
                {reviewAnswer && <p className="mt-4 text-center font-serif text-[17px] leading-7 text-text-secondary">{reviewAnswer.before}<mark className="rounded bg-accent-bg px-0.5 font-semibold text-accent-text">{reviewAnswer.answer}</mark>{reviewAnswer.after}</p>}
                <div className="mt-4 rounded-md bg-bg-muted p-3">
                  <p className="text-[14px] leading-6 text-text-secondary whitespace-pre-line">{reviewing.primary.definition}</p>
                  {reviewMeaning && <p className="mt-3 border-t border-border pt-3 text-[13px] leading-5 text-text-muted">{reviewMeaning}</p>}
                </div>
                {reviewError && <p role="alert" className="mt-4 text-center text-[12px] text-danger-text">{t("vocab.reviewSaveFailed")}</p>}
                <div className="mt-5 grid grid-cols-4 gap-2" aria-busy={reviewSubmitting}>
                  {(["again", "hard", "good", "easy"] as const).map((rating, index) => (
                    <button key={rating} data-review-rating type="button" disabled={reviewSubmitting} onClick={() => void completeReview(rating)} className="h-10 rounded-md border border-border bg-bg-surface text-[12px] font-medium text-text-secondary hover:border-accent hover:bg-accent-bg hover:text-accent-text disabled:cursor-wait disabled:opacity-50 cursor-pointer">
                      {t(`vocab.rating.${rating}`)} <span className="text-text-muted">{index + 1}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-4 flex items-center gap-2 border-t border-border-light pt-3.5">
              <button
                type="button"
                onClick={justLook}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-1 text-[13.5px] font-medium text-text-muted hover:text-accent-text cursor-pointer"
              >
                <Eye size={14} />
                {t("vocab.reviewJustLook")}
              </button>
            </div>
            <div role="group" aria-label={t("vocab.reviewShortcuts")} className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3 text-[11px] text-text-muted">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {!reviewAnswerVisible ? <>
                  <ReviewShortcut cap="Space" label={t("vocab.showAnswer")} />
                  <ReviewShortcut cap="H" label={t("vocab.reviewHint")} />
                </> : (["again", "hard", "good", "easy"] as const).map((rating, index) => (
                  <ReviewShortcut key={rating} cap={String(index + 1)} label={t(`vocab.rating.${rating}`)} />
                ))}
              </span>
              <ReviewShortcut cap="Esc" label={t("common.back")} />
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
