import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Languages,
  Search,
  BookOpen,
  Clock,
  FileText,
  Trash2,
  LayoutGrid,
  List,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Download,
  GraduationCap,
  CheckCircle2,
  History,
} from "lucide-react";
import Button from "./ui/Button";
import { useAllDictionary, useAllLookupHistory, type DictionaryWord } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";
import VocabDetailModal from "./VocabDetailModal";
import { openReaderWindow } from "../utils/openReaderWindow";

type SortMode = "newest" | "oldest" | "az";
type ViewMode = "list" | "card";
type ContentTab = "vocab" | "history";

export default function DictionaryContent() {
  const { t } = useTranslation();
  const { words, remove, updateMastery } = useAllDictionary();
  const { records } = useAllLookupHistory();
  const [sort, setSort] = useState<SortMode>("newest");
  const [view, setView] = useState<ViewMode>("list");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [activeWord, setActiveWord] = useState<DictionaryWord | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>("vocab");
  const [now, setNow] = useState(0);

  useEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const dueWords = useMemo(() => words.filter((word) => word.next_review_at !== null && word.next_review_at <= now), [now, words]);

  const filtered = useMemo(() => {
    let result = words;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((w) => w.word.toLowerCase().startsWith(q));
    }
    if (bookFilter) {
      result = result.filter((w) => w.book_id === bookFilter);
    }
    if (reviewOnly) {
      result = result.filter((w) => w.next_review_at !== null && w.next_review_at <= now);
    }
    return result;
  }, [words, search, bookFilter, reviewOnly, now]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sort === "oldest") {
      copy.sort((a, b) => a.created_at - b.created_at);
    } else if (sort === "az") {
      copy.sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: "base" }));
    }
    return copy;
  }, [filtered, sort]);

  const groupedByBook = useMemo(() => {
    const map = new Map<string, { title: string; words: DictionaryWord[] }>();
    for (const w of sorted) {
      if (!map.has(w.book_id)) {
        map.set(w.book_id, { title: w.book_title || t("common.unknownBook"), words: [] });
      }
      map.get(w.book_id)!.words.push(w);
    }
    return Array.from(map.entries()).map(([id, group]) => ({ id, ...group }));
  }, [sorted, t]);

  const groupedByLetter = useMemo(() => {
    const map = new Map<string, DictionaryWord[]>();
    for (const w of sorted) {
      const letter = w.word[0]?.toUpperCase() || "#";
      if (!map.has(letter)) map.set(letter, []);
      map.get(letter)!.push(w);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [sorted]);

  const bookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const w of words) {
      if (!map.has(w.book_id)) {
        map.set(w.book_id, { title: w.book_title || t("common.unknownBook"), count: 0 });
      }
      map.get(w.book_id)!.count++;
    }
    return Array.from(map.entries()).map(([id, { title, count }]) => ({ id, title, count }));
  }, [words, t]);

  const isEmpty = words.length === 0;
  const filteredRecords = useMemo(() => records.filter((record) => {
    const query = search.toLowerCase().trim();
    if (query && ![record.lookup_text, record.definition, record.context_sentence, record.book_title]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(query))) return false;
    return !bookFilter || record.book_id === bookFilter;
  }), [bookFilter, records, search]);
  const historyBookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const record of records) {
      const current = map.get(record.book_id) ?? { title: record.book_title || t("common.unknownBook"), count: 0 };
      current.count++;
      map.set(record.book_id, current);
    }
    return Array.from(map.entries()).map(([id, value]) => ({ id, ...value }));
  }, [records, t]);

  const scheduleLearning = (word: DictionaryWord) => updateMastery(word.id, "learning", now + 24 * 60 * 60 * 1000);
  const markMastered = (word: DictionaryWord) => updateMastery(word.id, "mastered", null);
  const exportCsv = () => {
    const escape = (value: string | null | undefined) => `"${(value ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["word", "definition", "context", "book", "mastery", "reviews", "next_review_at"].map(escape).join(","),
      ...words.map((word) => [word.word, word.definition, word.context_sentence, word.book_title, word.mastery, String(word.review_count), word.next_review_at ? new Date(word.next_review_at).toISOString() : ""].map(escape).join(",")),
    ];
    const href = URL.createObjectURL(new Blob([`\uFEFF${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = "quill-vocabulary.csv";
    link.click();
    URL.revokeObjectURL(href);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-page pb-2 relative select-none">
        <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-11" />
        <div className="pt-11 flex items-center justify-between mb-6">
          <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
            {contentTab === "vocab" ? t("vocab.title") : t("vocab.history")}
          </h1>
          <div className="flex items-center gap-0">
            <button
              type="button"
              title={t("vocab.export")}
              aria-label={t("vocab.export")}
              onClick={exportCsv}
              className="size-9 flex items-center justify-center rounded-lg text-text-muted hover:bg-bg-input cursor-pointer"
            >
              <Download size={16} />
            </button>
            <Button variant="icon" size="md" active={view === "card"} onClick={() => setView("card")}>
              <LayoutGrid size={16} />
            </Button>
            <Button variant="icon" size="md" active={view === "list"} onClick={() => setView("list")}>
              <List size={16} />
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-bg-input max-w-[448px]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            type="search"
            placeholder={t("vocab.search")}
            defaultValue=""
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="flex-1 text-[14px] text-text-primary bg-transparent outline-none placeholder:text-text-placeholder [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      <div className="flex items-center gap-1 px-page pb-3 border-b border-border">
        <Button variant="ghost" size="sm" active={contentTab === "vocab"} onClick={() => setContentTab("vocab")}>
          <Languages size={14} />
          {t("vocab.savedTab")}
        </Button>
        <Button variant="ghost" size="sm" active={contentTab === "history"} onClick={() => setContentTab("history")}>
          <History size={14} />
          {t("vocab.historyTab")}
          <span className="text-[11px] text-text-muted">{records.length}</span>
        </Button>
      </div>

      {/* Book filter pills + sort */}
      {(contentTab === "vocab" ? !isEmpty : records.length > 0) && (
        <div className="flex items-center gap-2 px-page pt-2 pb-4 overflow-x-auto border-b border-border">
          {contentTab === "vocab" && <button
            type="button"
            onClick={() => setReviewOnly((value) => !value)}
            className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
              reviewOnly ? "bg-accent-bg border-accent/30 text-accent-text" : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
            }`}
          >
            <GraduationCap size={12} />
            {t("vocab.reviewDue")}
            <span className="text-[11px]">{dueWords.length}</span>
          </button>}
          <button
            onClick={() => setBookFilter(null)}
            className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
              bookFilter === null
                ? "bg-accent-bg border-accent/30 text-accent-text"
                : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
            }`}
          >
            <BookOpen size={12} className={bookFilter === null ? "text-accent-text" : ""} />
            {t("common.allBooks")}
            <span className={`text-[11px] ${bookFilter === null ? "text-accent-text" : "text-text-muted"}`}>
              {contentTab === "vocab" ? words.length : records.length}
            </span>
          </button>
          {(contentTab === "vocab" ? bookPills : historyBookPills).map((pill) => (
            <button
              key={pill.id}
              onClick={() => setBookFilter(bookFilter === pill.id ? null : pill.id)}
              className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
                bookFilter === pill.id
                  ? "bg-accent-bg border-accent/30 text-accent-text"
                  : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
              }`}
            >
              <BookOpen size={12} className={bookFilter === pill.id ? "text-accent-text" : ""} />
              <span className="truncate max-w-[120px]">{pill.title}</span>
              <span className={`text-[11px] ${bookFilter === pill.id ? "text-accent-text" : "text-text-muted"}`}>
                {pill.count}
              </span>
            </button>
          ))}

          {contentTab === "vocab" && <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              onClick={() => setSort("newest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "newest" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDownWideNarrow size={12} />
              {t("vocab.newest")}
            </button>
            <button
              onClick={() => setSort("oldest")}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "oldest" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowUpWideNarrow size={12} />
              {t("vocab.oldest")}
            </button>
            <button
              onClick={() => { setSort("az"); setView("list"); }}
              className={`flex items-center gap-1 h-7 px-2.5 rounded-lg text-[11px] font-medium cursor-pointer transition-colors ${
                sort === "az" ? "text-accent-text" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDownAZ size={12} />
              {t("vocab.az")}
            </button>
          </div>}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-page pb-20">
        {contentTab === "history" ? (
          records.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full">
              <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
                <History size={28} className="text-text-muted" />
              </div>
              <h2 className="text-[18px] font-medium text-text-primary mb-2">{t("vocab.historyEmpty")}</h2>
              <p className="text-[14px] text-text-muted text-center max-w-[296px]">{t("vocab.historyEmptySub")}</p>
            </div>
          ) : (
            <div className="max-w-[720px] space-y-2">
              {filteredRecords.map((record) => (
                <div key={record.id} className="border border-border rounded-lg bg-bg-surface px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-text-primary">{record.lookup_text}</p>
                      <p className="mt-1 text-[13px] text-text-secondary line-clamp-2 whitespace-pre-line">{record.definition}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-text-muted">{timeAgo(record.last_looked_up_at)}</span>
                  </div>
                  {record.context_sentence && <p className="mt-2 text-[12px] italic text-text-muted line-clamp-2">"{record.context_sentence}"</p>}
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-text-muted">
                    <span className="flex items-center gap-1 min-w-0"><BookOpen size={12} /><span className="truncate">{record.book_title || t("common.unknownBook")}</span></span>
                    {record.chapter && <span className="truncate">{record.chapter}</span>}
                    {record.lookup_count > 1 && <span>{t("vocab.lookedUpCount", { count: record.lookup_count })}</span>}
                    {record.cfi && (
                      <button
                        type="button"
                        onClick={() => openReaderWindow(record.book_id, { openVocab: true, cfi: record.cfi })}
                        className="ml-auto flex items-center gap-1 text-accent-text hover:opacity-70 cursor-pointer"
                      >
                        {t("vocab.openInReader")} <FileText size={12} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {filteredRecords.length === 0 && <p className="pt-8 text-center text-[14px] text-text-muted">{t("vocab.noMatches")}</p>}
            </div>
          )
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="size-16 rounded-full bg-bg-input flex items-center justify-center mb-4">
              <Languages size={28} className="text-text-muted" />
            </div>
            <h2 className="text-[18px] font-medium text-text-primary mb-2">
              {t("vocab.empty")}
            </h2>
            <p className="text-[14px] text-text-muted text-center max-w-[296px]">
              {t("vocab.emptySub")}
            </p>
          </div>
        ) : view === "list" ? (
          <div key="list">
            {groupedByLetter.map(([letter, letterWords]) => (
              <div key={letter} className="mb-6">
                <div className="flex items-center gap-3 mb-2">
                  <span className="text-[18px] font-bold text-accent">{letter}</span>
                  <div className="flex-1 h-px bg-border-light" />
                  <span className="text-[11px] text-text-muted">{letterWords.length}</span>
                </div>
                {letterWords.map((word) => {
                  const parts = word.definition.split("\n\n");
                  const defText = parts[0] || "";
                  const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                  return (
                    <button
                      key={word.id}
                      type="button"
                      onClick={() => setActiveWord(word)}
                      className="flex items-start gap-4 px-3 pt-3 pb-3 rounded-[10px] hover:bg-bg-input group w-full text-left cursor-pointer"
                    >
                      <div className="w-[160px] shrink-0">
                        <span className="block text-[14px] font-semibold text-text-primary leading-5">
                          {word.word}
                        </span>
                        <span className={`inline-flex mt-1 text-[10px] font-medium ${word.mastery === "mastered" ? "text-success-text" : word.mastery === "learning" ? "text-accent-text" : "text-text-muted"}`}>
                          {t(`vocab.mastery.${word.mastery}`)}
                        </span>
                        {word.book_title && (
                          <span className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5">
                            <BookOpen size={10} />
                            <span className="truncate">{word.book_title}</span>
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] text-text-secondary leading-5 truncate">{defText}</p>
                        {ctxText && (
                          <p className="text-[11px] italic text-text-muted leading-4 truncate mt-0.5">
                            "{ctxText}"
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {word.mastery !== "mastered" && (
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); markMastered(word); }}
                            title={t("vocab.markMastered")}
                            className="size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-surface hover:text-success-text cursor-pointer"
                          >
                            <CheckCircle2 size={14} />
                          </button>
                        )}
                        {word.mastery !== "learning" && word.mastery !== "mastered" && (
                          <button
                            type="button"
                            onClick={(event) => { event.stopPropagation(); scheduleLearning(word); }}
                            title={t("vocab.startLearning")}
                            className="size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-surface hover:text-accent-text cursor-pointer"
                          >
                            <GraduationCap size={14} />
                          </button>
                        )}
                        <span className="text-[11px] text-text-muted">{timeAgo(word.created_at)}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(word.id);
                          }}
                          className="p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={14} className="text-text-muted" />
                        </button>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div key="card" className="max-w-[525px] space-y-6">
            {groupedByBook.map((group) => (
              <div key={group.id}>
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen size={14} className="text-text-muted" />
                  <span className="text-[12px] font-semibold uppercase text-text-muted tracking-[0.3px]">
                    {group.title}
                  </span>
                  <span className="text-[11px] text-text-muted">({group.words.length})</span>
                </div>
                <div className="space-y-3">
                  {group.words.map((word) => {
                    const parts = word.definition.split("\n\n");
                    const defText = parts[0] || "";
                    const ctxText = parts.length > 1 ? parts.slice(1).join(" ") : null;
                    return (
                      <button
                        key={word.id}
                        type="button"
                        onClick={() => setActiveWord(word)}
                        className="group relative bg-bg-muted border border-border rounded-[14px] p-[17px] flex flex-col gap-2 w-full text-left cursor-pointer hover:bg-bg-input transition-colors"
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(word.id);
                          }}
                          className="absolute top-4 right-4 p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <Trash2 size={15} className="text-text-muted" />
                        </button>
                        <span className="text-[15px] font-semibold text-text-primary leading-[22.5px] tracking-[-0.23px]">
                          {word.word}
                        </span>
                        <p className="text-[13px] text-text-secondary leading-[20.15px] tracking-[-0.08px] line-clamp-3 w-[460px] max-w-full">
                          {defText}
                        </p>
                        {ctxText && (
                          <div className="border-l-2 border-accent/30 pl-2 overflow-hidden">
                            <p className="text-[11px] italic text-text-muted leading-[16.5px] tracking-[0.06px] line-clamp-2">
                              {ctxText}
                            </p>
                          </div>
                        )}
                        <div className="flex items-center gap-3">
                          {word.cfi && (
                            <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                              <FileText size={12} />
                              p. 1
                            </span>
                          )}
                          <span className="flex items-center gap-1 text-[11px] text-text-muted tracking-[0.06px]">
                            <Clock size={12} />
                            {timeAgo(word.created_at)}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <VocabDetailModal
        word={activeWord}
        onClose={() => setActiveWord(null)}
        onDelete={async (id) => {
          await remove(id);
          setActiveWord(null);
        }}
      />
    </div>
  );
}
