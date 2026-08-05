import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { X, Loader2, WandSparkles, BookmarkPlus, Check, Copy, Settings, MessageSquareMore, BookOpenCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import { LOOKUP_PROSE } from "./lookup-prose";
import { aiErrorMessageKey, getAiErrorCode, isAiRetryableError, isAiSettingsError, type AiErrorCode } from "../utils/aiError";
import AiRetryButton from "./AiRetryButton";
import { createUuid } from "../utils/randomUuid";
import { notifyReaders } from "../utils/notifyReaders";

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
  onAskFollowUp?: (quote: string, cfi?: string) => void;
}

interface AiStreamChunk {
  delta: string;
  done: boolean;
  error?: string;
}

function useExplainStream(
  passage: string,
  surrounding: string | undefined,
  bookTitle: string | undefined,
  bookAuthor: string | undefined,
  chapter: string | undefined,
  customAction?: { name: string; prompt: string },
) {
  const contentRef = useRef("");
  const [content, setContent] = useState("");
  const [streaming, setStreaming] = useState(true);
  const [aiError, setAiError] = useState<AiErrorCode | null>(null);
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
    setStreamError(false);

    const run = async () => {
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
  }, [passage, surrounding, bookAuthor, bookTitle, chapter, customAction, attempt]);

  return {
    content,
    contentRef,
    streaming,
    aiError,
    streamError,
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
  const popoverRef = useRef<HTMLDivElement>(null);
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

  const { content, contentRef, streaming, aiError, streamError, retry } = useExplainStream(
    text,
    sentence,
    bookTitle,
    bookAuthor,
    chapter,
    customAction,
  );

  // Position clamping — re-run whenever the popover resizes (e.g. as content streams in)
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const clamp = () => {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x;
      let top = y;
      if (left + rect.width > vw - 16) left = vw - rect.width - 16;
      if (left < 16) left = 16;
      if (top + rect.height > vh - 16) top = y - rect.height - 8;
      if (top < 16) top = 16;
      setPos({ left, top });
    };
    const observer = new ResizeObserver(clamp);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check if this text is already saved to the vocab list
  useEffect(() => {
    invoke<string | null>("check_vocab_exists", { bookId, word: text }).then((id) => {
      if (id) setSaved(true);
    }).catch(() => {});
  }, [bookId, text]);

  const handleSave = async () => {
    try {
      await invoke("add_vocab_word", {
        bookId,
        word: text,
        definition: contentRef.current,
        contextSentence: sentence || null,
        contextExplanation: null,
        cfi: cfi || null,
      });
      setSaved(true);
      notifyReaders("vocab-changed", { bookId, cfi: cfi || undefined });
    } catch (err) {
      console.error("Failed to save vocab word:", err);
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
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
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
  }, [onClose]);

  return (
    <>
    <div className="fixed inset-0 z-40" onClick={onClose} />
    <div
      ref={popoverRef}
      className="fixed z-[62] w-[440px] bg-bg-surface border border-border/80 rounded-xl shadow-context"
      style={{ left: pos.left, top: pos.top }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2.5 bg-accent-bg rounded-t-xl border-b border-border/40">
        <div className="flex items-center gap-2">
          <WandSparkles size={16} className="text-accent-text" />
          <span className="text-[14px] font-medium text-accent-text tracking-[-0.15px]">
            {customAction?.name ?? t("explain.title")}
          </span>
        </div>
        <button
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded hover:bg-bg-surface/60 cursor-pointer"
        >
          <X size={14} className="text-text-muted" />
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pb-2 max-h-[360px] overflow-auto">
        {/* Selected passage */}
        <div className="border-l-2 border-[#c084fc] pl-3 pt-3 pb-1">
          <p className="text-[12px] italic text-text-muted line-clamp-3">{text}</p>
        </div>

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
          <div className={`${LOOKUP_PROSE} text-[13px] text-text-primary pt-2.5`}>
            <Markdown>{content}</Markdown>
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
            <button
              onClick={handleSave}
              disabled={saved}
              className="flex items-center gap-1.5 text-[13px] font-medium cursor-pointer text-accent-text hover:opacity-70 disabled:opacity-50 disabled:cursor-default"
            >
              {saved ? <Check size={14} /> : <BookmarkPlus size={14} />}
              {saved ? t("lookup.saved") : t("lookup.saveToDict")}
            </button>
            {onAskFollowUp && (
              <button
                onClick={() => {
                  const quote = [
                    `Text: ${text}`,
                    sentence ? `Context: ${sentence}` : "",
                    `Explanation: ${contentRef.current}`,
                  ].filter(Boolean).join("\n\n");
                  onAskFollowUp(quote, cfi);
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
