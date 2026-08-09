import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightFromLine, BookOpen, Loader2, MessageSquare, Search, Sparkles, Trash2 } from "lucide-react";
import Input from "../ui/Input";
import Select from "../ui/Select";
import { useOpenBook } from "../../hooks/useOpenBook";
import { type ChatSummary } from "../../hooks/useChats";
import { type Explanation } from "../../hooks/useExplanations";
import AiMarkdown from "../ai-markdown/AiMarkdown";
import { timeAgo } from "../../utils/timeAgo";
import { useQaTimeline } from "./useQaTimeline";
import { chatRounds, isMultiRoundChat, type QaEntry } from "./types";

// A chat thread is opened by explicit click, never on first paint of this
// tab — so the markdown renderer it pulls in for message bubbles waits
// until then too.
const ChatDetailView = lazy(() => import("../ChatDetailView"));

/**
 * The unified "问答" list — every saved explanation and every chat thread,
 * across every book, in one list sorted by recency. See
 * `docs/impls/home-ia-consolidation.md` step 7 and `useQaTimeline` for why
 * this can't just be two lists behind a tab: the records aren't
 * shape-compatible, so each row still dispatches on `entry.kind` to decide
 * what it renders and what clicking it does.
 */
export default function QaContent() {
  const { t, i18n } = useTranslation();
  const openInReader = useOpenBook();
  const [search, setSearch] = useState("");
  const [bookId, setBookId] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmingExplanationId, setConfirmingExplanationId] = useState<string | null>(null);
  const [confirmingChatId, setConfirmingChatId] = useState<string | null>(null);
  const [selectedChat, setSelectedChat] = useState<ChatSummary | null>(null);

  const {
    entries, total, bookOptions, hasMore, loadingMore,
    refresh, loadMore, removeChat, moveOutExplanation,
  } = useQaTimeline(search, bookId);

  // Mounting this panel *is* "the filter becoming active" — Home swaps it
  // in and out of the ternary rather than hiding it, so there is no
  // separate "became active" event to listen for. The 180ms debounce
  // mirrors AnnotationsContent so fast typing doesn't
  // fire a request per keystroke.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      refresh(search, bookId)
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, bookId]);

  // A save can happen in a reader window while this panel sits idle in the
  // background; window focus is the one signal every platform gives for
  // "the reader might come back and look." No cross-window push.
  useEffect(() => {
    const onFocus = () => { refresh(search, bookId).catch(() => {}); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, bookId]);

  const bookSelectOptions = useMemo(() => [
    { value: "", label: t("notes.filters.allBooks") },
    ...bookOptions
      .map((b) => ({ value: b.id, label: b.title || t("common.unknownBook") }))
      .sort((left, right) => left.label.localeCompare(right.label, i18n.language)),
  ], [bookOptions, i18n.language, t]);

  const filtersActive = Boolean(search.trim() || bookId);
  const isEmpty = entries.length === 0;

  const clearFilters = () => {
    setSearch("");
    setBookId("");
  };

  const moveOut = async (id: string) => {
    await moveOutExplanation(id);
    setConfirmingExplanationId(null);
  };

  const deleteChatEntry = async (id: string) => {
    await removeChat(id);
    setConfirmingChatId(null);
  };

  if (selectedChat) {
    return (
      <Suspense fallback={<div className="flex-1 bg-bg-muted" />}>
        <ChatDetailView
          chat={selectedChat}
          onBack={() => setSelectedChat(null)}
          onChatDeleted={(id) => {
            setSelectedChat(null);
            removeChat(id).catch(() => {});
          }}
        />
      </Suspense>
    );
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg-surface">
      <header className="relative shrink-0 border-b border-border px-page pb-5 pt-titlebar">
        <div data-tauri-drag-region className="absolute inset-x-0 top-0 h-titlebar" />
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold text-text-primary">{t("qa.title")}</h1>
            <p className="mt-1 text-[13px] text-text-muted">{t("qa.subtitle")}</p>
          </div>
          <span className="text-[12px] text-text-muted">{t("qa.count", { count: total })}</span>
        </div>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <Input
            icon={<Search size={16} />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("qa.searchPlaceholder")}
            className="w-full md:min-w-[280px] md:flex-1"
          />
          <Select className="w-full md:w-[180px]" value={bookId} onChange={setBookId} options={bookSelectOptions} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-page">
        {loading ? (
          <p className="text-[13px] text-text-muted">{t("home.loading")}</p>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-accent-bg text-accent-text">
              {filtersActive ? <Search size={22} /> : <MessageSquare size={22} />}
            </div>
            <p className="text-[14px] font-medium text-text-secondary">
              {filtersActive ? t("qa.noResult") : t("qa.empty")}
            </p>
            <p className="max-w-[380px] text-[12px] leading-[1.7] text-text-muted">
              {filtersActive ? t("qa.noResultHint") : t("qa.emptyHint")}
            </p>
            {filtersActive && (
              <button type="button" onClick={clearFilters} className="mt-1 h-8 rounded-md border border-border px-3 text-[12px] text-text-secondary hover:bg-bg-input">
                {t("annotations.clearFilters")}
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-[920px] divide-y divide-border-light">
            {entries.map((entry) => (
              <QaRow
                key={entry.id}
                entry={entry}
                expanded={expandedId === entry.id}
                onToggleExpand={() => setExpandedId((cur) => (cur === entry.id ? null : entry.id))}
                onOpenChat={(chat) => setSelectedChat(chat)}
                onJump={(target) => {
                  if (target.kind === "explanation") {
                    if (target.explanation.cfi !== "") openInReader(target.book_id, { cfi: target.explanation.cfi });
                  } else {
                    openInReader(target.book_id, { openChat: true, chatId: target.chat.id });
                  }
                }}
                confirmingExplanation={confirmingExplanationId === entry.id}
                onRequestMoveOut={() => setConfirmingExplanationId(entry.id)}
                onCancelMoveOut={() => setConfirmingExplanationId(null)}
                onConfirmMoveOut={() => moveOut(entry.id).catch(() => {})}
                confirmingChatDelete={confirmingChatId === entry.id}
                onRequestChatDelete={() => setConfirmingChatId(entry.id)}
                onCancelChatDelete={() => setConfirmingChatId(null)}
                onConfirmChatDelete={() => deleteChatEntry(entry.id).catch(() => {})}
              />
            ))}
            {hasMore && (
              <div className="flex justify-center py-5">
                <button type="button" disabled={loadingMore} onClick={() => loadMore(search, bookId).catch(() => {})} className="flex h-9 items-center gap-2 rounded-md border border-border px-3.5 text-[12px] text-text-muted hover:bg-bg-input disabled:opacity-50">
                  {loadingMore && <Loader2 size={14} className="animate-spin" />}
                  {t("annotations.loadMore")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

interface QaRowProps {
  entry: QaEntry;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenChat: (chat: ChatSummary) => void;
  onJump: (entry: QaEntry) => void;
  confirmingExplanation: boolean;
  onRequestMoveOut: () => void;
  onCancelMoveOut: () => void;
  onConfirmMoveOut: () => void;
  confirmingChatDelete: boolean;
  onRequestChatDelete: () => void;
  onCancelChatDelete: () => void;
  onConfirmChatDelete: () => void;
}

function QaRow({
  entry, expanded, onToggleExpand, onOpenChat, onJump,
  confirmingExplanation, onRequestMoveOut, onCancelMoveOut, onConfirmMoveOut,
  confirmingChatDelete, onRequestChatDelete, onCancelChatDelete, onConfirmChatDelete,
}: QaRowProps) {
  const { t } = useTranslation();

  const handleOpen = () => {
    if (entry.kind === "chat") onOpenChat(entry.chat);
    else onToggleExpand();
  };

  return (
    <article className="py-[18px] first:pt-0">
      <div className="flex items-start gap-3">
        {/* Not a <button>: the explanation body below can render block
            elements (<p>, <ul>), which HTML forbids as button descendants.
            role="button" gets the same affordance without invalid nesting. */}
        <div
          role="button"
          tabIndex={0}
          onClick={handleOpen}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleOpen();
            }
          }}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          {entry.kind === "explanation" ? (
            <ExplanationBody explanation={entry.explanation} expanded={expanded} />
          ) : (
            <ChatBody chat={entry.chat} />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {entry.kind === "explanation" ? (
            entry.explanation.cfi !== "" && (
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onJump(entry); }}
                title={t("qa.jumpBack")}
                aria-label={t("qa.jumpBack")}
                className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
              >
                <BookOpen size={14} />
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onJump(entry); }}
              title={t("chats.openInReader")}
              aria-label={t("chats.openInReader")}
              className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
            >
              <BookOpen size={14} />
            </button>
          )}
          {entry.kind === "explanation" ? (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onRequestMoveOut(); }}
              title={t("qa.moveOut")}
              aria-label={t("qa.moveOut")}
              className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
            >
              <ArrowRightFromLine size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onRequestChatDelete(); }}
              title={t("common.delete")}
              aria-label={t("common.delete")}
              className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-red-500"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {confirmingExplanation && (
        <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-border bg-bg-muted px-3 py-2.5">
          <ArrowRightFromLine size={14} className="mt-0.5 shrink-0 text-text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-text-primary">{t("qa.moveOutConfirm.title")}</p>
            <p className="mt-1 text-[11px] leading-[1.55] text-text-muted">{t("qa.moveOutConfirm.body")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 self-center">
            <button type="button" onClick={onCancelMoveOut} className="h-7 rounded-md border border-transparent px-2.5 text-[11px] text-text-muted hover:bg-bg-input">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={onConfirmMoveOut} className="h-7 rounded-md border border-border bg-bg-surface px-2.5 text-[11px] font-medium text-text-primary hover:bg-bg-input">
              {t("qa.moveOutConfirm.confirm")}
            </button>
          </div>
        </div>
      )}

      {confirmingChatDelete && (
        <div className="mt-2.5 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/40 dark:bg-red-950/20">
          <Trash2 size={14} className="mt-0.5 shrink-0 text-red-500" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-text-primary">{t("qa.deleteConfirm.title")}</p>
            <p className="mt-1 text-[11px] leading-[1.55] text-text-muted">{t("qa.deleteConfirm.body")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5 self-center">
            <button type="button" onClick={onCancelChatDelete} className="h-7 rounded-md border border-transparent px-2.5 text-[11px] text-text-muted hover:bg-bg-input">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={onConfirmChatDelete} className="h-7 rounded-md border border-red-300 bg-bg-surface px-2.5 text-[11px] font-medium text-red-600 hover:bg-red-100 dark:hover:bg-red-950/40">
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

function ExplanationBody({ explanation, expanded }: { explanation: Explanation; expanded: boolean }) {
  const { t } = useTranslation();
  const metaParts = [
    explanation.book_title || t("common.unknownBook"),
    explanation.chapter,
    timeAgo(explanation.updated_at),
  ].filter(Boolean);
  return (
    <>
      <div className="border-l-2 border-[#c084fc] pl-3">
        <p className="font-serif text-[12px] italic leading-[1.6] text-text-muted line-clamp-2">
          {explanation.passage}
        </p>
      </div>
      <AiMarkdown
        size="compact"
        className={`mt-2 text-[13px] leading-[1.7] text-text-secondary ${expanded ? "" : "line-clamp-3"}`}
      >
        {explanation.explanation}
      </AiMarkdown>
      <p className="mt-2.5 text-[11px] text-text-muted">{metaParts.join(" · ")}</p>
    </>
  );
}

function ChatBody({ chat }: { chat: ChatSummary }) {
  const { t } = useTranslation();
  const metaParts = [chat.book_title || t("common.unknownBook"), timeAgo(chat.updated_at)].filter(Boolean);
  const preview = chat.last_message
    ? `${chat.last_message.substring(0, 140)}${chat.last_message.length > 140 ? "…" : ""}`
    : t("chats.noMessages");
  return (
    <>
      <div className="flex items-center gap-1.5">
        <Sparkles size={12} className="shrink-0 text-accent-text" />
        <p className="truncate text-[14px] font-semibold leading-5 tracking-[-0.08px] text-text-primary">
          {chat.title}
        </p>
      </div>
      <p className="mt-1.5 text-[13px] leading-[1.7] text-text-secondary line-clamp-2">{preview}</p>
      {isMultiRoundChat(chat) && (
        <p className="mt-1.5 text-[11px] font-medium text-accent-text">
          {t("qa.continuedRounds", { count: chatRounds(chat) })}
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-text-muted">{metaParts.join(" · ")}</p>
    </>
  );
}
