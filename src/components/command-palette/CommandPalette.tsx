import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowRight,
  BookA,
  BookOpen,
  Download,
  GraduationCap,
  Moon,
  Search,
  Settings,
  StickyNote,
  Sun,
} from "lucide-react";
import type { Book } from "../../hooks/useBooks";
import type { DictionaryWord } from "../../hooks/useDictionary";
import { useOpenBook } from "../../hooks/useOpenBook";
import { useBookOpenGate } from "../BookOpenGateProvider";
import { openSettings } from "../settings-open";
import { applyThemePreference } from "../settings/theme-preference";
import { SETTINGS_SECTION_ORDER, SETTINGS_SECTIONS } from "../settings/settings-sections";
import type { SettingsSection } from "../settings-destination";
import { platform } from "../../services/platform";
import { wantsNewWindow } from "../../utils/reader-open-mode";
import { OPEN_PALETTE_EVENT, requestLibraryAction } from "../library-actions";
import {
  GROUP_LIMIT,
  GROUP_ORDER,
  buildCommandSpecs,
  rankByMatch,
  splitMatch,
  wrapIndex,
  type CommandSpec,
  type PaletteGroup,
  type WorkspaceFilter,
} from "./palette-model";

interface AnnotationHit {
  id: string;
  book_id: string | null;
  book_title: string | null;
  location: string | null;
  selected_text: string | null;
  content: string | null;
}

interface Row {
  id: string;
  group: PaletteGroup;
  icon: ReactNode;
  title: string;
  /** Rendered with the query highlighted; commands are matched but not marked. */
  highlight: boolean;
  subtitle?: string;
  run: () => void;
  /** ⌘↵ / ⌘-click: the same thing in a window of its own. Books only, and only where windows exist. */
  runInNewWindow?: () => void;
}

const WORKSPACE_LABEL_KEYS: Record<WorkspaceFilter, string> = {
  all: "nav.library",
  vocab: "nav.learn",
  notes: "sidebar.notes",
  qa: "sidebar.qa",
  stats: "sidebar.readingStats",
};

const GROUP_LABEL_KEYS: Record<PaletteGroup, string> = {
  words: "palette.group.words",
  books: "palette.group.books",
  notes: "palette.group.notes",
  commands: "palette.group.commands",
};

/** Search debounce. Short: every source is local, the wait is only to skip keystrokes. */
const QUERY_DELAY_MS = 120;

/**
 * ⌘K: one box that reaches books, saved words, notes and commands
 * (design v2 §5, the 「全局层」 row; canvas board 「v2 全局搜索与命令面板」).
 *
 * Mounted once per library window. Everything it finds comes from the local
 * database — nothing typed here goes to a model. Every action goes through
 * the same door its click would: the open-book gate, `useOpenBook`,
 * `openSettings`, and the library page's own action events.
 */
