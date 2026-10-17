import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Bookmark, MessageCircleQuestion } from "lucide-react";
import { useDictionary } from "../hooks/useDictionary";
import { useHighlights } from "../hooks/useBookmarks";
import { loadReaderNotes } from "../pages/reader/load-reader-notes";
import { loadFoliateModules, type CfiModule } from "../pages/reader/foliate-modules";
import {
  cfiSectionIndex,
  chapterQuestions,
  inChapter,
  type ChapterQuestion,
  type ChatMessageRow,
  type ChapterScope,
} from "../pages/reader/chapter-traces";
import { mergeMarkRows, sortMarkRows, type CompareLocation, type MarkRow, type ReaderNote } from "./reader-mark-rows";
import { savedHighlightColor } from "./mark-palette";
import type { TracesTab } from "../pages/reader/side-panel";

/** How many of the book's chats are read for questions — the most recent ones. */
const QUESTION_CHAT_LIMIT = 40;

interface ChatRow {
  id: string;
  updated_at: number;
}

interface ReaderChapterPanelProps {
  bookId: string;
  chapterTitle?: string;
  scope: ChapterScope;
  onNavigate: (cfi: string) => void;
  onOpenChat: (chatId: string) => void;
  /** The whole-book lists, which used to be this card's tabs. */
  onShowWholeBook: (tab: Exclude<TracesTab, "chapter">) => void;
}

/**
 * 「本章」: what the reader left in this chapter (`chapter-traces.ts`), in the
 * order the design gives — words, highlights and notes, questions asked. Every
 * row goes back to where it was made. People so far are not here yet: nothing
 * stores where a person first appears, so there is no spoiler-safe list to
 * show without a new backend index.
 */
