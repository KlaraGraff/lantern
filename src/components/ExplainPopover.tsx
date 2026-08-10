import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X, Loader2, WandSparkles, BookmarkPlus, Check, Copy, Settings, MessageSquareMore, BookOpenCheck, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePopoverPosition } from "./use-popover-position";
import AiMarkdown from "./ai-markdown/AiMarkdown";
import { aiErrorMessageKey, getAiErrorCode, isAiRetryableError, isAiSettingsError, type AiErrorCode } from "../utils/aiError";
import AiRetryButton from "./AiRetryButton";
import { createUuid } from "../utils/randomUuid";
import { notifyReaders } from "../utils/notifyReaders";
import { saveVocabWord } from "./vocab/collect";
import { focusWordFor } from "./focus-word";
import { timeAgo } from "../utils/timeAgo";

interface ExplainPopoverProps {
  x: number;
  y: number;
  text: string;
  sentence: string;
  bookTitle?: string;
  bookAuthor?: string;
  chapter?: string;
  bookId: string;
  cfi?: string;
  onClose: () => void;
  customAction?: { name: string; prompt: string };
  onAskFollowUp?: (quote: string, cfi?: string, focusWord?: string) => void;
}

interface AiStreamChunk {
  delta: string;
  done: boolean;
  error?: string;
}

/** The subset of the backend `Explanation` row this popover actually reads —
 *  see `src-tauri/src/commands/explanations.rs`. */
interface ExplanationRow {
  id: string;
  explanation: string;
  saved: boolean;
  updated_at: number;
}

