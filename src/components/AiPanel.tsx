import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Database, Sparkles, Send, Loader2, Plus, ChevronDown, ChevronUp, Trash2, X, Square } from "lucide-react";
import { useAiChat } from "../hooks/useAiChat";
import { usePinnedQuestionScroll } from "../hooks/usePinnedQuestionScroll";
import { timeAgo } from "../utils/timeAgo";
import MessageBubble from "./MessageBubble";
import type { AiChatScope, CitedSource, ContextKind, QuotedSource } from "../hooks/useAiChat";
import IndexManagerModal from "./IndexManagerModal";
import { useCoarsePointer } from "../hooks/useCoarsePointer";
import { isSendKey } from "./chat-input-keys";

interface AiPanelProps {
  bookId?: string;
  bookTitle?: string;
  bookAuthor?: string;
  currentChapter?: string;
  currentSectionIndex?: number;
  currentScopeStartIndex?: number;
  currentScopeEndIndex?: number;
  currentScopeAmbiguous?: boolean;
  getViewportText?: () => string | undefined;
  /** The reader's live selection, read when the composer is used. */
  getSelectionQuote?: () => { text: string; cfi?: string } | undefined;
  context?: { text: string; cfi?: string; analysis?: string; focusWord?: string };
  initialChatId?: string;
  onContextConsumed?: () => void;
  onNavigateToCfi?: (cfi: string) => void;
  onNavigateToSource?: (source: CitedSource) => void;
  onNavigateToQuote?: (quote: QuotedSource) => void;
  /** Answers are lookup surfaces too: double-click a word, or select a phrase. */
  onLookupWord?: (event: ReactMouseEvent<HTMLElement>) => void;
  onSelectText?: (event: ReactMouseEvent<HTMLElement>) => void;
}

const SCOPE_OPTIONS: AiChatScope[] = ["auto", "selection", "section", "book"];

/**
 * Answer-scope picker. Auto lets smart routing decide; a manual pick pins the
 * scope and skips guessing — a power feature that, as a bare row of chips, read
 * as four unlabelled mystery buttons. Collapsed to one control it says what it
 * sets, spells out each option, and gives the composer back a row.
 */
