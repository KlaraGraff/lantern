import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { platform } from "../services/platform";
import {
  X,
  Loader2,
  Languages,
  BookmarkPlus,
  Check,
  Copy,
  ChevronDown,
  ChevronUp,
  Settings,
  MessageSquareMore,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePopoverPosition } from "./use-popover-position";
import { aiErrorMessageKey, getAiErrorCode, isAiRetryableError, isAiSettingsError, type AiErrorCode } from "../utils/aiError";
import AiRetryButton from "./AiRetryButton";
import { createUuid } from "../utils/randomUuid";
import { notifyReaders } from "../utils/notifyReaders";
import { saveVocabWord } from "./vocab/collect";
import { focusWordFor } from "./focus-word";
import BottomSheet from "./ui/BottomSheet";
import { useCoarsePointer } from "../hooks/useCoarsePointer";
import { copyToClipboard } from "../utils/clipboard";

interface TranslationPopoverProps {
  x: number;
  y: number;
  text: string;
  context?: string;
  /**
   * Omitted when the passage is not in a book — the quiz paper. The translation
   * itself never needed one (the backend ignores the argument), so what stands
   * down is only the save button: filing a paragraph under no book is the word
   * menu's 收藏 row's job, and it is the one that carries the quiz provenance.
   */
  bookId?: string;
  bookTitle?: string;
  bookAuthor?: string;
  chapter?: string;
  cfi?: string;
  onClose: () => void;
  onAskFollowUp?: (quote: string, cfi?: string, focusWord?: string) => void;
}

interface AiStreamChunk {
  delta: string;
  done: boolean;
  error?: string;
}

const LANG_NAMES: Record<string, string> = {
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  ru: "Russian",
  ar: "Arabic",
  it: "Italian",
};