function useExplainStream(
  passage: string,
  surrounding: string | undefined,
  bookTitle: string | undefined,
  bookAuthor: string | undefined,
  chapter: string | undefined,
  bookId: string,
  cfi: string | undefined,
  customAction?: { name: string; prompt: string },
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [aiError, setAiError] = useState<AiErrorCode | null>(null);
  const [streamError, setStreamError] = useState(false);
  // Bumped by the retry button (and the header's "re-explain" button — same
  // mechanism). Re-running the effect is the retry: the listener, request id
  // and cleanup all have to be set up again anyway. It also naturally
  // bypasses the cache — see the `attempt === 0` gate below.
  const [attempt, setAttempt] = useState(0);
  // Set when attempt 0 found a cached row instead of streaming. Drives the
  // "explained N days ago" line and skips the thinking skeleton / cursor.
  const [fromCache, setFromCache] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  // The persisted row's id, once one exists — from a cache hit or from the
  // save that follows a clean stream finish. The footer's "save explanation"
  // button needs this before it can do anything.
  const [savedId, setSavedId] = useState<string | null>(null);
  const [explanationSaved, setExplanationSaved] = useState(false);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    contentRef.current = "";
    setContent("");
    setStreaming(true);
    setAiError(null);
    setStreamError(false);
    setFromCache(false);
    setCachedAt(null);
    setSavedId(null);
    setExplanationSaved(false);

    const run = async () => {
      // Attempt 0 of a normal explain (not a custom action) checks the cache
      // first. A miss, or any failure reading the cache, falls straight
      // through to the real request — a broken cache must never break
      // explain. Retries (attempt > 0) always skip this and hit the model.
      if (attempt === 0 && !customAction) {
        try {
          const cached = await invoke<ExplanationRow | null>("get_cached_explanation", {
            bookId,
            cfi: cfi || null,
            passage,
          });
          if (cancelled) return;
          if (cached) {
            contentRef.current = cached.explanation;
            setContent(cached.explanation);
            setStreaming(false);
            setFromCache(true);
            setCachedAt(cached.updated_at);
            setSavedId(cached.id);
            setExplanationSaved(cached.saved);
            return;
          }
        } catch {
          // Cache lookup failed — treat exactly like a miss.
        }
      }
      if (cancelled) return;

      const requestId = createUuid();
      requestIdRef.current = requestId;

      unlistenRef.current = await listen<AiStreamChunk>(
        `${customAction ? "ai-custom-action-chunk" : "ai-lookup-chunk"}-${requestId}`,
        (event) => {
          if (cancelled) return;
          if (event.payload.done) {
            if (event.payload.error) {
              const errorCode = getAiErrorCode(event.payload.error);
              if (isAiSettingsError(errorCode)) setAiError(errorCode);
              else setStreamError(true);
            } else if (!customAction && contentRef.current.trim()) {
              // Stream ended cleanly with real content — write it to the
              // cache. Never surfaces as an explain error: a save failure is
              // logged and otherwise ignored, the reader already has their
              // explanation on screen.
              // The command takes one `input` struct; its fields deserialize
              // via serde without rename_all, so they stay snake_case here.
              invoke<ExplanationRow>("save_explanation", {
                input: {
                  book_id: bookId,
                  passage,
                  explanation: contentRef.current,
                  context_sentence: surrounding || null,
                  chapter: chapter || null,
                  cfi: cfi || null,
                  provider_profile_id: null,
                  model: null,
                },
              })
                .then((row) => {
                  if (cancelled) return;
                  setSavedId(row.id);
                  setExplanationSaved(row.saved);
                })
                .catch((err) => {
                  console.error("Failed to save explanation:", err);
                });
            }
            setStreaming(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
            requestIdRef.current = null;
            return;
          }
          contentRef.current += event.payload.delta;
          setContent(contentRef.current);
        }
      );

      try {
        await invoke(customAction ? "ai_custom_action" : "ai_explain", customAction ? {
          name: customAction.name,
          prompt: customAction.prompt,
          text: passage,
          context: surrounding || null,
          bookTitle: bookTitle || null,
          chapter: chapter || null,
          requestId,
          retry: attempt > 0,
        } : {
          passage,
          surrounding: surrounding || null,
          bookTitle: bookTitle || null,
          bookAuthor: bookAuthor || null,
          chapter: chapter || null,
          requestId,
          retry: attempt > 0,
        });
      } catch (err) {
        if (!cancelled) {
          const msg = String(err);
          const errorCode = getAiErrorCode(msg);
          if (isAiSettingsError(errorCode)) {
            setAiError(errorCode);
          } else {
            setContent(`Error: ${msg}`);
          }
          setStreaming(false);
        }
        if (requestIdRef.current === requestId) {
          requestIdRef.current = null;
          unlistenRef.current?.();
          unlistenRef.current = null;
        }
      }
    };

    run();

    return () => {
      cancelled = true;
      if (requestIdRef.current) invoke("ai_cancel", { requestId: requestIdRef.current }).catch(() => {});
      requestIdRef.current = null;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [passage, surrounding, bookAuthor, bookTitle, chapter, bookId, cfi, customAction, attempt]);

  return {
    content,
    contentRef,
    streaming,
    aiError,
    streamError,
    fromCache,
    cachedAt,
    savedId,
    explanationSaved,
    markExplanationSaved: () => setExplanationSaved(true),
    retry: () => setAttempt((count) => count + 1),
  };
}

export default function ExplainPopover({
  x,
  y,
  text,
  sentence,
  bookTitle,
  bookAuthor,
  chapter,
  bookId,
  cfi,
  onClose,
  customAction,
  onAskFollowUp,
}: ExplainPopoverProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const { ref: floatingRef, style: floatingStyle, className: motionClass, isOutside } = usePopoverPosition(x, y);
  // A single word keeps today's "save to vocab" primary action; anything
  // with internal whitespace is a passage, which gets "save explanation"
  // instead (see docs/impls/q257-persist-explanations.md §2.3).
  const isSingleWordSelection = /^\S+$/.test(text.trim());
  // "Check the local dictionary first" on the AI_NOT_CONFIGURED screen — a
  // fallback path, so a miss (word absent, or the lookup itself failing) is
  // just as silent here as it is in VocabEntryDetails' own use of this
  // command: the state settles on "not found" either way.
  const [dictState, setDictState] = useState<"idle" | "loading" | "found" | "notFound">("idle");
  const [dictText, setDictText] = useState("");

  const checkLocalDictionary = () => {
    setDictState("loading");
    invoke<{ explain: string }>("dictionary_gloss", { word: text })
      .then((entry) => {
        const trimmed = entry.explain.trim();
        if (trimmed) {
          setDictText(trimmed);
          setDictState("found");
        } else {
          setDictState("notFound");
        }
      })
      .catch(() => setDictState("notFound"));
  };

  // Shared by the AI_NOT_CONFIGURED screen's "Connect now" and the generic
  // settings-error screen below — both close this popover, then focus the
  // main window's Settings on the AI services tab. A cross-window Tauri event
  // rather than the same-window `openSettings()` DOM event, because a reader
  // window can be detached from main and this popover can be mounted in it.
  const openAiSettings = async () => {
    onClose();
    await invoke("open_settings_on_main", { section: "services" });
    const main = await WebviewWindow.getByLabel("main");
    await main?.setFocus();
  };

  const {
    content,
    contentRef,
    streaming,
    aiError,
    streamError,
    fromCache,
    cachedAt,
    savedId,
    explanationSaved,
    markExplanationSaved,
    retry,
  } = useExplainStream(
    text,
    sentence,
    bookTitle,
    bookAuthor,
    chapter,
    bookId,
    cfi,
    customAction,
  );


  // Check if this text is already saved to the vocab list
  useEffect(() => {
    invoke<string | null>("check_vocab_exists", { bookId, word: text }).then((id) => {
      if (id) setSaved(true);
    }).catch(() => {});
  }, [bookId, text]);

  const handleSave = async () => {
    try {
      // The streamed explanation is the long form: it goes to
      // `context_explanation`, and `definition` keeps the one short line the
      // reader sees above the word and in the vocabulary list.
      await saveVocabWord({
        bookId,
        word: text,
        gloss: contentRef.current,
        contextSentence: sentence || null,
        contextExplanation: contentRef.current || null,
        cfi: cfi || null,
      });
      setSaved(true);
      notifyReaders("vocab-changed", { bookId, cfi: cfi || undefined });
    } catch (err) {
      console.error("Failed to save vocab word:", err);
    }
  };

  // Multi-word passages' primary footer action: flips the already-persisted
  // cache row's `saved` flag to 1. Only reachable once `savedId` exists —
  // either from a cache hit or from the write that follows a clean stream.
  const handleSaveExplanation = async () => {
    if (!savedId) return;
    try {
      await invoke("set_explanation_saved", { id: savedId, saved: true });
      markExplanationSaved();
    } catch (err) {
      console.error("Failed to save explanation:", err);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(contentRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Dismiss on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  // Dismiss on click outside — delay registration to avoid catching the
  // context-menu click that opened us
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (isOutside(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose, isOutside]);

  return (
    <>
    <div className="fixed inset-0 z-40" onClick={onClose} />
    <div
      ref={floatingRef}
      className={`${motionClass} fixed z-[62] w-[440px] bg-bg-surface border border-border/80 rounded-xl shadow-context`}
      style={floatingStyle}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2.5 bg-accent-bg rounded-t-xl border-b border-border/40">
        <div className="flex items-center gap-2">
          <WandSparkles size={16} className="text-accent-text" />
          <span className="text-[14px] font-medium text-accent-text tracking-[-0.15px]">
            {customAction?.name ?? t("explain.title")}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={retry}
            disabled={streaming}
            title={t("explain.reexplain")}
            aria-label={t("explain.reexplain")}
            className="size-6 flex items-center justify-center rounded hover:bg-bg-surface/60 cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent"
          >
            <RotateCcw size={14} className="text-text-muted" />
          </button>
          <button
            onClick={onClose}
            className="size-6 flex items-center justify-center rounded hover:bg-bg-surface/60 cursor-pointer"
          >
            <X size={14} className="text-text-muted" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 pb-2 max-h-[360px] overflow-auto">
        {/* Selected passage */}
        <div className="border-l-2 border-[#c084fc] pl-3 pt-3 pb-1">
          <p className="text-[12px] italic text-text-muted line-clamp-3">{text}</p>
        </div>

        {/* Cache-hit replay marker — content appeared at once, not streamed */}
        {fromCache && cachedAt != null && (
          <div className="pl-3 pt-1">
            <span className="text-[12px] text-text-muted">
              {t("explain.cachedAt", { when: timeAgo(cachedAt) })}
            </span>
          </div>
        )}

        {aiError === "AI_NOT_CONFIGURED" ? (
          <div className="flex flex-col gap-3 py-3 text-left">
            <div>
              <p className="text-[13px] font-medium text-text-primary">{t("ai.notConfiguredExplain.title")}</p>
              <p className="mt-1 text-[12px] leading-5 text-text-muted">{t("ai.notConfiguredExplain.body")}</p>
            </div>
            <button
              onClick={() => void openAiSettings()}
              className="flex items-center gap-1.5 self-start text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
            >
              <Settings size={14} />
              {t("ai.notConfiguredExplain.connect")}
            </button>

            <div className="border-t border-border/40 pt-3">
              {dictState === "idle" ? (
                <button
                  onClick={checkLocalDictionary}
                  className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-accent-text cursor-pointer"
                >
                  <BookOpenCheck size={13} />
                  {t("ai.notConfiguredExplain.checkDictionary")}
                </button>
              ) : dictState === "loading" ? (
                <div className="flex items-center gap-1.5 text-[12px] text-text-muted">
                  <Loader2 size={13} className="animate-spin" />
                  {t("ai.notConfiguredExplain.dictLoading")}
                </div>
              ) : dictState === "notFound" ? (
                <p className="text-[12px] text-text-muted">{t("ai.notConfiguredExplain.dictNotFound")}</p>
              ) : (
                <div>
                  <p className="text-[10px] font-medium uppercase tracking-[0.5px] text-text-muted">
                    {t("ai.notConfiguredExplain.dictLabel")}
                  </p>
                  <p className="mt-1 text-[13px] leading-5 text-text-primary">{dictText}</p>
                </div>
              )}
            </div>
          </div>
        ) : aiError ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <p className="text-[13px] text-text-muted">{t(aiErrorMessageKey(aiError))}</p>
            <button
              onClick={() => void openAiSettings()}
              className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
            >
              <Settings size={14} />
              {t("ai.openSettings")}
            </button>
            {isAiRetryableError(aiError) && <AiRetryButton onClick={retry} />}
          </div>
        ) : streaming && !content ? (
          <div className="flex items-center gap-1.5 py-3">
            <Loader2 size={14} className="animate-spin text-text-muted" />
            <span className="text-[13px] text-text-muted">{t("explain.thinking")}</span>
          </div>
        ) : streamError ? (
          <div className="flex flex-col items-center gap-2 py-3 text-center">
            <p className="text-[13px] text-text-muted">{t("ai.requestFailed")}</p>
            <AiRetryButton onClick={retry} />
          </div>
        ) : (
          <div className="pt-2.5">
            <AiMarkdown size="compact" streaming={streaming} className="text-[13px] text-text-primary">
              {content}
            </AiMarkdown>
            {streaming && (
              <Loader2 size={12} className="inline-block ml-0.5 animate-spin text-text-muted" />
            )}
          </div>
        )}
      </div>

      {/* Footer — Save, Ask Follow Up, Copy */}
      {!streaming && content && !aiError && !streamError && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/40">
          <div className="flex items-center gap-3">
            {isSingleWordSelection ? (
              <button
                onClick={handleSave}
                disabled={saved}
                className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-accent-text hover:opacity-70 disabled:opacity-50 disabled:cursor-default"
              >
                {saved ? <Check size={14} /> : <BookmarkPlus size={14} />}
                {saved ? t("lookup.saved") : t("lookup.saveToDict")}
              </button>
            ) : customAction ? null : (
              // Custom-action results never persist (their prompts can change
              // under an unchanged name — see plan O-3), so a passage selected
              // through one gets no save button rather than a dead one.
              <button
                onClick={handleSaveExplanation}
                disabled={!savedId || explanationSaved}
                className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-accent-text hover:opacity-70 disabled:opacity-50 disabled:cursor-default"
              >
                {explanationSaved ? <Check size={14} /> : <BookmarkPlus size={14} />}
                {explanationSaved ? t("explain.explanationSaved") : t("explain.saveExplanation")}
              </button>
            )}
            {onAskFollowUp && (
              <button
                onClick={() => {
                  const quote = [
                    `Text: ${text}`,
                    sentence ? `Context: ${sentence}` : "",
                    `Explanation: ${contentRef.current}`,
                  ].filter(Boolean).join("\n\n");
                  onAskFollowUp(quote, cfi, focusWordFor(text));
                  onClose();
                }}
                className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-text-secondary hover:text-accent-text"
              >
                <MessageSquareMore size={14} />
                {t("lookup.askFollowUp")}
              </button>
            )}
          </div>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-text-muted hover:opacity-70"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t("explain.copied") : t("explain.copy")}
          </button>
        </div>
      )}
    </div>
    </>
  );
}
