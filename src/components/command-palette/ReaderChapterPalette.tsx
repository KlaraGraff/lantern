import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Search } from "lucide-react";
import { chapterMatches, initialChapterIndex, splitMatch, wrapIndex, type PaletteChapter } from "./palette-model";

interface ReaderChapterPaletteProps {
  open: boolean;
  chapters: readonly PaletteChapter[];
  /** 1-based, matching `PaletteChapter.page`. */
  currentPage: number;
  onJump: (page: number) => void;
  onClose: () => void;
}

/**
 * ⌘K inside a book: jump to a chapter by typing part of its title. The library
 * palette is not mounted on `/reader` — its book, word and workspace actions
 * all lead out of the book — so this one only answers "where in this book".
 * Same surface as `CommandPalette`; the jump goes through the TOC's own handler.
 */
export default function ReaderChapterPalette({ open, chapters, currentPage, onJump, onClose }: ReaderChapterPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => chapterMatches(chapters, query), [chapters, query]);

  // Each opening starts clean, on the chapter being read. Focus goes back to
  // the page on close so the arrow keys turn pages again.
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelected(initialChapterIndex(chapterMatches(chapters, ""), currentPage));
    window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => { returnTo?.focus?.({ preventScroll: true }); };
    // Only an opening resets; the chapter list settling while open must not move the highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);

  if (!open) return null;

  const jump = (row: PaletteChapter | undefined) => {
    if (!row) return;
    onClose();
    onJump(row.page);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => wrapIndex(index, event.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      jump(rows[selected]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const q = query.trim();
  const activeId = rows[selected] ? `chapter-palette-row-${selected}` : undefined;

  return (
    <div
      className="motion-scrim fixed inset-0 z-[70] flex justify-center bg-overlay px-4 pt-[12vh]"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.chapters.label")}
        onKeyDown={onKeyDown}
        // Keep focus in the field: a click on the hint bar or the empty text
        // would otherwise drop it to the page, where Esc and ↑↓ stop reaching here.
        onMouseDown={(event) => { if (event.target !== inputRef.current) event.preventDefault(); }}
        className="motion-palette flex h-fit max-h-[76vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[14px] border border-border bg-bg-surface shadow-popover"
      >
        <label className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border-light px-4">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="chapter-palette-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setSelected(0); }}
            placeholder={t("palette.chapters.placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-placeholder"
          />
          <kbd className="shrink-0 rounded border border-border bg-bg-page px-1.5 py-px font-sans text-[10.5px] text-text-muted">esc</kbd>
        </label>

        <div ref={listRef} id="chapter-palette-list" role="listbox" aria-label={t("palette.chapters.label")} className="min-h-0 overflow-y-auto px-1.5 pb-2 pt-1.5">
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-text-muted">{t("palette.empty")}</p>
          ) : (
            rows.map((row, index) => {
              const isSelected = index === selected;
              const isCurrent = row.page === currentPage;
              const [before, match, after] = splitMatch(row.title, q);
              return (
                <div
                  key={row.page}
                  id={`chapter-palette-row-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={isSelected}
                  aria-current={isCurrent ? "location" : undefined}
                  onPointerMove={() => { if (!isSelected) setSelected(index); }}
                  onClick={() => jump(row)}
                  className={`flex cursor-pointer items-center gap-3 rounded-lg py-2 pr-2.5 ${isSelected ? "bg-accent-bg" : ""}`}
                  // Indent follows the TOC only while browsing; matches are a flat list.
                  style={{ paddingLeft: 10 + (q ? 0 : Math.min(row.depth, 4) * 14) }}
                >
                  {isCurrent && <BookOpen size={14} aria-hidden="true" className="shrink-0 text-accent-text" />}
                  <span className={`min-w-0 flex-1 truncate font-serif text-[14px] ${isCurrent ? "font-semibold text-accent-text" : "text-text-primary"}`}>
                    {before}
                    {match && <mark className="bg-transparent text-accent-text">{match}</mark>}
                    {after}
                  </span>
                  {isCurrent && <span className="shrink-0 text-[11px] text-text-muted">{t("palette.chapters.current")}</span>}
                  {isSelected && <span aria-hidden="true" className="shrink-0 text-[11px] text-text-muted">↵</span>}
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3 border-t border-border-light bg-bg-page px-3.5 py-2 text-[11px] text-text-muted">
          <span>↑ ↓ {t("palette.hint.move")}</span>
          <span>↵ {t("palette.chapters.jump")}</span>
        </div>
      </div>
    </div>
  );
}
