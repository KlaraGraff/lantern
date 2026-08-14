import { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Languages,
  Search,
  BookOpen,
  FileText,
  Trash2,
  LayoutGrid,
  List,
  ArrowDownAZ,
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Download,
  Upload,
  CheckSquare,
  Square,
  X,
  Check,
  GraduationCap,
  CheckCircle2,
  History,
  RotateCcw,
  BookmarkPlus,
  BookmarkCheck,
  ClipboardList,
  Loader2,
} from "lucide-react";
import Button from "./ui/Button";
import { useAllDictionary, useAllLookupHistory, type LookupRecord, type LookupRecordPage } from "../hooks/useDictionary";
import { timeAgo } from "../utils/timeAgo";
import { notifyReaders } from "../utils/notifyReaders";
import { pickedFilePath } from "../utils/picked-file";
import MergedVocabDetails from "./vocab/MergedVocabDetails";
import MasteryPanel, { type MasteryLevel } from "./vocab/MasteryPanel";
import { glossOf, parseDefinition } from "./vocab/entry-text";
import { isBooklessVocabRow, mergedVocabBookLabel, vocabGroupId, vocabGroupLabel, vocabSourceText } from "./vocab/source-label";
import { saveVocabWord } from "./vocab/collect";
import {
  bookCountsByWord,
  dueMergedEntries,
  daysUntilDue,
  hasQuizSource,
  mergeVocabWords,
  vocabMergeKey,
  type MergedVocabEntry,
} from "./vocab/merge";
import ReviewBoard from "./review/ReviewBoard";
import { useOpenBook } from "../hooks/useOpenBook";
import { useSettings } from "../hooks/useSettings";
import {
  LearningCardModules,
  parseCardDesignConfig,
  type LearningCardResult,
} from "./learning-card";
import { TOP_INSET } from "../utils/top-inset";
import { platform } from "../services/platform";

// Deferred the same way VocabEntry.tsx defers it — this panel only opens on
// an explicit expand, and the markdown renderer it drags in has no business
// in the library's first paint.
const VocabEntryDetails = lazy(() => import("./vocab/VocabEntryDetails"));

// A word looked up this many times without ever being saved is the clearest
// signal the vocabulary list has: the reader keeps needing it and keeps not
// collecting it.
const REPEAT_LOOKUP_THRESHOLD = 3;

type SortMode = "newest" | "oldest" | "az";
type ViewMode = "list" | "card";
/** How the saved tab is grouped: one row per word, or today's per-book listing. */
type ListView = "word" | "book";
type ContentTab = "vocab" | "history";
type BackupFormat = "json" | "csv";
type ImportConflictPolicy = "skip" | "overwrite";

interface VocabBackupWord {
  id: string;
  /** Null for the rows saved outside a book — a quiz paper today. */
  book_id: string | null;
  word: string;
  definition: string;
  context_sentence: string | null;
  context_explanation: string | null;
  cfi: string | null;
  mastery: string;
  review_count: number;
  next_review_at: number | null;
  review_interval_days: number;
  last_reviewed_at: number | null;
  last_review_rating: string | null;
  fsrs_stability: number | null;
  fsrs_difficulty: number | null;
  fsrs_version: number;
  created_at: number;
  updated_at: number;
}

interface VocabBackup {
  schema: "lantern-vocabulary";
  version: number;
  exported_at: number;
  words: VocabBackupWord[];
}

interface VocabImportPreview {
  valid: number;
  new_words: number;
  conflicts: number;
  missing_books: number;
  duplicate_rows: number;
  invalid_rows: number;
}

interface VocabImportResult {
  preview: VocabImportPreview;
  imported: number;
  replaced: number;
  skipped: number;
  dry_run: boolean;
}

const VOCAB_BACKUP_CSV_HEADERS = [
  "backup_schema",
  "backup_version",
  "id",
  "book_id",
  "word",
  "definition",
  "context_sentence",
  "context_explanation",
  "cfi",
  "mastery",
  "review_count",
  "next_review_at",
  "review_interval_days",
  "last_reviewed_at",
  "last_review_rating",
  "fsrs_stability",
  "fsrs_difficulty",
  "fsrs_version",
  "created_at",
  "updated_at",
];

/** A row of the saved list: one merged word, or one record in the by-book view. */
interface VocabListEntry {
  entryKey: string;
  entry: MergedVocabEntry;
  /** By-book view only: this same word is also saved from another book. */
  sameWordOtherBook: boolean;
}

interface VocabListGroup {
  id: string;
  /** Null for the ungrouped card view. */
  label: string | null;
  kind: "letter" | "book" | null;
  entries: VocabListEntry[];
}

/** Names the books a merged delete would empty, joined the way the locale does. */
function formatBookList(titles: string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(titles);
  } catch {
    return titles.join(", ");
  }
}

interface DictionaryContentProps {
  /**
   * "all" (the plain 生词/vocab entry) shows the review board with the full
   * word list already expanded below it — today's behavior, unchanged.
   * "review" (the 复习/review sidebar entry) shows the same board but starts
   * the word list collapsed behind the "全部生词"/"All words" divider, so the
   * two sidebar rows land somewhere visibly different rather than the same
   * page with a different highlighted row.
   */
  initialView?: "all" | "review";
  /** Narrow-layout drawer opener; see `Home.tsx`. Absent on desktop. */
  menuButton?: ReactNode;
}