export default function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [books, setBooks] = useState<Book[]>([]);
  const [notes, setNotes] = useState<AnnotationHit[]>([]);
  const [words, setWords] = useState<DictionaryWord[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [isDark, setIsDark] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const requestOpen = useBookOpenGate();
  const openInReader = useOpenBook();

  const close = useCallback(() => setOpen(false), []);

  // ⌘K / Ctrl+K anywhere in the window toggles; the rail button and the home
  // search field ask through the event.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Either modifier, the same as ⌘, for settings in `SettingsHost`.
      if (event.key.toLowerCase() !== "k" || event.shiftKey || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      setOpen((current) => !current);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  // Each opening starts clean and re-reads what can change between openings.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelected(0);
    setIsDark(document.documentElement.classList.contains("dark"));
    invoke<DictionaryWord[]>("list_all_vocab_words")
      .then((all) => setWords(all.filter((word) => word.list_status !== "watchlist")))
      .catch(() => setWords([]));
    invoke<{ due_for_review: number }>("get_vocab_stats")
      .then((stats) => setDueCount(stats.due_for_review))
      .catch(() => setDueCount(0));
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      returnFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [open]);

  // Books and notes are searched by the backend; words and commands locally.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const q = query.trim();
    const timer = window.setTimeout(() => {
      invoke<{ books: Book[] }>("list_books", {
        filter: null,
        search: q || null,
        collectionId: null,
        cursor: null,
        limit: GROUP_LIMIT,
        sort: "recent",
      })
        .then((page) => { if (!stale) setBooks(page.books.slice(0, GROUP_LIMIT)); })
        .catch(() => { if (!stale) setBooks([]); });
      if (!q) {
        setNotes([]);
        return;
      }
      invoke<{ annotations: AnnotationHit[] }>("list_annotations", {
        bookId: null,
        kind: "mark",
        search: q,
        updatedAfter: null,
        updatedBefore: null,
        cursor: null,
        limit: GROUP_LIMIT,
      })
        .then((page) => { if (!stale) setNotes(page.annotations.slice(0, GROUP_LIMIT)); })
        .catch(() => { if (!stale) setNotes([]); });
    }, QUERY_DELAY_MS);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const commandSpecs = useMemo(
    () => buildCommandSpecs({ isDark, hasMcp: platform.hasMcpIntegration, settingsSections: SETTINGS_SECTION_ORDER }),
    [isDark],
  );

  const commandTitle = useCallback((spec: CommandSpec): string => {
    switch (spec.kind) {
      case "import": return t("home.importBook");
      case "review": return dueCount > 0 ? t("palette.cmd.reviewDue", { count: dueCount }) : t("palette.cmd.review");
      case "workspace": return t("palette.cmd.goto", { name: t(WORKSPACE_LABEL_KEYS[spec.filter]) });
      case "theme": return t(spec.to === "dark" ? "palette.cmd.themeDark" : "palette.cmd.themeLight");
      case "settings": return t("palette.cmd.settings", { section: t(SETTINGS_SECTIONS[spec.section as SettingsSection].labelKey) });
    }
  }, [t, dueCount]);

  const runCommand = useCallback((spec: CommandSpec) => {
    switch (spec.kind) {
      case "import": requestLibraryAction({ type: "import" }); break;
      case "review": requestLibraryAction({ type: "review" }); break;
      case "workspace": requestLibraryAction({ type: "filter", filter: spec.filter }); break;
      case "theme":
        // Same three steps as the 通用 → 主题 row: the setting, the local
        // mirror App.tsx boots from, and the document class.
        void invoke("set_setting", { key: "theme", value: spec.to }).catch(() => {});
        localStorage.setItem("lantern-theme", spec.to);
        applyThemePreference(spec.to);
        break;
      case "settings": openSettings(spec.section as SettingsSection); break;
    }
  }, []);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const wordRows: Row[] = q
      ? rankByMatch(words, q, (word) => word.word).map((word) => ({
        id: `word:${word.id}`,
        group: "words",
        icon: <BookA size={15} />,
        title: word.word,
        highlight: true,
        subtitle: word.definition,
        run: () => requestLibraryAction({ type: "word", word: word.word }),
      }))
      : [];
    const bookRows: Row[] = books.map((book) => ({
      id: `book:${book.id}`,
      group: "books",
      icon: <BookOpen size={15} />,
      title: book.title,
      highlight: true,
      subtitle: [book.author, book.progress > 0 ? `${Math.round(book.progress)}%` : null].filter(Boolean).join(" · "),
      run: () => requestOpen(book),
      runInNewWindow: platform.hasWindow ? () => requestOpen(book, { newWindow: true }) : undefined,
    }));
    const noteRows: Row[] = notes.map((note) => ({
      id: `note:${note.id}`,
      group: "notes",
      icon: <StickyNote size={15} />,
      // A bare highlight on a book since deleted can have neither; the book's
      // name is then the only thing left to show.
      title: note.content?.trim() || note.selected_text?.trim() || note.book_title || "",
      highlight: true,
      subtitle: note.content?.trim() || note.selected_text?.trim() ? note.book_title ?? undefined : undefined,
      run: () => {
        if (note.book_id && note.location) openInReader(note.book_id, { cfi: note.location });
        else requestLibraryAction({ type: "filter", filter: "notes" });
      },
    }));
    const commandIcon = (spec: CommandSpec) => {
      switch (spec.kind) {
        case "import": return <Download size={15} />;
        case "review": return <GraduationCap size={15} />;
        case "workspace": return <ArrowRight size={15} />;
        case "theme": return spec.to === "dark" ? <Moon size={15} /> : <Sun size={15} />;
        case "settings": return <Settings size={15} />;
      }
    };
    const commands = commandSpecs.map((spec) => ({ spec, title: commandTitle(spec) }));
    const commandRows: Row[] = (q ? rankByMatch(commands, q, (c) => c.title, commands.length) : commands.slice(0, GROUP_LIMIT))
      .map(({ spec, title }) => ({
        id: spec.id,
        group: "commands",
        icon: commandIcon(spec),
        title,
        highlight: false,
        run: () => runCommand(spec),
      }));
    const byGroup: Record<PaletteGroup, Row[]> = { words: wordRows, books: bookRows, notes: noteRows, commands: commandRows };
    return GROUP_ORDER.flatMap((group) => byGroup[group]);
  }, [query, words, books, notes, commandSpecs, commandTitle, runCommand, requestOpen, openInReader]);

  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const runRow = (row: Row | undefined, newWindow = false) => {
    if (!row) return;
    close();
    if (newWindow && row.runInNewWindow) row.runInNewWindow();
    else row.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => wrapIndex(index, event.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runRow(rows[selected], event.metaKey || event.ctrlKey);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") {
      // One field, one list: focus has nowhere else to go inside the dialog.
      event.preventDefault();
    }
  };

  if (!open) return null;

  const q = query.trim();
  const activeId = rows[selected] ? `palette-row-${selected}` : undefined;

  return (
    <div
      className="motion-scrim fixed inset-0 z-[70] flex justify-center bg-overlay px-4 pt-[12vh]"
      onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.label")}
        onKeyDown={onKeyDown}
        className="motion-palette flex h-fit max-h-[76vh] w-full max-w-[640px] flex-col overflow-hidden rounded-[14px] border border-border bg-bg-surface shadow-popover"
      >
        <label className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-light px-4">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            placeholder={t("palette.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <kbd className="shrink-0 rounded border border-border bg-bg-page px-1.5 py-px font-sans text-[10.5px] text-text-muted">esc</kbd>
        </label>

        <div ref={listRef} id="palette-list" role="listbox" aria-label={t("palette.label")} className="min-h-0 overflow-y-auto px-1.5 pb-2 pt-1.5">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-text-muted">{t("palette.empty")}</p>
          ) : (
            rows.map((row, index) => {
              const groupStart = index === 0 || rows[index - 1].group !== row.group;
              const isSelected = index === selected;
              const [before, match, after] = row.highlight ? splitMatch(row.title, q) : [row.title, "", ""];
              return (
                <div key={row.id}>
                  {groupStart && (
                    <div role="presentation" className="px-2.5 pb-0.5 pt-2.5 text-[10.5px] font-semibold tracking-[0.08em] text-text-muted">
                      {t(GROUP_LABEL_KEYS[row.group])}
                    </div>
                  )}
                  <div
                    id={`palette-row-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    onPointerMove={() => { if (!isSelected) setSelected(index); }}
                    onClick={(event) => runRow(row, wantsNewWindow(event, platform.id === "macos"))}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 ${isSelected ? "bg-accent-bg" : ""}`}
                  >
                    <span className={`flex size-7 shrink-0 items-center justify-center rounded-[7px] ${isSelected ? "bg-bg-surface text-accent-text" : "bg-bg-muted text-text-muted"}`}>
                      {row.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={`truncate text-text-primary ${row.group === "words" ? "font-serif text-[15px] font-semibold" : row.group === "books" ? "font-serif text-[13.5px] font-semibold" : "text-[13px]"}`}>
                        {before}
                        {match && <mark className="bg-transparent text-accent-text">{match}</mark>}
                        {after}
                      </span>
                      {row.subtitle && <span className="truncate text-[11.5px] text-text-muted">{row.subtitle}</span>}
                    </span>
                    {isSelected && <span aria-hidden="true" className="shrink-0 text-[11px] text-text-muted">↵</span>}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-light bg-bg-page px-3.5 py-2 text-[11px] text-text-muted">
          <span className="flex gap-3">
            <span>↑ ↓ {t("palette.hint.move")}</span>
            <span>↵ {t("palette.hint.open")}</span>
            {rows[selected]?.runInNewWindow && (
              <span>{platform.id === "macos" ? "⌘↵" : "Ctrl ↵"} {t("palette.hint.newWindow")}</span>
            )}
          </span>
          <span className="truncate">{t("palette.localOnly")}</span>
        </div>
      </div>
    </div>
  );
}