export default function ReaderChapterPanel({
  bookId,
  chapterTitle,
  scope,
  onNavigate,
  onOpenChat,
  onShowWholeBook,
}: ReaderChapterPanelProps) {
  const { t } = useTranslation();
  const { words } = useDictionary(bookId);
  const { highlights } = useHighlights(bookId);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [cfiModule, setCfiModule] = useState<CfiModule | null>(null);

  useEffect(() => {
    let controller = new AbortController();
    const load = () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      loadReaderNotes<ReaderNote>(bookId, null, signal)
        .then((result) => { if (result && !signal.aborted) setNotes(result); })
        .catch(() => {});
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (!detail?.bookId || detail.bookId === bookId) load();
    };
    window.addEventListener("note-changed", changed);
    load();
    return () => {
      controller.abort();
      window.removeEventListener("note-changed", changed);
    };
  }, [bookId]);

  // There is no per-book message query: one read per chat, newest chats first
  // and capped, while the card is open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const chats = await invoke<ChatRow[]>("list_chats", { bookId });
      const recent = [...chats].sort((left, right) => right.updated_at - left.updated_at).slice(0, QUESTION_CHAT_LIMIT);
      const pages = await Promise.all(recent.map((chat) => (
        invoke<ChatMessageRow[]>("list_chat_messages", { chatId: chat.id }).catch(() => [])
      )));
      if (!cancelled) setMessages(pages.flat());
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [bookId]);

  useEffect(() => {
    let cancelled = false;
    loadFoliateModules()
      .then((modules) => { if (!cancelled) setCfiModule(modules.epubcfi); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const compareLocation = useCallback<CompareLocation>((left, right) => {
    if (!cfiModule) return null;
    try {
      return cfiModule.compare(left, right);
    } catch {
      return null;
    }
  }, [cfiModule]);

  const chapterWords = useMemo(() => words
    .filter((word) => inChapter(cfiSectionIndex(word.cfi), scope))
    .sort((left, right) => (left.cfi && right.cfi ? compareLocation(left.cfi, right.cfi) : null) ?? left.created_at - right.created_at),
  [words, scope, compareLocation]);

  const chapterMarks = useMemo(() => sortMarkRows(
    mergeMarkRows(highlights, notes, []).filter((row) => inChapter(cfiSectionIndex(row.location), scope)),
    compareLocation,
  ), [highlights, notes, scope, compareLocation]);

  const questions = useMemo(() => chapterQuestions(messages, scope), [messages, scope]);
  const empty = chapterWords.length === 0 && chapterMarks.length === 0 && questions.length === 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex-1 px-4 py-3">
        {chapterTitle && (
          <p className="mb-3 truncate text-[12px] text-text-muted">{chapterTitle}</p>
        )}
        {empty && (
          <p className="py-6 text-[13px] leading-6 text-text-muted">{t("reader.chapter.empty")}</p>
        )}
        {chapterWords.length > 0 && (
          <Section title={t("reader.chapter.words")} count={chapterWords.length}>
            <div className="flex flex-wrap gap-1.5">
              {chapterWords.map((word) => (
                <button
                  key={word.id}
                  type="button"
                  title={word.definition}
                  onClick={() => word.cfi && onNavigate(word.cfi)}
                  className="cursor-pointer rounded-full border border-border bg-bg-surface px-2.5 py-1 text-[13px] text-text-primary transition-colors hover:border-accent/40 hover:bg-accent-bg"
                >
                  {word.word}
                </button>
              ))}
            </div>
          </Section>
        )}
        {chapterMarks.length > 0 && (
          <Section title={t("reader.chapter.marks")} count={chapterMarks.length}>
            <ul className="flex flex-col gap-1">
              {chapterMarks.map((row) => (
                <li key={row.key}>
                  <MarkButton row={row} bookmarkLabel={t("reader.chapter.bookmark")} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          </Section>
        )}
        {questions.length > 0 && (
          <Section title={t("reader.chapter.questions")} count={questions.length}>
            <ul className="flex flex-col gap-1">
              {questions.map((question) => (
                <li key={question.id}>
                  <QuestionButton question={question} onOpenChat={onOpenChat} />
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-[12px] text-text-muted">
        <span>{t("reader.chapter.wholeBook")}</span>
        {(["notes", "vocab", "xray"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => onShowWholeBook(tab)}
            className="cursor-pointer text-text-secondary underline-offset-2 hover:text-text-primary hover:underline"
          >
            {t(`reader.traces.tab.${tab}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 flex items-baseline gap-1.5 text-[12px] font-semibold text-text-secondary">
        {title}
        <span className="font-normal text-text-muted">{count}</span>
      </h3>
      {children}
    </section>
  );
}

const rowClass = "flex w-full cursor-pointer gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-bg-surface";

function MarkButton({ row, bookmarkLabel, onNavigate }: { row: MarkRow; bookmarkLabel: string; onNavigate: (cfi: string) => void }) {
  if (row.kind === "auto") return null;
  const quote = row.kind === "highlight" ? row.highlight.text_content : row.kind === "passage" ? row.note.selected_text : null;
  const body = row.kind === "highlight" ? row.note?.content : row.note.content;
  return (
    <button type="button" className={rowClass} onClick={() => row.location && onNavigate(row.location)}>
      {row.kind === "position" ? (
        <Bookmark size={13} className="mt-1 shrink-0 text-accent" />
      ) : (
        <span
          aria-hidden
          className="mt-0.5 w-[3px] shrink-0 self-stretch rounded-full"
          style={{ backgroundColor: row.kind === "highlight" ? savedHighlightColor[row.highlight.color] ?? savedHighlightColor.yellow : "var(--color-border)" }}
        />
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        {quote ? (
          <span className="line-clamp-2 text-[12.5px] leading-5 text-text-primary">&ldquo;{quote}&rdquo;</span>
        ) : row.kind === "position" && !body?.trim() ? (
          <span className="text-[12.5px] leading-5 text-text-secondary">{bookmarkLabel}</span>
        ) : null}
        {body?.trim() && (
          <span className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-secondary">{body}</span>
        )}
      </span>
    </button>
  );
}

function QuestionButton({ question, onOpenChat }: { question: ChapterQuestion; onOpenChat: (chatId: string) => void }) {
  return (
    <button type="button" className={rowClass} onClick={() => onOpenChat(question.chatId)}>
      <MessageCircleQuestion size={13} className="mt-1 shrink-0 text-text-muted" />
      <span className="line-clamp-2 text-[12.5px] leading-5 text-text-primary">{question.text}</span>
    </button>
  );
}