function useStreamingTranslation(
  text: string,
  context: string | undefined,
  bookId: string | undefined,
  bookTitle: string | undefined,
  bookAuthor: string | undefined,
  chapter: string | undefined,
  cfi: string | undefined
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [aiError, setAiError] = useState<AiErrorCode | null>(null);
  const [languageNotConfigured, setLanguageNotConfigured] = useState(false);
  const [targetLang, setTargetLang] = useState("");
  const [streamError, setStreamError] = useState(false);
  // Bumped by the retry button. Re-running the effect is the retry: the
  // listener, request id and cleanup all have to be set up again anyway.
  const [attempt, setAttempt] = useState(0);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    contentRef.current = "";
    setContent("");
    setStreaming(true);
    setAiError(null);
    setLanguageNotConfigured(false);
    setTargetLang("");
    setStreamError(false);

    // Fetch target language for display
    invoke<Record<string, string>>("get_all_settings").then((s) => {
      if (cancelled) return;
      const lang = s.translation_language || s.language || "en";
      setTargetLang(lang);
    }).catch(() => {});

    const run = async () => {
      const requestId = createUuid();
      requestIdRef.current = requestId;

      unlistenRef.current = await listen<AiStreamChunk>(
        `ai-translate-chunk-${requestId}`,
        (event) => {
          if (cancelled) return;
          if (event.payload.done) {
            if (event.payload.error) {
              const errorCode = getAiErrorCode(event.payload.error);
              if (isAiSettingsError(errorCode)) setAiError(errorCode);
              else setStreamError(true);
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
        await invoke("ai_translate_passage", {
          text,
          context: context || null,
          // The command takes a plain string and does not read it; an empty one
          // is the honest spelling of "this passage is not in a book".
          bookId: bookId ?? "",
          bookTitle: bookTitle || null,
          bookAuthor: bookAuthor || null,
          chapter: chapter || null,
          targetLanguage: null,
          requestId,
          retry: attempt > 0,
        });
      } catch (err) {
        if (!cancelled) {
          const msg = String(err);
          const errorCode = getAiErrorCode(msg);
          if (isAiSettingsError(errorCode)) {
            setAiError(errorCode);
          } else if (msg.includes("TRANSLATION_LANGUAGE_NOT_CONFIGURED")) {
            setLanguageNotConfigured(true);
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
  }, [text, context, bookAuthor, bookId, bookTitle, cfi, chapter, attempt]);

  return {
    content,
    contentRef,
    streaming,
    aiError,
    languageNotConfigured,
    targetLang,
    streamError,
    retry: () => setAttempt((count) => count + 1),
  };
}

export default function TranslationPopover({
  x,
  y,
  text,
  context,
  bookId,
  bookTitle,
  bookAuthor,
  chapter,
  cfi,
  onClose,
  onAskFollowUp,
}: TranslationPopoverProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { ref: floatingRef, style: floatingStyle, className: motionClass, isOutside } = usePopoverPosition(x, y);
  // Same device-driven fork as `ExplainPopover` / `Select` — a coarse pointer
  // gets the bottom sheet, a fine pointer keeps this exact floating popover.
  const isTouch = useCoarsePointer();

  const { content, contentRef, streaming, aiError, languageNotConfigured, targetLang, streamError, retry } =
    useStreamingTranslation(text, context, bookId, bookTitle, bookAuthor, chapter, cfi);

  const allDone = !streaming;
  const hasContent = !!content;
  const hasConfigurationError = aiError !== null || languageNotConfigured;


  // Check if this text is already saved to the vocab list
  useEffect(() => {
    if (!bookId) return;
    invoke<string | null>("check_vocab_exists", { bookId, word: text }).then((id) => {
      if (id) setSaved(true);
    }).catch(() => {});
  }, [bookId, text]);

  const handleSave = async () => {
    if (!bookId) return;
    try {
      // A short selection's translation *is* the gloss and is stored as-is; a
      // paragraph's translation is not, and gets a real gloss instead while
      // the full text goes to `context_explanation`.
      await saveVocabWord({
        bookId,
        word: text,
        gloss: contentRef.current,
        contextSentence: context || null,
        contextExplanation: contentRef.current || null,
        cfi: cfi || null,
      });
      setSaved(true);
      notifyReaders("vocab-changed", { bookId, cfi: cfi || undefined });
    } catch (err) {
      console.error("Failed to save vocab word:", err);
    }
  };

  const handleCopy = async () => {
    if (!await copyToClipboard(contentRef.current)) return;
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

  // Dismiss on click outside
  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (isOutside(e.target as Node)) {
        onClose();
      }
    };
    const id = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", handler);
    });
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("pointerdown", handler);
    };
  }, [onClose, isOutside]);

  const langName = LANG_NAMES[targetLang] || targetLang;

  // Original-text disclosure, not-configured state, and the
  // streaming/loading/error/content switch. Identical markup under either
  // presentation — see the matching comment in `ExplainPopover`.
  const translationBody = (
    <>
      <div className="relative pt-3 pb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="absolute top-3 right-0 size-6 flex items-center justify-center rounded hover:bg-bg-muted cursor-pointer touch:size-11"
        >
          {expanded ? (
            <ChevronUp size={14} className="text-text-muted" />
          ) : (
            <ChevronDown size={14} className="text-text-muted" />
          )}
        </button>
        {expanded ? (
          <div className="pr-7 max-h-[120px] overflow-auto">
            <p className="text-[13px] text-text-muted italic leading-[1.55]">
              {text}
            </p>
          </div>
        ) : (
          <p className="text-[13px] text-text-muted italic leading-[1.55] line-clamp-2 pr-7">
            {text}
          </p>
        )}
      </div>

      <div className="h-px bg-border/60 mb-3" />

      {/* Not configured state */}
      {hasConfigurationError ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <p className="text-[13px] text-text-muted">
            {languageNotConfigured
              ? t("translation.languageNotConfigured")
              : aiError ? t(aiErrorMessageKey(aiError)) : null}
          </p>
          <button
            onClick={async () => {
              onClose();
              await invoke("open_settings_on_main", { section: languageNotConfigured ? "tools" : "services" });
              // Single-window platforms are already in the window that just
              // opened — see the same guard in ExplainPopover / notifyReaders.
              if (!platform.hasWindow) return;
              const main = await WebviewWindow.getByLabel("main");
              await main?.setFocus();
            }}
            className="flex items-center gap-1.5 text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer touch:min-h-11 touch:text-[14px]"
          >
            <Settings size={14} />
            {languageNotConfigured ? t("translation.openSettings") : t("ai.openSettings")}
          </button>
          {isAiRetryableError(aiError) && <AiRetryButton onClick={retry} />}
        </div>
      ) : null}

      {/* Translation body */}
      {!hasConfigurationError && !streamError &&
        (streaming && !content ? (
          <div className="flex items-center gap-1.5 py-1">
            <Loader2 size={14} className="animate-spin text-text-muted" />
            <span className="text-[13px] text-text-muted">
              {t("translation.translating")}
            </span>
          </div>
        ) : (
          <p className="text-[13px] text-text-primary leading-[1.55]">
            {content}
            {streaming && (
              <Loader2
                size={12}
                className="inline-block ml-0.5 animate-spin text-text-muted"
              />
            )}
          </p>
        ))}
      {!hasConfigurationError && streamError && (
        <div className="flex flex-col items-center gap-2 py-3 text-center">
          <p className="text-[13px] text-text-muted">{t("ai.requestFailed")}</p>
          <AiRetryButton onClick={retry} />
        </div>
      )}
    </>
  );

  // Save / Ask Follow Up / Copy — same three actions, touch-sized targets.
  const translationFooter = allDone && hasContent && !hasConfigurationError && !streamError && (
    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/40 touch:flex-wrap touch:gap-y-2">
      <div className="flex items-center gap-3 touch:flex-wrap touch:gap-y-2">
        {/* No book, no place to save it back to — the quiz paper's own menu
            carries the save row instead, with the paper as provenance. */}
        {bookId && (
          <button
            onClick={handleSave}
            disabled={saved}
            className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-accent-text hover:opacity-70 disabled:opacity-50 disabled:cursor-default touch:min-h-11 touch:text-[14px]"
          >
            {saved ? <Check size={14} /> : <BookmarkPlus size={14} />}
            {saved ? t("lookup.saved") : t("lookup.saveToDict")}
          </button>
        )}
        {onAskFollowUp && (
          <button
            onClick={() => {
              const quote = [
                `Text: ${text}`,
                context ? `Context: ${context}` : "",
                `Translation: ${contentRef.current}`,
              ].filter(Boolean).join("\n\n");
              onAskFollowUp(quote, cfi, focusWordFor(text));
              onClose();
            }}
            className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-text-secondary hover:text-accent-text touch:min-h-11 touch:text-[14px]"
          >
            <MessageSquareMore size={14} />
            {t("lookup.askFollowUp")}
          </button>
        )}
      </div>
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-text-muted hover:opacity-70 touch:min-h-11 touch:text-[14px]"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? t("translation.copied") : t("translation.copy")}
      </button>
    </div>
  );

  // Coarse pointer: full-width bottom sheet, same reasoning as
  // `ExplainPopover` — `BottomSheet` owns the scroll and the 80vh cap, the
  // header stays pinned so close is reachable while translation streams in.
  if (isTouch) {
    return (
      <BottomSheet open onClose={onClose}>
        <div className="sticky top-0 z-10 flex items-center justify-between bg-accent-bg px-4 py-3 border-b border-border/40">
          <div className="flex items-center gap-2">
            <Languages size={16} className="text-accent-text" />
            <span className="text-[15px] font-medium text-accent-text tracking-[-0.15px]">
              {t("translation.title")}
            </span>
            {langName && (
              <span className="text-[13px] text-accent-text/60">{langName}</span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex size-11 items-center justify-center rounded-full hover:bg-bg-surface/60 cursor-pointer"
          >
            <X size={16} className="text-text-muted" />
          </button>
        </div>

        <div className="px-4 pb-2">{translationBody}</div>

        {translationFooter}
      </BottomSheet>
    );
  }

  // `max-w-[calc(100vw-32px)]` below is a safety floor for a fine-pointer
  // window narrowed below 520px (a mouse-driven desktop window, not a
  // phone — those take the branch above). Every other class on this box is
  // unchanged from before `isTouch` existed.
  return (
    <>
    <div className="fixed inset-0 z-40" onClick={onClose} />
    <div
      ref={floatingRef}
      className={`${motionClass} fixed z-[62] w-[520px] max-w-[calc(100vw-32px)] bg-bg-surface border border-border/80 rounded-xl shadow-context`}
      style={floatingStyle}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2.5 bg-accent-bg rounded-t-xl border-b border-border/40">
        <div className="flex items-center gap-2">
          <Languages size={16} className="text-accent-text" />
          <span className="text-[14px] font-medium text-accent-text tracking-[-0.15px]">
            {t("translation.title")}
          </span>
          {langName && (
            <span className="text-[13px] text-accent-text/60">{langName}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded hover:bg-bg-surface/60 cursor-pointer"
        >
          <X size={14} className="text-text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pb-2 max-h-[420px] overflow-auto">{translationBody}</div>

      {/* Footer — Save, Ask Follow Up, Copy */}
      {translationFooter}
    </div>
    </>
  );
}