export default function DictionaryContent({ initialView = "all", menuButton }: DictionaryContentProps = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const openInReader = useOpenBook();
  const { words, remove, updateMastery, refresh: refreshWords } = useAllDictionary();
  const { records, total: historyTotal, books: historyBooks, hasMore: historyHasMore, loadingMore: historyLoadingMore, refresh: refreshHistory, loadMore: loadMoreHistory, remove: removeHistoryRecord, clear: clearHistory } = useAllLookupHistory();
  const [sort, setSort] = useState<SortMode>("newest");
  const [view, setView] = useState<ViewMode>("list");
  const [search, setSearch] = useState("");
  const [bookFilter, setBookFilter] = useState<string | null>(null);
  const [expandedWordId, setExpandedWordId] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [contentTab, setContentTab] = useState<ContentTab>("vocab");
  const [now, setNow] = useState(0);
  const [historyClearConfirming, setHistoryClearConfirming] = useState(false);
  const [repeatUnsavedOnly, setRepeatUnsavedOnly] = useState(false);
  const [collectingId, setCollectingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [backupMenuOpen, setBackupMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importData, setImportData] = useState<string | null>(null);
  const [importFormat, setImportFormat] = useState<BackupFormat | null>(null);
  const [importPreview, setImportPreview] = useState<VocabImportPreview | null>(null);
  const [importPolicy, setImportPolicy] = useState<ImportConflictPolicy>("skip");
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedWordIds, setSelectedWordIds] = useState<Set<string>>(() => new Set());
  const [bulkMastery, setBulkMastery] = useState<"new" | "learning" | "mastered">("learning");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleteEntry, setDeleteEntry] = useState<MergedVocabEntry | null>(null);
  // "review" starts the list collapsed behind the divider; "all" starts it
  // open. Re-synced on prop change (not just on mount) so switching sidebar
  // rows between 生词/复习 without unmounting this component still lands the
  // list in the right state.
  const [listExpanded, setListExpanded] = useState(initialView !== "review");
  useEffect(() => setListExpanded(initialView !== "review"), [initialView]);
  const wordListAnchorRef = useRef<HTMLDivElement | null>(null);
  const revealWordList = useCallback(() => {
    setListExpanded(true);
    window.requestAnimationFrame(() => wordListAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const { settings, save: saveSetting } = useSettings();
  const clearConfirmationTimer = useRef<number | null>(null);

  const learningCardConfig = useMemo(
    () => parseCardDesignConfig(settings.learning_card_config),
    [settings.learning_card_config],
  );

  // Grouping the saved tab by word is the default; by book is the old view,
  // kept because it is the only way to see what one book cost you.
  const listView: ListView = settings.vocab_list_view === "book" ? "book" : "word";

  // "Use as main definition" has to outlive the render, and it cannot be stored
  // by touching `updated_at`: mastery write-through rewrites every sibling's
  // timestamp, so the promotion would be erased by the next review.
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

  const setPrimaryRow = useCallback((key: string, rowId: string) => {
    void saveSetting("vocab_primary_definition", JSON.stringify({ ...primaryOverrides, [key]: rowId }));
  }, [primaryOverrides, saveSetting]);

  const historySearch = contentTab === "history" ? search.trim() : "";
  const historyBookFilter = contentTab === "history" ? bookFilter ?? undefined : undefined;
  // Only typing is debounced; arriving on the tab or picking a book fires
  // straight away. See `qa/QaContent.tsx` for why the first load must not
  // wait — short version: the smoke sweep settles faster than the timer and
  // unmounts the page before the request it was going to make ever happens.
  const lastHistorySearch = useRef<string | null>(null);
  useEffect(() => {
    if (contentTab !== "history") return;
    const typing = lastHistorySearch.current !== null && lastHistorySearch.current !== historySearch;
    lastHistorySearch.current = historySearch;
    if (!typing) {
      refreshHistory(historySearch, historyBookFilter);
      return;
    }
    const timer = window.setTimeout(() => refreshHistory(historySearch, historyBookFilter), 200);
    return () => window.clearTimeout(timer);
  }, [contentTab, historySearch, historyBookFilter, refreshHistory]);

  useEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => () => {
    if (clearConfirmationTimer.current !== null) {
      window.clearTimeout(clearConfirmationTimer.current);
    }
  }, []);

  // The whole library, merged: what the counts and the review queue are about.
  const allEntries = useMemo(() => mergeVocabWords(words, primaryOverrides), [words, primaryOverrides]);
  const bookCounts = useMemo(() => bookCountsByWord(words), [words]);
  const dueEntries = useMemo(() => dueMergedEntries(allEntries, now), [allEntries, now]);

  const filtered = useMemo(() => {
    let result = words;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((w) => [w.word, w.definition, w.context_sentence, w.book_title, w.source_label]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(q)));
    }
    if (bookFilter) {
      result = result.filter((w) => vocabGroupId(w) === bookFilter);
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

  /**
   * What the saved tab actually renders. The word/book toggle decides how rows
   * are grouped and whether they merge; the list/card toggle only decides how
   * dense each row is, so both toggles keep meaning what they meant.
   */
  const listGroups = useMemo<VocabListGroup[]>(() => {
    if (listView === "book") {
      // One entry per record, exactly as before the merge — but a word that
      // also lives elsewhere says so.
      const map = new Map<string, VocabListGroup>();
      for (const row of sorted) {
        // 词卷收藏的词没有书，自成一组「词卷」——不混进任何一本书，也不落到
        // 「未知书籍」里（docs/impls/quiz-word-lookup.md §五）。
        const groupId = vocabGroupId(row);
        let group = map.get(groupId);
        if (!group) {
          group = { id: groupId, label: vocabGroupLabel(row, t), kind: "book", entries: [] };
          map.set(groupId, group);
        }
        group.entries.push({
          entryKey: row.id,
          entry: mergeVocabWords([row], primaryOverrides)[0],
          sameWordOtherBook: (bookCounts.get(vocabMergeKey(row.word)) ?? 1) > 1,
        });
      }
      return Array.from(map.values());
    }

    const entries: VocabListEntry[] = mergeVocabWords(sorted, primaryOverrides)
      .map((entry) => ({ entryKey: entry.key, entry, sameWordOtherBook: false }));
    if (view === "card") return [{ id: "all", label: null, kind: null, entries }];

    const byLetter = new Map<string, VocabListEntry[]>();
    for (const item of entries) {
      const letter = item.entry.word[0]?.toUpperCase() || "#";
      const bucket = byLetter.get(letter);
      if (bucket) bucket.push(item);
      else byLetter.set(letter, [item]);
    }
    return Array.from(byLetter.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([letter, groupEntries]) => ({ id: letter, label: letter, kind: "letter" as const, entries: groupEntries }));
  }, [bookCounts, listView, primaryOverrides, sorted, t, view]);

  const bookPills = useMemo(() => {
    const map = new Map<string, { title: string; count: number }>();
    for (const w of words) {
      const groupId = vocabGroupId(w);
      if (!map.has(groupId)) {
        map.set(groupId, { title: vocabGroupLabel(w, t), count: 0 });
      }
      map.get(groupId)!.count++;
    }
    return Array.from(map.entries()).map(([id, { title, count }]) => ({ id, title, count }));
  }, [words, t]);

  const isEmpty = words.length === 0;

  // Cross-book on purpose: a word saved from another book is still saved, and
  // offering to collect it again would just mint the duplicate row the reader
  // already has.
  const savedWordKeys = useMemo(
    () => new Set(words.map((word) => word.word.trim().toLowerCase())),
    [words],
  );

  // One word looked up at five places is five rows. The reader thinks in
  // words, so the repeat count has to be summed across them.
  const lookupTotals = useMemo(() => {
    const totals = new Map<string, number>();
    for (const record of records) {
      const key = record.normalized_text;
      totals.set(key, (totals.get(key) ?? 0) + record.lookup_count);
    }
    return totals;
  }, [records]);

  const repeatUnsavedRecords = useMemo(
    () => records.filter((record) =>
      (lookupTotals.get(record.normalized_text) ?? 0) >= REPEAT_LOOKUP_THRESHOLD
      && !savedWordKeys.has(record.lookup_text.trim().toLowerCase())),
    [lookupTotals, records, savedWordKeys],
  );

  const filteredRecords = repeatUnsavedOnly ? repeatUnsavedRecords : records;

  const collectRecord = useCallback(async (record: LookupRecord) => {
    setCollectingId(record.id);
    try {
      // The stored text is the one the reader already paid for, so it is
      // reused rather than asking the model to say the same thing twice.
      //
      // The *contextual* line is what is offered, though, never `definition`.
      // A lookup record's `definition` deliberately prefers the word entry
      // over the contextual meaning, because a cached lookup is reused for the
      // same word in other sentences — which makes it exactly the wrong thing
      // to print above one particular word. Offered as a gloss it produced
      // "副词，拼写为 m-e-t-i-c-u-l-…": part-of-speech metadata, clamped
      // mid-word, sitting over the sentence. Anything too long here falls
      // through to the short-gloss model call, which is the right shape.
      await saveVocabWord({
        bookId: record.book_id,
        word: record.lookup_text,
        gloss: record.context_explanation ?? record.definition,
        contextSentence: record.context_sentence,
        contextExplanation: record.context_explanation ?? record.definition ?? null,
        cfi: record.cfi,
      });
      notifyReaders("vocab-changed", { bookId: record.book_id, cfi: record.cfi });
      await refreshWords();
    } catch (err) {
      console.error("Failed to collect looked-up word:", err);
    } finally {
      setCollectingId(null);
    }
  }, [refreshWords]);

  const historyBookPills = useMemo(() => {
    return historyBooks.map((book) => ({
      id: book.book_id,
      title: book.book_title || t("common.unknownBook"),
      count: book.count,
    }));
  }, [historyBooks, t]);

  // Mastery belongs to the word now: one call moves every record, so the list
  // has to be re-read rather than patched row by row.
  const setEntryMastery = useCallback(async (entry: MergedVocabEntry, mastery: MasteryLevel) => {
    await updateMastery(entry.primary.id, mastery, mastery === "learning" ? now + 24 * 60 * 60 * 1000 : null);
    if (entry.rows.length > 1) await refreshWords();
  }, [now, refreshWords, updateMastery]);
  const downloadCsv = async (filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) => {
    const escape = (value: string | number | null | undefined) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const lines = [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))];
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await writeTextFile(path, `\uFEFF${lines.join("\n")}`);
  };
  const exportVocabBackup = async (format: BackupFormat) => {
    setExporting(true);
    try {
      const backup = await invoke<VocabBackup>("export_vocab_backup");
      if (format === "json") {
        const path = await save({
          defaultPath: "lantern-vocabulary.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        await writeTextFile(path, JSON.stringify(backup, null, 2));
      } else {
        await downloadCsv(
          "lantern-vocabulary.csv",
          VOCAB_BACKUP_CSV_HEADERS,
          backup.words.map((word) => [
            backup.schema, backup.version, word.id, word.book_id, word.word, word.definition,
            word.context_sentence, word.context_explanation, word.cfi, word.mastery,
            word.review_count, word.next_review_at, word.review_interval_days,
            word.last_reviewed_at, word.last_review_rating, word.fsrs_stability,
            word.fsrs_difficulty, word.fsrs_version, word.created_at, word.updated_at,
          ]),
        );
      }
    } catch (error) {
      console.error("Failed to export vocabulary backup:", error);
    } finally {
      setExporting(false);
      setBackupMenuOpen(false);
    }
  };
  const exportCsv = async () => {
    setExporting(true);
    try {
      const allRecords: LookupRecord[] = [];
      let cursor: string | null = null;
      do {
        const page: LookupRecordPage = await invoke<LookupRecordPage>("list_all_lookup_records", {
          search: historySearch || null,
          bookId: historyBookFilter || null,
          cursor,
          limit: 200,
        });
        allRecords.push(...page.records);
        cursor = page.next_cursor;
      } while (cursor !== null);
      await downloadCsv(
        "lantern-lookup-history.csv",
        ["lookup", "definition", "context_explanation", "context", "chapter", "book", "first_looked_up_at", "last_looked_up_at", "lookup_count"],
        allRecords.map((record) => [
          record.lookup_text,
          record.definition,
          record.context_explanation,
          record.context_sentence,
          record.chapter,
          record.book_title,
          new Date(record.created_at).toISOString(),
          new Date(record.last_looked_up_at).toISOString(),
          String(record.lookup_count),
        ]),
      );
    } finally {
      setExporting(false);
    }
  };
  const resetImport = () => {
    setImportData(null);
    setImportFormat(null);
    setImportPreview(null);
    setImportPolicy("skip");
    setImportError(null);
  };
  const chooseVocabBackup = async () => {
    setImportError(null);
    const selected = await open({
      multiple: false,
      filters: [{ name: "Vocabulary backup", extensions: ["json", "csv"] }],
      fileAccessMode: "scoped",
    });
    if (typeof selected !== "string") return;
    const path = pickedFilePath(selected);
    const extension = path.split(".").pop()?.toLowerCase();
    const format: BackupFormat | null = extension === "json" || extension === "csv" ? extension : null;
    if (!format) {
      setImportError(t("vocab.backup.unsupportedFile"));
      return;
    }
    setImporting(true);
    try {
      const data = await readTextFile(path);
      const preview = await invoke<VocabImportPreview>("preview_vocab_import", { data, format });
      setImportData(data);
      setImportFormat(format);
      setImportPreview(preview);
    } catch (error) {
      console.error("Failed to preview vocabulary backup:", error);
      setImportError(t("vocab.backup.importFailed"));
    } finally {
      setImporting(false);
    }
  };
  const importVocabBackup = async () => {
    if (!importData || !importFormat) return;
    setImporting(true);
    setImportError(null);
    try {
      await invoke<VocabImportResult>("import_vocab_backup", {
        data: importData,
        format: importFormat,
        conflictPolicy: importPolicy,
        dryRun: false,
      });
      await refreshWords();
      resetImport();
    } catch (error) {
      console.error("Failed to import vocabulary backup:", error);
      setImportError(t("vocab.backup.importFailed"));
    } finally {
      setImporting(false);
    }
  };
  // Selecting a merged row selects the records behind it — otherwise a bulk
  // action would silently skip the copies the reader cannot see.
  const entrySelected = (entry: MergedVocabEntry) => entry.rows.every((row) => selectedWordIds.has(row.id));
  const toggleEntrySelection = (entry: MergedVocabEntry) => {
    setSelectedWordIds((previous) => {
      const next = new Set(previous);
      const selected = entry.rows.every((row) => next.has(row.id));
      for (const row of entry.rows) {
        if (selected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  };
  const deleteMergedEntry = async (entry: MergedVocabEntry) => {
    setBulkBusy(true);
    try {
      await invoke<number>("bulk_delete_vocab_words", { ids: entry.rows.map((row) => row.id) });
      await refreshWords();
      setSelectedWordIds((previous) => {
        const next = new Set(previous);
        for (const row of entry.rows) next.delete(row.id);
        return next;
      });
      setDeleteEntry(null);
    } catch (error) {
      console.error("Failed to delete merged vocabulary entry:", error);
    } finally {
      setBulkBusy(false);
    }
  };
  /** One record deletes as before; a merged word has to say what else goes. */
  const requestDeleteEntry = (entry: MergedVocabEntry) => {
    if (entry.rows.length === 1) void remove(entry.rows[0].id);
    else setDeleteEntry(entry);
  };
  /** A word in one book expands exactly as it did before the merge. */
  const entryDetails = (entry: MergedVocabEntry) => (entry.rows.length > 1 ? (
    <MergedVocabDetails
      entry={entry}
      onOpenRow={(row) => {
        if (row.book_id) openInReader(row.book_id, { openVocab: true, cfi: row.cfi ?? undefined });
      }}
      onSetPrimary={(rowId) => setPrimaryRow(entry.key, rowId)}
      onSetMastery={(mastery) => { void setEntryMastery(entry, mastery); }}
    />
  ) : (
    <>
      <Suspense fallback={null}>
        <VocabEntryDetails
          word={entry.primary}
          // 词卷收藏没有书也没有 CFI，「去阅读器」无处可去，按钮整个不出。
          onOpenInReader={isBooklessVocabRow(entry.primary) ? undefined : () => openInReader(entry.primary.book_id!, {
            openVocab: true,
            cfi: entry.primary.cfi ?? undefined,
          })}
        />
      </Suspense>
      {/* Most saved words come from a single book, so this is where the
          automatic tier is usually seen and overruled — not the merged panel. */}
      <MasteryPanel
        word={entry.primary}
        onSetMastery={(mastery) => { void setEntryMastery(entry, mastery); }}
      />
    </>
  ));
  const toggleSelectVisible = () => {
    setSelectedWordIds((previous) => {
      const visibleIds = sorted.map((word) => word.id);
      const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => previous.has(id));
      const next = new Set(previous);
      for (const id of visibleIds) {
        if (allVisibleSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };
  const applyBulkMastery = async () => {
    if (selectedWordIds.size === 0) return;
    const nextReviewAt = bulkMastery === "learning" ? Date.now() + 24 * 60 * 60 * 1000 : null;
    setBulkBusy(true);
    try {
      await invoke<number>("bulk_update_vocab_mastery", {
        ids: Array.from(selectedWordIds),
        mastery: bulkMastery,
        nextReviewAt,
      });
      await refreshWords();
      setSelectedWordIds(new Set());
    } catch (error) {
      console.error("Failed to update vocabulary mastery in bulk:", error);
    } finally {
      setBulkBusy(false);
    }
  };
  const deleteSelectedWords = async () => {
    if (selectedWordIds.size === 0) return;
    setBulkBusy(true);
    try {
      await invoke<number>("bulk_delete_vocab_words", { ids: Array.from(selectedWordIds) });
      await refreshWords();
      setSelectedWordIds(new Set());
      setConfirmBulkDelete(false);
    } catch (error) {
      console.error("Failed to delete vocabulary in bulk:", error);
    } finally {
      setBulkBusy(false);
    }
  };
  const requestClearHistory = async () => {
    if (!historyClearConfirming) {
      setHistoryClearConfirming(true);
      clearConfirmationTimer.current = window.setTimeout(() => {
        setHistoryClearConfirming(false);
        clearConfirmationTimer.current = null;
      }, 3000);
      return;
    }
    if (clearConfirmationTimer.current !== null) {
      window.clearTimeout(clearConfirmationTimer.current);
      clearConfirmationTimer.current = null;
    }
    await clearHistory(historyBookFilter);
    setHistoryClearConfirming(false);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-page pb-2 relative select-none">
{/* macOS only: it is the traffic-light drag strip, and on a phone it
            would be an invisible 44px sheet over the header. Harmless on a
            notched device, where the safe inset already pushes the title clear
            of it — and a dead zone over the ☰ button on an iPhone SE, whose
            inset is 20pt. Same guard as `Home.tsx`. */}
        {platform.hasTitleBarInset && <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-titlebar" />}
        <div className={`${TOP_INSET} flex flex-col gap-3 mb-6 md:flex-row md:items-center md:justify-between`}>
          <div className="flex min-w-0 items-center gap-3">
            {menuButton}
            <h1 className="text-[24px] font-semibold text-text-primary tracking-[0.07px]">
              {contentTab === "vocab" ? t("vocab.title") : t("vocab.history")}
            </h1>
            {contentTab === "vocab" && !isEmpty && (
              <span className="truncate text-[12px] text-text-muted">
                {listView === "book"
                  ? t("vocab.merged.summaryByBook", { records: words.length, books: bookPills.length })
                  : t("vocab.merged.summary", { words: allEntries.length, records: words.length })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 md:flex-nowrap md:justify-normal md:gap-0">
            {contentTab === "vocab" && (
              // Full width on a phone, so the row below it is the four icon
              // buttons and nothing else. Left to wrap on its own, six controls
              // in a 440pt row put five on the first line and stranded the
              // sixth — the list-view toggle — alone on a second line with a
              // hand's width of empty space beside it.
              <div className="flex w-full items-center gap-2 md:mr-2 md:w-auto">
                <Button
                  variant="secondary"
                  size="md"
                  disabled={dueEntries.length === 0}
                  onClick={() => navigate("/flashcards")}
                >
                  <RotateCcw size={15} />
                  {t("flashcards.title")}
                  {dueEntries.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-accent-bg px-1.5 py-0.5 text-[11px] font-medium text-accent-text tabular-nums">
                      {dueEntries.length}
                    </span>
                  )}
                </Button>
                <Button variant="primary" size="md" onClick={() => navigate("/quiz")}>
                  <FileText size={15} />
                  {t("vocab.entry.quiz")}
                </Button>
              </div>
            )}
            {contentTab === "vocab" ? (
              <>
                <div className="relative">
                  <button
                    type="button"
                    title={t("vocab.backup.export")}
                    aria-label={t("vocab.backup.export")}
                    onClick={() => setBackupMenuOpen((open) => !open)}
                    disabled={exporting || importing}
                    className="tap-44 size-9 flex items-center justify-center rounded-lg text-text-muted hover:bg-bg-input disabled:opacity-50 cursor-pointer"
                  >
                    <Download size={16} />
                  </button>
                  {backupMenuOpen && (
                    <div className="absolute right-0 top-10 z-30 w-44 border border-border bg-bg-surface shadow-popover rounded-lg p-1">
                      <button type="button" onClick={() => exportVocabBackup("json")} className="flex w-full h-8 items-center px-2 rounded text-left text-[12px] text-text-secondary hover:bg-bg-input cursor-pointer">
                        {t("vocab.backup.exportJson")}
                      </button>
                      <button type="button" onClick={() => exportVocabBackup("csv")} className="flex w-full h-8 items-center px-2 rounded text-left text-[12px] text-text-secondary hover:bg-bg-input cursor-pointer">
                        {t("vocab.backup.exportCsv")}
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  title={t("vocab.backup.import")}
                  aria-label={t("vocab.backup.import")}
                  onClick={() => chooseVocabBackup().catch(() => {})}
                  disabled={exporting || importing}
                  className="tap-44 size-9 flex items-center justify-center rounded-lg text-text-muted hover:bg-bg-input disabled:opacity-50 cursor-pointer"
                >
                  <Upload size={16} />
                </button>
              </>
            ) : (
              <button
                type="button"
                title={t("vocab.export")}
                aria-label={t("vocab.export")}
                onClick={exportCsv}
                disabled={exporting}
                className="tap-44 size-9 flex items-center justify-center rounded-lg text-text-muted hover:bg-bg-input disabled:opacity-50 cursor-pointer"
              >
                <Download size={16} />
              </button>
            )}
            <Button variant="icon" size="md" className="touch:size-11" active={view === "card"} onClick={() => setView("card")}>
              <LayoutGrid size={16} />
            </Button>
            <Button variant="icon" size="md" className="touch:size-11" active={view === "list"} onClick={() => setView("list")}>
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
          <span className="text-[11px] text-text-muted">{historyTotal}</span>
        </Button>
      </div>

      {contentTab === "vocab" && selectedWordIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-page py-2 bg-bg-surface">
          <span className="mr-1 text-[12px] font-medium text-text-secondary">{t("vocab.bulk.selected", { count: selectedWordIds.size })}</span>
          <select
            value={bulkMastery}
            onChange={(event) => setBulkMastery(event.target.value as "new" | "learning" | "mastered")}
            className="h-8 rounded-md border border-border bg-bg-surface px-2 text-[12px] text-text-secondary outline-none"
          >
            <option value="new">{t("vocab.mastery.new")}</option>
            <option value="learning">{t("vocab.mastery.learning")}</option>
            <option value="mastered">{t("vocab.mastery.mastered")}</option>
          </select>
          <button type="button" onClick={() => applyBulkMastery().catch(() => {})} disabled={bulkBusy} className="flex h-8 items-center gap-1 rounded-md border border-border px-2 text-[12px] text-text-secondary hover:bg-bg-input disabled:opacity-50 cursor-pointer">
            <Check size={13} /> {t("vocab.bulk.apply")}
          </button>
          <button type="button" onClick={() => setConfirmBulkDelete(true)} disabled={bulkBusy} className="flex h-8 items-center gap-1 rounded-md px-2 text-[12px] text-danger-text hover:bg-bg-input disabled:opacity-50 cursor-pointer">
            <Trash2 size={13} /> {t("common.delete")}
          </button>
          <button type="button" onClick={() => setSelectedWordIds(new Set())} className="ml-auto size-8 flex items-center justify-center rounded-md text-text-muted hover:bg-bg-input cursor-pointer" title={t("common.cancel")} aria-label={t("common.cancel")}>
            <X size={15} />
          </button>
        </div>
      )}

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
            <span className="text-[11px]">{dueEntries.length}</span>
          </button>}
          {contentTab === "history" && <button
            type="button"
            onClick={() => setRepeatUnsavedOnly((value) => !value)}
            className={`flex items-center gap-1.5 h-8 px-[13px] rounded-full text-[12px] font-medium cursor-pointer shrink-0 transition-colors border ${
              repeatUnsavedOnly ? "bg-accent-bg border-accent/30 text-accent-text" : "bg-bg-surface border-border text-text-secondary hover:bg-bg-muted"
            }`}
          >
            <BookmarkPlus size={12} />
            {t("vocab.repeatUnsaved", { count: REPEAT_LOOKUP_THRESHOLD })}
            <span className="text-[11px]">{repeatUnsavedRecords.length}</span>
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
              {contentTab === "vocab"
                ? (listView === "book" ? words.length : allEntries.length)
                : historyBooks.reduce((sum, book) => sum + book.count, 0)}
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

          {contentTab === "vocab" && (
            <div className="ml-auto flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-bg-input p-0.5">
              {(["word", "book"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={listView === mode}
                  onClick={() => { void saveSetting("vocab_list_view", mode); }}
                  className={`h-6 rounded-md px-2.5 text-[11px] cursor-pointer transition-colors ${
                    listView === mode
                      ? "bg-bg-surface font-semibold text-accent-text shadow-sm"
                      : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  {t(mode === "word" ? "vocab.viewByWord" : "vocab.viewByBook")}
                </button>
              ))}
            </div>
          )}

          {contentTab === "vocab" && <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={toggleSelectVisible}
              title={t("vocab.bulk.selectVisible")}
              aria-label={t("vocab.bulk.selectVisible")}
              className="tap-44 size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-input cursor-pointer"
            >
              {sorted.length > 0 && sorted.every((word) => selectedWordIds.has(word.id)) ? <CheckSquare size={14} /> : <Square size={14} />}
            </button>
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
        {contentTab === "vocab" && !isEmpty && (
          <ReviewBoard totalWordCount={allEntries.length} onSeeAllWords={revealWordList} />
        )}
        {contentTab === "history" ? (
          historyTotal === 0 ? (
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
                      {!record.result_json && <p className="mt-1 text-[13px] text-text-secondary line-clamp-2 whitespace-pre-line">{record.definition}</p>}
                    </div>
                    <span className="shrink-0 text-[11px] text-text-muted">{timeAgo(record.last_looked_up_at)}</span>
                  </div>
                  {record.context_sentence && <p className="mt-2 text-[12px] italic text-text-muted line-clamp-2">"{record.context_sentence}"</p>}
                  {record.result_json && (() => {
                    try {
                      const result = JSON.parse(record.result_json) as LearningCardResult;
                      if (
                        result.version !== 1
                        || !["word", "phrase", "passage"].includes(result.kind)
                        || !result.modules
                      ) return null;
                      return (
                        <div className="mt-2 border-t border-border-light pt-2">
                          {result.modules.context_meaning?.summary && (
                            <p className="text-[13px] leading-[1.6] text-text-secondary">
                              {result.modules.context_meaning.summary}
                            </p>
                          )}
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] font-medium text-accent-text">
                              {t("vocab.showStructuredResult")}
                            </summary>
                            <div className="mt-2 divide-y divide-border-light border-y border-border-light">
                              <LearningCardModules
                                card={learningCardConfig.cards[result.kind]}
                                kind={result.kind}
                                content={result.modules}
                              />
                            </div>
                          </details>
                        </div>
                      );
                    } catch {
                      return <p className="mt-1 text-[13px] text-text-secondary whitespace-pre-line">{record.definition}</p>;
                    }
                  })()}
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-text-muted">
                    <span className="flex items-center gap-1 min-w-0"><BookOpen size={12} /><span className="truncate">{record.book_title || t("common.unknownBook")}</span></span>
                    {record.chapter && <span className="truncate">{record.chapter}</span>}
                    {(lookupTotals.get(record.normalized_text) ?? record.lookup_count) > 1 && (
                      <span>{t("vocab.lookedUpCount", { count: lookupTotals.get(record.normalized_text) ?? record.lookup_count })}</span>
                    )}
                    <div className="ml-auto flex items-center gap-3">
                      {savedWordKeys.has(record.lookup_text.trim().toLowerCase()) ? (
                        <span className="flex items-center gap-1 text-text-muted">
                          <BookmarkCheck size={12} /> {t("vocab.alreadySaved")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          title={t("vocab.saveToVocab")}
                          aria-label={t("vocab.saveToVocab")}
                          onClick={() => collectRecord(record)}
                          disabled={collectingId === record.id}
                          className="flex items-center gap-1 text-accent-text hover:opacity-70 disabled:opacity-50 cursor-pointer"
                        >
                          {collectingId === record.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <BookmarkPlus size={12} />}
                          {t("vocab.saveToVocab")}
                        </button>
                      )}
                      {record.cfi && (
                        <button
                          type="button"
                          onClick={() => openInReader(record.book_id, { openVocab: true, cfi: record.cfi })}
                          className="flex items-center gap-1 text-accent-text hover:opacity-70 cursor-pointer"
                        >
                          {t("vocab.openInReader")} <FileText size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        title={t("vocab.deleteHistory")}
                        aria-label={t("vocab.deleteHistory")}
                        onClick={() => removeHistoryRecord(record.id)}
                        className="tap-44 size-6 flex items-center justify-center rounded text-text-muted hover:bg-bg-input hover:text-danger-text cursor-pointer"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {filteredRecords.length === 0 && <p className="pt-8 text-center text-[14px] text-text-muted">{t("vocab.noMatches")}</p>}
              {historyHasMore && (
                <button
                  type="button"
                  onClick={() => loadMoreHistory(historySearch, historyBookFilter)}
                  disabled={historyLoadingMore}
                  className="mx-auto mt-4 flex h-9 items-center rounded-md border border-border px-3 text-[12px] font-medium text-text-secondary hover:bg-bg-input disabled:opacity-50 cursor-pointer"
                >
                  {historyLoadingMore ? t("home.loading") : t("vocab.loadMore")}
                </button>
              )}
              {historyTotal > 0 && (
                <button
                  type="button"
                  onClick={() => requestClearHistory().catch(() => {})}
                  className="mx-auto mt-4 flex h-8 items-center text-[12px] text-text-muted hover:text-danger-text cursor-pointer"
                >
                  {historyClearConfirming ? t("vocab.clearHistoryConfirm") : t("vocab.clearHistory")}
                </button>
              )}
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
        ) : (
          <>
            <div ref={wordListAnchorRef} className="flex items-center gap-3 mt-1 mb-4">
              <div className="h-px flex-1 bg-border" />
              {listExpanded ? (
                <span className="shrink-0 text-[12px] text-text-muted">
                  {t("vocab.review.allWordsDivider", { count: allEntries.length })}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setListExpanded(true)}
                  className="shrink-0 text-[12px] text-text-muted hover:text-accent-text cursor-pointer"
                >
                  {t("vocab.review.allWordsDivider", { count: allEntries.length })}
                </button>
              )}
              <div className="h-px flex-1 bg-border" />
            </div>
            {listExpanded && (
          <div key={`${listView}-${view}`} className={view === "card" ? "max-w-[525px] space-y-6" : undefined}>
            {listGroups.map((group) => (
              <div key={group.id} className={view === "card" ? undefined : "mb-6"}>
                {group.kind === "letter" && (
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[18px] font-bold text-accent">{group.label}</span>
                    <div className="flex-1 h-px bg-border-light" />
                    <span className="text-[11px] text-text-muted">{group.entries.length}</span>
                  </div>
                )}
                {group.kind === "book" && (
                  <div className="flex items-center gap-2 mb-3">
                    <BookOpen size={14} className="text-text-muted" />
                    <span className="text-[12px] font-semibold uppercase text-text-muted tracking-[0.3px]">
                      {group.label}
                    </span>
                    <span className="text-[11px] text-text-muted">({group.entries.length})</span>
                  </div>
                )}
                <div className={view === "card" ? "space-y-3" : undefined}>
                  {group.entries.map(({ entryKey, entry, sameWordOtherBook }) => {
                    const gloss = glossOf(parseDefinition(entry.primary.definition).definition);
                    const expanded = expandedWordId === entryKey;
                    const due = entry.nextReviewAt !== null && entry.nextReviewAt <= now;
                    // Scheduled but not yet due: say when, so a row that is
                    // simply waiting reads differently from one with no plan.
                    const daysAway = due ? null : daysUntilDue(entry.nextReviewAt, now);
                    const selected = entrySelected(entry);
                    const details = expanded && entryDetails(entry);
                    if (view === "card") {
                      return (
                        <div
                          key={entryKey}
                          className="group relative bg-bg-muted border border-border rounded-[14px] p-[17px] flex flex-col gap-2 w-full text-left cursor-pointer hover:bg-bg-input transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() => toggleEntrySelection(entry)}
                            aria-label={selected ? t("vocab.bulk.unselect") : t("vocab.bulk.select")}
                            className="absolute top-4 left-4 size-5 flex items-center justify-center text-text-muted hover:text-accent-text cursor-pointer"
                          >
                            {selected ? <CheckSquare size={15} className="text-accent-text" /> : <Square size={15} />}
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); requestDeleteEntry(entry); }}
                            // `touch:` is `(pointer: coarse)`: Tailwind compiles
                            // `group-hover:` behind `(hover: hover)`, so on a finger
                            // this stays `opacity-0` forever without it.
                            className="absolute top-4 right-4 p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity touch:opacity-100"
                          >
                            <Trash2 size={15} className="text-text-muted" />
                          </button>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedWordId(expanded ? null : entryKey)}
                            className="flex flex-col items-start gap-2 pl-6 text-left"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-[15px] font-semibold text-text-primary leading-[22.5px] tracking-[-0.23px]">
                                {entry.word}
                              </span>
                              {entry.books.length > 1 && (
                                <span className="flex items-center gap-1 rounded-full bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                                  <BookOpen size={10} />
                                  {/* 来源里混着词卷时不能说「N 本书」——词卷不是书 */}
                                  {t(hasQuizSource(entry.books) ? "vocab.merged.sourceCount" : "vocab.merged.bookCount", { count: entry.books.length })}
                                </span>
                              )}
                              {sameWordOtherBook && (
                                <span className="rounded-full bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                                  {t("vocab.merged.sameWordOtherBook")}
                                </span>
                              )}
                              {due && (
                                <span className="rounded-full bg-accent-bg px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                                  {t("vocab.reviewDue")}
                                </span>
                              )}
                              {daysAway !== null && (
                                <span className="rounded-full bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                                  {t("vocab.due.inDays", { count: daysAway })}
                                </span>
                              )}
                            </span>
                            <p className="text-[13px] text-text-secondary leading-[20.15px] tracking-[-0.08px] line-clamp-3 w-[460px] max-w-full">
                              {gloss}
                            </p>
                          </button>
                          {details}
                        </div>
                      );
                    }
                    return (
                      <div key={entryKey} className="rounded-[10px] hover:bg-bg-input group">
                        {/* Three columns on a desktop table; on a phone the
                          * arithmetic does not work — a 160px word column plus
                          * an action cluster that can carry three buttons, two
                          * badges and a timestamp leaves the gloss about 50pt,
                          * which truncated a Chinese definition to its first
                          * character. Wrapping is what fixes it: the actions
                          * take `w-full` below the breakpoint and so drop to
                          * their own line, and the word and its gloss stack in
                          * the space that frees up. */}
                        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 pt-3 pb-3 w-full text-left cursor-pointer">
                          <button
                            type="button"
                            onClick={() => toggleEntrySelection(entry)}
                            aria-label={selected ? t("vocab.bulk.unselect") : t("vocab.bulk.select")}
                            className="mt-1 size-5 shrink-0 flex items-center justify-center text-text-muted hover:text-accent-text cursor-pointer"
                          >
                            {selected ? <CheckSquare size={15} className="text-accent-text" /> : <Square size={15} />}
                          </button>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedWordId(expanded ? null : entryKey)}
                            className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left md:flex-row md:items-start md:gap-4"
                          >
                            <div className="w-full md:w-[160px] md:shrink-0">
                              <span className="block text-[14px] font-semibold text-text-primary leading-5">
                                {entry.word}
                              </span>
                              <span className={`inline-flex mt-1 text-[10px] font-medium ${entry.primary.mastery === "mastered" ? "text-success-text" : entry.primary.mastery === "learning" ? "text-accent-text" : "text-text-muted"}`}>
                                {t(`vocab.mastery.${entry.primary.mastery}`)}
                              </span>
                              {entry.books.length > 1 ? (
                                <span className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5">
                                  <BookOpen size={10} />
                                  <span className="truncate">{t(hasQuizSource(entry.books) ? "vocab.merged.sourceCount" : "vocab.merged.bookCount", { count: entry.books.length })}</span>
                                </span>
                              ) : isBooklessVocabRow(entry.primary) ? (
                                // 词卷收藏：没有书名可印，印「词卷 · 卷名」。
                                <span className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5">
                                  <ClipboardList size={10} />
                                  <span className="truncate">{vocabSourceText(entry.primary, t)}</span>
                                </span>
                              ) : entry.primary.book_title && (
                                <span className="flex items-center gap-1 text-[11px] text-text-muted mt-0.5">
                                  <BookOpen size={10} />
                                  <span className="truncate">{entry.primary.book_title}</span>
                                </span>
                              )}
                              {sameWordOtherBook && (
                                <span className="mt-1 inline-flex rounded-full bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                                  {t("vocab.merged.sameWordOtherBook")}
                                </span>
                              )}
                            </div>
                            <div className="w-full min-w-0 md:flex-1">
                              {/* Two lines once it has the width to use them —
                                * one truncated line is a table cell's habit. */}
                              <p className="text-[13px] text-text-secondary leading-5 line-clamp-2 md:line-clamp-none md:truncate">{gloss}</p>
                            </div>
                          </button>
                          <div className="flex w-full items-center justify-end gap-2 md:w-auto md:shrink-0">
                            {due && (
                              <span className="rounded-full bg-accent-bg px-1.5 py-0.5 text-[10px] font-medium text-accent-text">
                                {t("vocab.reviewDue")}
                              </span>
                            )}
                            {daysAway !== null && (
                              <span className="rounded-full bg-bg-input px-1.5 py-0.5 text-[10px] text-text-muted">
                                {t("vocab.due.inDays", { count: daysAway })}
                              </span>
                            )}
                            {due && (
                              <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); navigate(`/flashcards?word=${encodeURIComponent(entry.key)}`); }}
                                title={t("vocab.review")}
                                className="tap-44 size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-surface hover:text-accent-text cursor-pointer"
                              >
                                <RotateCcw size={14} />
                              </button>
                            )}
                            {entry.primary.mastery !== "mastered" && (
                              <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); void setEntryMastery(entry, "mastered"); }}
                                title={t("vocab.markMastered")}
                                className="tap-44 size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-surface hover:text-success-text cursor-pointer"
                              >
                                <CheckCircle2 size={14} />
                              </button>
                            )}
                            {entry.primary.mastery !== "learning" && entry.primary.mastery !== "mastered" && (
                              <button
                                type="button"
                                onClick={(event) => { event.stopPropagation(); void setEntryMastery(entry, "learning"); }}
                                title={t("vocab.startLearning")}
                                className="tap-44 size-7 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-surface hover:text-accent-text cursor-pointer"
                              >
                                <GraduationCap size={14} />
                              </button>
                            )}
                            <span className="text-[11px] text-text-muted">{timeAgo(entry.primary.created_at)}</span>
                            <button
                              onClick={(event) => { event.stopPropagation(); requestDeleteEntry(entry); }}
                              className="p-1 rounded hover:bg-bg-surface/80 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity touch:opacity-100"
                            >
                              <Trash2 size={14} className="text-text-muted" />
                            </button>
                          </div>
                        </div>
                        {details}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
            )}
          </>
        )}
      </div>

      {importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" onClick={resetImport}>
          <div className="w-[480px] max-w-full rounded-lg border border-border bg-bg-surface shadow-popover p-5" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-[16px] font-semibold text-text-primary">{t("vocab.backup.importPreview")}</h2>
                <p className="mt-1 text-[12px] text-text-muted">{t("vocab.backup.format", { format: importFormat?.toUpperCase() })}</p>
              </div>
              <button type="button" onClick={resetImport} className="size-8 rounded-md flex items-center justify-center text-text-muted hover:bg-bg-input cursor-pointer" aria-label={t("common.cancel")}>
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
              {[
                ["vocab.backup.valid", importPreview.valid],
                ["vocab.backup.newWords", importPreview.new_words],
                ["vocab.backup.conflicts", importPreview.conflicts],
                ["vocab.backup.missingBooks", importPreview.missing_books],
                ["vocab.backup.duplicateRows", importPreview.duplicate_rows],
                ["vocab.backup.invalidRows", importPreview.invalid_rows],
              ].map(([label, count]) => (
                <div key={label as string} className="flex items-center justify-between rounded-md bg-bg-input px-3 py-2 text-text-secondary">
                  <span>{t(label as string)}</span><span className="font-medium text-text-primary">{count as number}</span>
                </div>
              ))}
            </div>
            {importPreview.conflicts > 0 && (
              <label className="mt-4 flex items-start gap-2 rounded-md border border-border p-3 text-[12px] text-text-secondary cursor-pointer">
                <input type="checkbox" checked={importPolicy === "overwrite"} onChange={(event) => setImportPolicy(event.target.checked ? "overwrite" : "skip")} className="mt-0.5 accent-accent" />
                <span>{t("vocab.backup.overwriteConflicts")}</span>
              </label>
            )}
            {(importPreview.missing_books > 0 || importPreview.invalid_rows > 0 || importPreview.duplicate_rows > 0) && (
              <p className="mt-3 text-[12px] leading-5 text-text-muted">{t("vocab.backup.importNotice")}</p>
            )}
            {importError && <p className="mt-3 text-[12px] text-danger-text">{importError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="md" onClick={resetImport}>{t("common.cancel")}</Button>
              <Button variant="primary" size="md" onClick={() => importVocabBackup().catch(() => {})} disabled={importing || importPreview.valid === 0}>
                {importing ? t("home.loading") : t("vocab.backup.confirmImport")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {importError && !importPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" onClick={() => setImportError(null)}>
          <div className="w-[400px] max-w-full rounded-lg border border-border bg-bg-surface shadow-popover p-5" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-[16px] font-semibold text-text-primary">{t("vocab.backup.import")}</h2>
            <p className="mt-3 text-[13px] leading-5 text-text-secondary">{importError}</p>
            <div className="mt-5 flex justify-end"><Button variant="primary" size="md" onClick={() => setImportError(null)}>{t("common.cancel")}</Button></div>
          </div>
        </div>
      )}
      {confirmBulkDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" onClick={() => setConfirmBulkDelete(false)}>
          <div className="w-[400px] max-w-full rounded-lg border border-border bg-bg-surface shadow-popover p-5" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-[16px] font-semibold text-text-primary">{t("vocab.bulk.deleteTitle")}</h2>
            <p className="mt-2 text-[13px] leading-5 text-text-secondary">{t("vocab.bulk.deleteBody", { count: selectedWordIds.size })}</p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="md" onClick={() => setConfirmBulkDelete(false)}>{t("common.cancel")}</Button>
              <button type="button" onClick={() => deleteSelectedWords().catch(() => {})} disabled={bulkBusy} className="h-9 rounded-md bg-red-500 px-3 text-[13px] font-medium text-white hover:bg-red-600 disabled:opacity-50 cursor-pointer">{t("common.delete")}</button>
            </div>
          </div>
        </div>
      )}
      {deleteEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" onClick={() => setDeleteEntry(null)}>
          <div className="w-[400px] max-w-full rounded-lg border border-border bg-bg-surface shadow-popover p-5" onClick={(event) => event.stopPropagation()}>
            <h2 className="text-[16px] font-semibold text-text-primary">{t("vocab.merged.deleteTitle", { word: deleteEntry.word })}</h2>
            <p className="mt-2 text-[13px] leading-5 text-text-secondary">
              {t("vocab.merged.deleteBody", {
                books: formatBookList(
                  // 词卷伪书走 source-label 的口径印「词卷 · 卷名」，不落回「未知书籍」
                  deleteEntry.books.map((book) => mergedVocabBookLabel(book, t)),
                  i18n.language,
                ),
              })}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="md" onClick={() => setDeleteEntry(null)}>{t("common.cancel")}</Button>
              <button type="button" onClick={() => deleteMergedEntry(deleteEntry).catch(() => {})} disabled={bulkBusy} className="h-9 rounded-md bg-red-500 px-3 text-[13px] font-medium text-white hover:bg-red-600 disabled:opacity-50 cursor-pointer">{t("vocab.merged.deleteAll")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