function ScopePicker({ scope, onChange }: { scope: AiChatScope; onChange: (scope: AiChatScope) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsidePress);
    return () => document.removeEventListener("mousedown", closeOnOutsidePress);
  }, [open]);

  const dismiss = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-0.5 rounded-full border py-[3px] pl-2.5 pr-1.5 text-[11px] font-medium cursor-pointer transition-colors ${
          // A pinned scope changes every answer, so it never looks like the default.
          scope === "auto"
            ? "border-border text-text-muted hover:bg-bg-input"
            : "border-accent/40 bg-accent-bg text-accent-text"
        }`}
      >
        {t("ai.scope.trigger", { scope: t(`ai.scope.${scope}`) })}
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("ai.scope.label")}
          className="absolute bottom-full right-0 z-50 mb-1.5 w-[250px] overflow-hidden rounded-[10px] border border-border bg-bg-surface shadow-popover"
        >
          {SCOPE_OPTIONS.map((option) => {
            const isActive = scope === option;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                onClick={() => {
                  onChange(option);
                  dismiss();
                }}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block text-[12px] font-medium ${isActive ? "text-accent-text" : "text-text-primary"}`}>
                    {t(`ai.scope.${option}`)}
                  </span>
                  <span className="block text-[11px] leading-[1.5] text-text-muted">
                    {t(`ai.scope.hint.${option}`)}
                  </span>
                </span>
                {isActive && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ComposerQuote {
  text: string;
  /** Absent means a book passage; "reply" quotes the assistant's own words. */
  kind?: ContextKind;
  cfi?: string;
  analysis?: string;
  /** Set when the quote came from a lookup on one word — see `focus-word.ts`.
   *  The whole card rides in `text`; this is the word to fetch examples for. */
  focusWord?: string;
}

function AiPanel({ bookId, bookTitle, bookAuthor, currentChapter, currentSectionIndex, currentScopeStartIndex, currentScopeEndIndex, currentScopeAmbiguous, getViewportText, getSelectionQuote, context, initialChatId, onContextConsumed, onNavigateToCfi, onNavigateToSource, onNavigateToQuote, onLookupWord, onSelectText }: AiPanelProps) {
  const { t } = useTranslation();
  const coarsePointer = useCoarsePointer();

  const SUGGESTED_PROMPTS = [
    t("ai.prompt.summarize"),
    t("ai.prompt.themes"),
    t("ai.prompt.characters"),
  ];
  const {
    messages, streaming, send, retryWithWholeBook, retryFailed, swapAlias, cancel, initialize,
    chatId, chats, titling, initializing, groundingStatus, summaryProgress, bookAiState,
    summariesAuto, spoilerGuardEnabled, setSpoilerGuardEnabled, prepareBookOverview, loadChat, deleteChat, renameChat, reset,
  } = useAiChat(bookId, {
    title: bookTitle,
    author: bookAuthor,
    chapter: currentChapter,
    sectionIndex: currentSectionIndex,
    scopeStartIndex: currentScopeStartIndex,
    scopeEndIndex: currentScopeEndIndex,
    scopeAmbiguous: currentScopeAmbiguous,
    getViewportText,
  });

  const [input, setInput] = useState("");
  // Manual scope chip. Sticky within this panel; switching books resets it
  // (chat switches reset it in their handlers — lazy chat creation on first
  // send must not clear a deliberate pick).
  const [scope, setScope] = useState<AiChatScope>("auto");
  useEffect(() => {
    setScope("auto");
  }, [bookId]);
  // Quotes stack: picking a second one adds to the first rather than replacing
  // it, so a reply and a passage can be asked about in the same question.
  const [pendingQuotes, setPendingQuotes] = useState<ComposerQuote[]>([]);
  // A passage selected in the reader, picked up when the composer is used. Kept
  // apart from pendingQuote (an explicit Quote action) so dismissing one never
  // swallows the other, and so a dismissal can be remembered per passage.
  const [autoQuote, setAutoQuote] = useState<ComposerQuote | undefined>();
  const dismissedSelectionRef = useRef<string | undefined>(undefined);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [newChatFlash, setNewChatFlash] = useState(false);
  const [indexOpen, setIndexOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const {
    scrollerRef: messagesScrollRef, listRef: messageListRef, questionAnchorRef,
    tailSpacerRef, lastQuestionIndex, pinLatestQuestion,
  } = usePinnedQuestionScroll(chatId, messages);

  const currentChat = chats.find((c) => c.id === chatId);

  // Initialize on mount / bookId change. Always loads the existing session
  // chat (or empty state when none) — Quote attaches to that chat rather than
  // starting a fresh one.
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Load specific chat when navigating from ChatsPage
  useEffect(() => {
    if (initialChatId && chats.length > 0) {
      loadChat(initialChatId);
    }
  }, [initialChatId, chats.length, loadChat]);

  // Focus title input when editing
  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  const readSelection = useCallback((): ComposerQuote | undefined => {
    const found = getSelectionQuote?.();
    if (!found || found.text === dismissedSelectionRef.current) return undefined;
    return found;
  }, [getSelectionQuote]);

  // Focusing the composer is the moment the reader turns a selection into a
  // question, so that is when the chip appears. Re-reading on every focus also
  // clears a chip whose selection has since gone away.
  const syncSelectionChip = useCallback(() => {
    setAutoQuote(readSelection());
  }, [readSelection]);

  const clearQuotes = () => {
    setPendingQuotes([]);
    setAutoQuote(undefined);
    dismissedSelectionRef.current = undefined;
  };

  const dismissQuote = (quote: ComposerQuote) => {
    if (quote !== autoQuote) {
      setPendingQuotes((current) => current.filter((item) => item !== quote));
      return;
    }
    // Remember which passage was waved off so refocusing does not resurrect it,
    // while a different selection still gets its own chip.
    dismissedSelectionRef.current = autoQuote?.text;
    setAutoQuote(undefined);
  };

  const addQuote = useCallback((quote: ComposerQuote) => {
    setPendingQuotes((current) => (
      current.some((item) => item.text === quote.text) ? current : [...current, quote]
    ));
  }, []);

  // Handle context from the "Quote" context-menu action — pin it as a pending
  // quote chip above the composer. Does NOT reset the chat or auto-send: the
  // quote attaches to the existing session conversation and rides along with
  // the user's next message.
  useEffect(() => {
    if (!context) return;
    addQuote(context);
    onContextConsumed?.();
  }, [addQuote, context, onContextConsumed]);

  // Quoting an answer is the start of a follow-up, so the composer takes focus.
  const quoteReply = useCallback((text: string) => {
    addQuote({ text, kind: "reply" });
    composerRef.current?.focus();
  }, [addQuote]);

  // Explicit quotes, plus the reader selection once the composer picked it up.
  const quoteChips = autoQuote && !pendingQuotes.some((quote) => quote.text === autoQuote.text)
    ? [...pendingQuotes, autoQuote]
    : pendingQuotes;

  // The live selection still counts at send time even when the composer was
  // skipped, which is how a suggested prompt carries it.
  const takeQuotes = (): ComposerQuote[] => {
    if (quoteChips.length > 0) return quoteChips;
    const selected = readSelection();
    return selected ? [selected] : [];
  };

  // Not `quotes[0]` — the lookup card is whichever chip carries a word, and a
  // reader can pin a passage before or after asking about the word.
  const takeFocusWord = (quotes: ComposerQuote[]) =>
    quotes.find((quote) => quote.focusWord)?.focusWord;

  const handleSend = () => {
    if (!input.trim() || streaming || initializing) return;
    pinLatestQuestion();
    const quotes = takeQuotes();
    send(input.trim(), quotes[0]?.text, quotes[0]?.cfi, quotes[0]?.analysis, {
      scope,
      contextKind: quotes[0]?.kind,
      contexts: quotes,
      focusWord: takeFocusWord(quotes),
    });
    clearQuotes();
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSendKey(e, coarsePointer)) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && quoteChips.length > 0) {
      e.preventDefault();
      dismissQuote(quoteChips[quoteChips.length - 1]);
    }
  };

  const handleTitleSubmit = () => {
    if (titleDraft.trim() && chatId) {
      renameChat(chatId, titleDraft.trim());
    }
    setEditingTitle(false);
  };

  const handleNewChat = () => {
    if (bookId) {
      reset(); // Clears state; DB record created lazily on first send
      setPickerOpen(false);
      setInput("");
      setScope("auto");
      setNewChatFlash(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setNewChatFlash(false));
      });
    }
  };

  const handleSelectChat = (id: string) => {
    loadChat(id);
    setPickerOpen(false);
    setScope("auto");
  };

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-[63px] border-b border-border shrink-0 relative">
        <div className="flex items-center gap-2.5 min-w-0">
          <Sparkles size={20} className="text-text-muted shrink-0" />
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleTitleSubmit();
                if (e.key === "Escape") setEditingTitle(false);
              }}
              className="text-[15px] font-semibold text-text-primary bg-transparent outline-none border-b border-accent w-full min-w-0"
            />
          ) : (
            <button
              onClick={() => setPickerOpen(!pickerOpen)}
              onDoubleClick={() => {
                if (titling) return;
                setTitleDraft(currentChat?.title || t("ai.newChat"));
                setEditingTitle(true);
              }}
              className="flex items-center gap-1.5 min-w-0 cursor-pointer"
            >
              {titling ? (
                <span className="flex items-center gap-1.5 text-[15px] font-semibold text-text-muted tracking-[-0.23px]">
                  <Loader2 size={14} className="animate-spin" />
                  {t("ai.generatingTitle")}
                </span>
              ) : (
                <span className="text-[15px] font-semibold text-text-primary tracking-[-0.23px] truncate">
                  {currentChat?.title || t("ai.newChat")}
                </span>
              )}
              {pickerOpen ? (
                <ChevronUp size={14} className="text-text-muted shrink-0" />
              ) : (
                <ChevronDown size={14} className="text-text-muted shrink-0" />
              )}
            </button>
          )}
        </div>
        <button
          type="button"
          aria-pressed={spoilerGuardEnabled}
          onClick={() => void setSpoilerGuardEnabled(!spoilerGuardEnabled)}
          disabled={!bookId}
          title={t(spoilerGuardEnabled ? "ai.spoilerGuard.bookOn" : "ai.spoilerGuard.bookOff")}
          aria-label={t(spoilerGuardEnabled ? "ai.spoilerGuard.bookOn" : "ai.spoilerGuard.bookOff")}
          className={`flex size-7 touch:size-11 shrink-0 items-center justify-center rounded-lg hover:bg-bg-input disabled:opacity-40 ${spoilerGuardEnabled ? "text-accent-text" : "text-text-muted"}`}
        >
          <BookOpen size={15} />
        </button>
        <button
          type="button"
          onClick={() => setIndexOpen(true)}
          disabled={!bookId}
          title={t("indexManager.title")}
          className="flex size-7 touch:size-11 shrink-0 items-center justify-center rounded-lg hover:bg-bg-input disabled:opacity-40"
        >
          <Database size={15} className="text-text-muted" />
        </button>
        <button
          onClick={handleNewChat}
          className="shrink-0 size-7 touch:size-11 rounded-lg flex items-center justify-center hover:bg-bg-input cursor-pointer"
        >
          <Plus size={16} className="text-text-muted" />
        </button>

        {/* Chat picker dropdown */}
        {pickerOpen && (
          <div className="absolute top-[62px] left-3 right-3 bg-bg-surface border border-border rounded-[10px] shadow-popover z-50 overflow-hidden">
            <div className="max-h-[300px] overflow-auto pt-1">
              {chats.map((chat) => {
                const isActive = chat.id === chatId;
                return (
                  <div
                    key={chat.id}
                    className={`group flex items-center gap-2 w-full px-3 py-2.5 border-l-2 ${
                      isActive ? "border-accent bg-bg-input" : "border-transparent hover:bg-bg-input"
                    }`}
                  >
                    <button
                      onClick={() => handleSelectChat(chat.id)}
                      className="flex-1 flex flex-col gap-0.5 text-left cursor-pointer min-w-0"
                    >
                      <span className={`text-[13px] tracking-[-0.08px] truncate ${
                        isActive ? "font-semibold text-text-primary" : "font-normal text-text-primary"
                      }`}>
                        {chat.title}
                      </span>
                      <span className="text-[11px] font-medium text-text-muted tracking-[0.06px]">
                        {timeAgo(chat.updated_at)}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteChat(chat.id);
                        if (chats.length <= 1) setPickerOpen(false);
                      }}
                      className="opacity-0 group-hover:opacity-100 touch:opacity-100 shrink-0 p-1 rounded hover:bg-bg-muted cursor-pointer transition-opacity"
                    >
                      <Trash2 size={13} className="text-text-muted" />
                    </button>
                  </div>
                );
              })}
              {chats.length === 0 && (
                <p className="px-3 py-3 text-[13px] text-text-muted">{t("ai.noChats")}</p>
              )}
            </div>
          </div>
        )}
      </div>
      {indexOpen && bookId && (
        <IndexManagerModal bookId={bookId} bookTitle={bookTitle} onClose={() => setIndexOpen(false)} />
      )}

      {/* Messages */}
      <div
        ref={messagesScrollRef}
        className="flex-1 overflow-auto px-3 py-4"
        onClick={() => pickerOpen && setPickerOpen(false)}
        onDoubleClick={onLookupWord}
        onMouseUp={onSelectText}
      >
        {messages.length === 0 ? (
          /* Empty state */
          <div className={`flex flex-col items-center justify-center h-full gap-3 transition-opacity duration-300 ${newChatFlash ? "opacity-0" : "opacity-100"}`}>
            <div className="size-14 rounded-full bg-bg-input flex items-center justify-center">
              <Sparkles size={28} className="text-text-muted" />
            </div>
            <h3 className="text-[16px] font-semibold text-text-primary tracking-[-0.31px]">
              {t("ai.startChat")}
            </h3>
            <p className="text-[13px] text-text-muted text-center tracking-[-0.08px] max-w-[215px]">
              {t("ai.startChatSub")}
            </p>
            <div className="flex flex-wrap justify-center gap-2 mt-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => {
                    if (initializing) return;
                    pinLatestQuestion();
                    const quotes = takeQuotes();
                    send(prompt, quotes[0]?.text, quotes[0]?.cfi, quotes[0]?.analysis, {
                      scope,
                      contextKind: quotes[0]?.kind,
                      contexts: quotes,
                      focusWord: takeFocusWord(quotes),
                    });
                    clearQuotes();
                  }}
                  disabled={initializing}
                  className="px-3 py-1.5 rounded-full text-[12px] font-medium text-accent-text bg-accent-bg border border-accent/30 hover:opacity-80 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                  {prompt}
                </button>
              ))}
            </div>
            {bookAiState && !bookAiState.hasSummaries && !summariesAuto && (
              <button
                type="button"
                onClick={() => void prepareBookOverview()}
                disabled={bookAiState.indexStatus !== "ready" || summaryProgress?.phase === "sections" || summaryProgress?.phase === "book"}
                className="mt-1 text-[12px] font-medium text-accent-text hover:opacity-75 disabled:cursor-default disabled:opacity-50"
              >
                {t("ai.prepareOverview")}
              </button>
            )}
          </div>
        ) : (
          <>
            <div ref={messageListRef} className="flex flex-col gap-3">
              {messages.map((msg, index) => (
                <div key={msg.id} ref={index === lastQuestionIndex ? questionAnchorRef : undefined}>
                  <MessageBubble msg={msg} messages={messages} streaming={streaming} onNavigateToCfi={onNavigateToCfi} onNavigateToSource={onNavigateToSource} onNavigateToQuote={onNavigateToQuote} onRetryWithWholeBook={retryWithWholeBook} onRetry={retryFailed} onQuoteReply={quoteReply} onSwapAlias={swapAlias} />
                </div>
              ))}
            </div>
            {/* Room for the answer to stream into without pushing the view. */}
            <div ref={tailSpacerRef} aria-hidden="true" />
          </>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 pt-[17px] pb-4 flex flex-col gap-2">
        {groundingStatus === "building" && (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            {t("ai.groundingPreparing")}
          </p>
        )}
        {summaryProgress && (summaryProgress.phase === "sections" || summaryProgress.phase === "book") && (
          <p role="status" className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <Loader2 size={12} className="animate-spin" />
            {t("ai.overviewPreparing", { done: summaryProgress.done, total: summaryProgress.total })}
          </p>
        )}
        {/* Quote chip — passage to attach to the next message, from an explicit
            Quote action or from whatever is selected in the reader */}
        {quoteChips.map((quote) => (
          <div
            key={`${quote.kind ?? "passage"}:${quote.text}`}
            className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-[rgba(192,132,252,0.12)] border-l-2 border-[#c084fc]"
          >
            <div className="flex-1 min-w-0">
              {quote.kind === "reply" && (
                <p className="text-[11px] font-medium text-text-muted tracking-[-0.08px]">
                  {t("aiPanel.quoteChip.replyLabel")}
                </p>
              )}
              <p className="text-[12px] italic text-text-muted line-clamp-2 tracking-[-0.08px]">
                {quote.text}
              </p>
            </div>
            <button
              onClick={() => dismissQuote(quote)}
              title={t("aiPanel.quoteChip.dismiss")}
              aria-label={t("aiPanel.quoteChip.dismiss")}
              className="shrink-0 size-[18px] flex items-center justify-center rounded hover:bg-bg-input cursor-pointer"
            >
              <X size={13} className="text-text-muted" />
            </button>
          </div>
        ))}
        <div className="flex gap-2 items-start">
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={syncSelectionChip}
            placeholder={t("ai.placeholder")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            rows={2}
            className="flex-1 h-[60px] bg-bg-input rounded-lg px-3 py-2 text-[14px] text-text-primary placeholder:text-text-placeholder tracking-[-0.15px] leading-5 outline-none border border-transparent focus:border-accent resize-none"
          />
          <button
            onClick={streaming ? cancel : handleSend}
            title={streaming ? t("ai.stop") : t("ai.send")}
            aria-label={streaming ? t("ai.stop") : t("ai.send")}
            disabled={!streaming && (!input.trim() || initializing)}
            className={`size-[60px] shrink-0 rounded-lg flex items-center justify-center cursor-pointer bg-accent text-white ${
              !streaming && (!input.trim() || initializing) ? "opacity-50" : ""
            }`}
          >
            {streaming ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="text-[12px] text-text-muted truncate">
            {t(coarsePointer ? "ai.sendHintTouch" : "ai.sendHint")}
          </p>
          <ScopePicker scope={scope} onChange={setScope} />
        </div>
      </div>
    </div>
  );
}

// The reader hides this behind a `hidden` class rather than unmounting it, so
// an unopened chat would otherwise re-render on every relocate.
export default memo(AiPanel);
