import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  Download,
  Loader2,
  MessageSquareQuote,
  Search,
  SearchCheck,
  Trash2,
  Undo2,
} from "lucide-react";
import { useHighlights } from "../hooks/useBookmarks";
import { useAutoHighlights } from "../hooks/useAutoHighlights";
import { loadFoliateModules, type CfiModule } from "../pages/reader/foliate-modules";
import { savedHighlightColor } from "./mark-palette";
import HighlightToolbar from "./HighlightToolbar";
import { timeAgo } from "../utils/timeAgo";
import {
  currentPositionIndex,
  filterMarkRows,
  mergeMarkRows,
  readerNoteDraftKey,
  sortMarkRows,
  type CompareLocation,
  type MarkRow,
  type ReaderNote,
  type ReaderNoteAnchor,
} from "./reader-mark-rows";

export type { ReaderNoteAnchor } from "./reader-mark-rows";

interface NotePage { notes: ReaderNote[]; total: number; next_cursor: string | null; }

const NOTES_PAGE_SIZE = 500;

export interface ReaderNotesPanelProps {
  bookId: string;
  /** Where the reader is right now — the anchor 「记住这里」 keeps. */
  currentCfi: () => string | null;
  onNavigate: (cfi: string) => void;
  /**
   * A selection the reader just asked to write about. The panel opens an editor
   * on its original CFI and quoted text rather than reconstructing either.
   */
  selectedAnchor?: ReaderNoteAnchor | null;
  onSelectedAnchorHandled?: () => void;
  /** Resolves an anchor to the chapter it sits in, where the reader can say. */
  resolveChapter?: (cfi: string) => Promise<string | undefined>;
  onExport?: () => void;
}

/** Identifies the one row whose text is being written. */
interface EditTarget {
  key: string;
  noteId: string | null;
  anchor: ReaderNoteAnchor;
}

function noteAnchor(note: ReaderNote): ReaderNoteAnchor {
  return {
    anchorKind: note.anchor_kind === "position" ? "position" : "selection",
    word: note.normalized_word,
    scope: note.scope === "global" ? "global" : "book",
    location: note.location,
    selectedText: note.anchor_kind === "position" ? null : note.selected_text,
  };
}

function rowTarget(row: MarkRow): EditTarget | null {
  switch (row.kind) {
    case "highlight":
      return {
        key: row.key,
        noteId: row.note?.id ?? null,
        anchor: row.note
          ? noteAnchor(row.note)
          : { anchorKind: "selection", scope: "book", location: row.location, selectedText: row.highlight.text_content },
      };
    case "position":
    case "passage":
      return { key: row.key, noteId: row.note.id, anchor: noteAnchor(row.note) };
    case "auto":
      return null;
  }
}

/** What the reader has already written on this row, if anything. */
function rowWrittenText(row: MarkRow): string {
  switch (row.kind) {
    case "highlight":
      return row.note?.content ?? "";
    case "position":
    case "passage":
      return row.note.content;
    case "auto":
      return "";
  }
}

function readDraft(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeDraft(key: string, value: string) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private browsing and a full quota must not block writing a note.
  }
}

/** Tells the reader body to redraw the faint marks under anchored passages. */
function notifyNotesChanged(bookId: string) {
  window.dispatchEvent(new CustomEvent("note-changed", { detail: { bookId } }));
}

/**
 * Reading-behavior collection treats keeping a place as deliberate engagement
 * with the page, the same as annotating or looking a word up — see
 * `src/pages/reader/reading-behavior.ts`.
 */
function notifyPlaceKept(bookId: string) {
  window.dispatchEvent(new CustomEvent("bookmark-changed", { detail: { bookId } }));
}

/**
 * Everything the reader left in this book, in one column ordered by where it
 * sits in the text.
 *
 * This is the merger of three panels that used to be three tabs: bookmarks,
 * highlights, and notes. They were never three questions — a reader scanning
 * this panel is asking "what did I leave around here", and splitting the answer
 * by which button produced it made them ask it three times. The left-hand cell
 * carries the distinction that survives: a colour bar is a highlight, a
 * bookmark icon is a place kept.
 *
 * 「记住这里」 is the single position-shaped entry point, replacing both
 * 「在此处添加书签」 and 「＋新建笔记」. It writes the row first and focuses an
 * editor on it, so walking away without typing leaves a bookmark rather than
 * nothing — which is what makes it safe to press before you know what you want
 * to say.
 */
export default function ReaderNotesPanel({
  bookId,
  currentCfi,
  onNavigate,
  selectedAnchor,
  onSelectedAnchorHandled,
  resolveChapter,
  onExport,
}: ReaderNotesPanelProps) {
  const { t } = useTranslation();
  const { highlights, refresh: refreshHighlights, remove: removeHighlight, updateColor } = useHighlights(bookId);
  const { autoHighlights, undoable, dismiss, undo, promote } = useAutoHighlights(bookId);
  const [notes, setNotes] = useState<ReaderNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [cfiModule, setCfiModule] = useState<CfiModule | null>(null);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [chapters, setChapters] = useState<Record<string, string>>({});
  const [toolbar, setToolbar] = useState<{ id: string; x: number; y: number } | null>(null);
  const handledSelectionRef = useRef<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // Backstop for the cancel button, which primarily defends itself by refusing
  // mousedown's focus change. Set on its pointerdown so that if a blur happens
  // anyway, that blur can tell "cancel was pressed" apart from "the reader
  // tapped away to save". A one-shot flag, not a mode: it is consumed by
  // whichever of onBlur/closeEditor sees it first, and typing disarms it, so an
  // aborted press that produced no blur cannot go on eating later ones.
  const discardingRef = useRef(false);

  const refreshNotes = useCallback(async () => {
    try {
      const page = await invoke<NotePage>("list_notes", {
        bookId,
        anchorKind: null,
        word: null,
        search: null,
        updatedAfter: null,
        updatedBefore: null,
        cursor: null,
        limit: NOTES_PAGE_SIZE,
      });
      setNotes(page.notes);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { void refreshNotes(); }, [refreshNotes]);

  // epubcfi.js lives in /public, so it arrives through the module bridge rather
  // than a bundled import. Until it lands the list still renders — just dated
  // rather than ordered by place.
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
      // A location this book's engine does not write as a CFI — say so rather
      // than inventing an order for it.
      return null;
    }
  }, [cfiModule]);

  const rows = useMemo(
    () => sortMarkRows(mergeMarkRows(highlights, notes, autoHighlights), compareLocation),
    [autoHighlights, compareLocation, highlights, notes],
  );
  const visible = useMemo(() => filterMarkRows(rows, search), [rows, search]);
  const hereIndex = useMemo(
    () => currentPositionIndex(visible, currentCfi(), compareLocation),
    // `currentCfi` is a live ref reader; the layout key it depends on is the
    // row set, which already changes whenever the panel has anything new to say.
    [compareLocation, currentCfi, visible],
  );
  const undoableAnchors = useMemo(() => new Set(undoable), [undoable]);

  // Chapter labels for kept places: a bare CFI says nothing, and the TOC lookup
  // is async, so each one is resolved once and remembered.
  useEffect(() => {
    if (!resolveChapter) return;
    let cancelled = false;
    const wanted = rows
      .filter((row) => row.kind === "position" && row.location && !(row.location in chapters))
      .map((row) => row.location!);
    if (wanted.length === 0) return;
    void Promise.all(wanted.map(async (cfi) => [cfi, await resolveChapter(cfi).catch(() => undefined)] as const))
      .then((resolved) => {
        if (cancelled) return;
        setChapters((current) => {
          const next = { ...current };
          for (const [cfi, label] of resolved) next[cfi] = label ?? "";
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [chapters, resolveChapter, rows]);

  const openEditor = useCallback((target: EditTarget, initial: string) => {
    setConfirmingKey(null);
    setSaveFailed(false);
    setEditing(target);
    setDraft(readDraft(readerNoteDraftKey(bookId, target.noteId, target.anchor), initial));
  }, [bookId]);

  // The selection menu's 「记笔记」 hands the panel a range to write about.
  useEffect(() => {
    if (!selectedAnchor) {
      handledSelectionRef.current = null;
      return;
    }
    const identity = `${selectedAnchor.anchorKind}\u0000${selectedAnchor.location ?? ""}\u0000${selectedAnchor.selectedText ?? ""}`;
    if (handledSelectionRef.current === identity) return;
    handledSelectionRef.current = identity;
    const existing = notes.find(
      (note) => note.anchor_kind === "selection" && note.location && note.location === selectedAnchor.location,
    );
    openEditor(
      { key: existing ? `n:${existing.id}` : "new", noteId: existing?.id ?? null, anchor: selectedAnchor },
      existing?.content ?? "",
    );
    onSelectedAnchorHandled?.();
  }, [notes, onSelectedAnchorHandled, openEditor, selectedAnchor]);

  // 「记住这里」 opens this empty, so the caret has nowhere to go; on a note that
  // already says something it belongs after the last word, not before the first.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editing || !editor) return;
    editor.focus();
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }, [editing]);

  const updateDraft = (value: string) => {
    // Typing is the clearest possible statement that this is not a cancel, so
    // it disarms the flag — an aborted press that never produced a blur to
    // consume it cannot then eat the save that follows the next tap away.
    discardingRef.current = false;
    setDraft(value);
    if (editing) writeDraft(readerNoteDraftKey(bookId, editing.noteId, editing.anchor), value);
  };

  const closeEditor = () => {
    // Every path here means "this text is not being kept" — cancel, Escape, an
    // empty new note, a deleted row. The stored draft has to go with it:
    // `openEditor` prefers the draft over the saved note, so a kept one would
    // hand the discarded text straight back the next time this note opens, and
    // the first tap away would commit it.
    if (editing) writeDraft(readerNoteDraftKey(bookId, editing.noteId, editing.anchor), "");
    discardingRef.current = false;
    setEditing(null);
    setDraft("");
    setSaveFailed(false);
  };

  /**
   * Commits whatever is in the editor. Emptying a note deletes it — the row it
   * was written on is a highlight or a kept place, and both outlive the text.
   * A position note is the exception: an empty one is a bookmark, not a
   * deletion, so it is written as the empty string and kept.
   */
  const commit = async () => {
    if (!editing || saving) return;
    const target = editing;
    const content = draft.trim();
    const unchangedFromEmpty = !content && !target.noteId;
    if (unchangedFromEmpty) {
      closeEditor();
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    try {
      if (!content && target.noteId && target.anchor.anchorKind !== "position") {
        await invoke("delete_note", { id: target.noteId });
      } else {
        await invoke("save_note", {
          id: target.noteId,
          bookId,
          anchorKind: target.anchor.anchorKind,
          word: target.anchor.word ?? null,
          scope: target.anchor.scope ?? "book",
          location: target.anchor.location,
          selectedText: target.anchor.anchorKind === "position" ? null : target.anchor.selectedText,
          content,
        });
      }
      writeDraft(readerNoteDraftKey(bookId, target.noteId, target.anchor), "");
      await refreshNotes();
      notifyNotesChanged(bookId);
      setEditing(null);
      setDraft("");
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 「记住这里」 — the one position-shaped entry point. The row is written
   * before the editor opens, so a reader who presses it and reads on has kept
   * the place; the editor is an offer, not a requirement.
   */
  const keepThisPlace = async () => {
    const cfi = currentCfi();
    if (!cfi || saving) return;
    setSaving(true);
    try {
      const note = await invoke<ReaderNote>("save_note", {
        id: null,
        bookId,
        anchorKind: "position",
        word: null,
        scope: "book",
        location: cfi,
        selectedText: null,
        content: "",
      });
      await refreshNotes();
      notifyPlaceKept(bookId);
      notifyNotesChanged(bookId);
      openEditor({ key: `p:${note.id}`, noteId: note.id, anchor: noteAnchor(note) }, "");
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (row: MarkRow) => {
    setConfirmingKey(null);
    try {
      if (row.kind === "highlight") {
        if (row.note) await invoke("delete_note", { id: row.note.id });
        await removeHighlight(row.highlight.id);
      } else if (row.kind === "position" || row.kind === "passage") {
        await invoke("delete_note", { id: row.note.id });
      }
      if (editing?.key === row.key) closeEditor();
      await refreshNotes();
      notifyNotesChanged(bookId);
    } catch {
      setFailed(true);
    }
  };

  const keepAuto = async (anchor: string) => {
    try {
      await promote(anchor);
      await refreshHighlights();
    } catch {
      setFailed(true);
    }
  };

  const toolbarTarget = toolbar ? highlights.find((h) => h.id === toolbar.id) ?? null : null;
  const toolbarNote = toolbarTarget
    ? rows.find((row) => row.kind === "highlight" && row.highlight.id === toolbarTarget.id)
    : undefined;
  const toolbarNoteContent = toolbarNote?.kind === "highlight" ? toolbarNote.note : null;

  const editor = () => (
    <div className="mt-1.5">
      <textarea
        ref={editorRef}
        value={draft}
        rows={3}
        onChange={(event) => updateDraft(event.target.value)}
        onBlur={() => {
          // A press on the cancel button below reaches here first (pointerdown
          // fires before the focus change that produces this blur). Consume the
          // flag and skip the commit — the cancel button's own onClick is what
          // actually discards and closes.
          if (discardingRef.current) {
            discardingRef.current = false;
            return;
          }
          void commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); closeEditor(); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commit(); }
        }}
        placeholder={t("notes.writePlaceholder")}
        className="w-full resize-y rounded-md border border-accent/40 bg-bg-surface p-2 text-[12.5px] leading-5 text-text-primary outline-none focus:border-accent"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-[10.5px] text-text-muted">
          {saving && <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />}
          {saveFailed ? t("notes.saveFailed") : t("notes.editHint")}
        </p>
        <button
          type="button"
          // The focus change is what produces the blur, and it is `mousedown`'s
          // default action — on iOS a synthetic one that arrives after the
          // pointer events. Refusing it keeps focus in the textarea, so there
          // is no blur and no commit to race. The flag below is the fallback
          // for anywhere that ignores the preventDefault.
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={() => { discardingRef.current = true; }}
          onClick={closeEditor}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-text-muted hover:bg-bg-input hover:text-text-primary touch:min-h-11 touch:px-2.5"
        >
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <div className="flex h-[45px] shrink-0 items-center gap-2 px-3">
        <div className="flex h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-md bg-bg-input px-2">
          <Search size={12} className="shrink-0 text-text-muted" />
          <input
            type="text"
            placeholder={t("common.search")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-text-primary outline-none placeholder:text-text-placeholder"
          />
        </div>
        <button
          type="button"
          onClick={() => void keepThisPlace()}
          className="flex h-[28px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-bg-input px-2.5 hover:bg-border"
        >
          <Bookmark size={14} className="text-text-primary" />
          <span className="text-[12.5px] font-medium tracking-[-0.15px] text-text-primary">{t("notes.keepThisPlace")}</span>
        </button>
        {onExport && (
          <button type="button" onClick={onExport} title={t("readerExport.open")} aria-label={t("readerExport.open")} className="grid size-7 touch:size-11 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-bg-input hover:text-text-primary">
            <Download size={15} />
          </button>
        )}
      </div>

      {failed && (
        <div role="alert" className="mx-3 mb-2 flex items-center gap-2 rounded-md bg-danger-bg p-2 text-[11px] text-danger-text">
          <span className="min-w-0 flex-1">{t("notes.loadFailed")}</span>
          <button type="button" onClick={() => void refreshNotes()} className="font-medium">{t("common.retry")}</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {editing?.key === "new" && (
          <div className="border-b border-border px-3 py-2.5">
            {editing.anchor.selectedText && (
              <blockquote className="mb-1.5 border-l-2 border-accent/40 pl-2 text-[11.5px] leading-5 text-text-muted">
                {editing.anchor.selectedText}
              </blockquote>
            )}
            {editor()}
          </div>
        )}
        {loading ? (
          <div className="grid min-h-[120px] place-items-center text-text-muted">
            <Loader2 size={18} className="animate-spin motion-reduce:animate-none" />
          </div>
        ) : visible.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <div className="mx-auto grid size-[46px] place-items-center rounded-full bg-bg-input">
              <Bookmark size={19} className="text-text-muted" />
            </div>
            <p className="mt-2.5 text-[13px] text-text-secondary">
              {rows.length === 0 ? t("notes.readerEmpty") : t("notes.noMatch")}
            </p>
            {rows.length === 0 && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-muted">{t("notes.readerEmptyHint")}</p>
            )}
          </div>
        ) : (
          visible.map((row, index) => (
            <div key={row.key}>
              {index === hereIndex && (
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <span className="h-px flex-1 bg-accent/30" />
                  <span className="text-[10.5px] text-accent-text">{t("notes.youAreHere")}</span>
                  <span className="h-px flex-1 bg-accent/30" />
                </div>
              )}
              <MarkRowView
                row={row}
                chapter={row.location ? chapters[row.location] : undefined}
                editing={editing?.key === row.key ? editing : null}
                editor={editor}
                confirming={confirmingKey === row.key}
                undoPending={row.kind === "auto" && undoableAnchors.has(row.auto.anchor)}
                onNavigate={onNavigate}
                onWrite={() => {
                  const target = rowTarget(row);
                  if (!target) return;
                  openEditor(target, rowWrittenText(row));
                }}
                onOpenColors={(x, y) => {
                  if (row.kind !== "highlight") return;
                  setToolbar((current) => (current?.id === row.highlight.id ? null : { id: row.highlight.id, x, y }));
                }}
                onConfirmDelete={() => setConfirmingKey(row.key)}
                onCancelDelete={() => setConfirmingKey(null)}
                onDelete={() => void deleteRow(row)}
                onKeepAuto={() => row.kind === "auto" && void keepAuto(row.auto.anchor)}
                onDismissAuto={() => row.kind === "auto" && void dismiss(row.auto.anchor)}
                onUndoAuto={() => row.kind === "auto" && void undo(row.auto.anchor)}
              />
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 pb-3 pt-[11px]">
        <p className="text-center text-[11px] tracking-[0.06px] text-text-muted">
          {t("notes.readerCount", { count: rows.length })}
        </p>
      </div>

      {toolbarTarget && toolbar && (
        <HighlightToolbar
          key={toolbarTarget.id}
          x={toolbar.x}
          y={toolbar.y}
          color={toolbarTarget.color}
          note={toolbarNoteContent?.content ?? null}
          onChangeColor={(color) => updateColor(toolbarTarget.id, color)}
          onSaveNote={(value) => {
            const body = value.trim();
            void (async () => {
              if (!body && toolbarNoteContent) await invoke("delete_note", { id: toolbarNoteContent.id });
              else if (body) {
                await invoke("save_note", {
                  id: toolbarNoteContent?.id ?? null,
                  bookId,
                  anchorKind: "selection",
                  word: null,
                  scope: "book",
                  location: toolbarTarget.cfi_range,
                  selectedText: toolbarTarget.text_content,
                  content: body,
                });
              }
              await refreshNotes();
              notifyNotesChanged(bookId);
            })();
          }}
          onDeleteNote={() => {
            void (async () => {
              if (toolbarNoteContent) await invoke("delete_note", { id: toolbarNoteContent.id });
              await refreshNotes();
              notifyNotesChanged(bookId);
              setToolbar(null);
            })();
          }}
          onDeleteHighlight={() => { removeHighlight(toolbarTarget.id); setToolbar(null); }}
          onClose={() => setToolbar(null)}
        />
      )}
    </div>
  );
}

interface MarkRowViewProps {
  row: MarkRow;
  chapter?: string;
  /** Non-null when this row is the one being written on. */
  editing: EditTarget | null;
  editor: () => React.ReactNode;
  confirming: boolean;
  undoPending: boolean;
  onNavigate: (cfi: string) => void;
  onWrite: () => void;
  onOpenColors: (x: number, y: number) => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onKeepAuto: () => void;
  onDismissAuto: () => void;
  onUndoAuto: () => void;
}

/**
 * One line. The left cell is the only thing that says what kind of mark this
 * is, and it says it without a word: a colour bar is a highlight in that
 * colour, a bookmark icon is a place kept, a faint underline is a range the
 * reader never drew.
 */
function MarkRowView({
  row, chapter, editing, editor, confirming, undoPending,
  onNavigate, onWrite, onOpenColors, onConfirmDelete, onCancelDelete, onDelete,
  onKeepAuto, onDismissAuto, onUndoAuto,
}: MarkRowViewProps) {
  const { t } = useTranslation();

  if (row.kind === "auto" && undoPending) {
    return (
      <div className="flex items-center gap-3 py-3 pl-[18px] pr-4">
        <div className="min-w-0 flex-1 truncate text-[12.5px] text-text-muted">{t("bookmarks.highlightsHidden")}</div>
        <button onClick={onUndoAuto} className="flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium text-accent-text hover:bg-accent-bg">
          <Undo2 size={13} />
          {t("common.undo")}
        </button>
      </div>
    );
  }

  const quote = row.kind === "highlight"
    ? row.highlight.text_content
    : row.kind === "auto"
      ? row.auto.text
      : row.kind === "passage"
        ? row.note.selected_text
        : null;
  const body = row.kind === "highlight" ? row.note?.content ?? "" : row.kind === "auto" ? "" : row.note.content;
  const when = row.kind === "highlight"
    ? row.note?.updated_at ?? row.highlight.updated_at
    : row.kind === "auto"
      ? row.auto.created_at
      : row.note.updated_at;
  const AutoIcon = row.kind === "auto" && row.auto.source === "lookup" ? SearchCheck : MessageSquareQuote;

  return (
    <article className="group flex items-start gap-3 py-2.5 pl-3 pr-3 hover:bg-bg-input/60">
      <div className="mt-1 flex w-4 shrink-0 justify-center">
        {row.kind === "highlight" ? (
          <button
            type="button"
            aria-label={t("bookmarks.highlightEditButton")}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenColors(rect.left, rect.top);
            }}
            className="h-[26px] w-[4px] cursor-pointer rounded-full"
            style={{ backgroundColor: savedHighlightColor[row.highlight.color] ?? savedHighlightColor.yellow }}
          />
        ) : row.kind === "position" ? (
          <Bookmark size={14} className="text-text-muted" />
        ) : row.kind === "auto" ? (
          <span className="mt-2 block h-[3px] w-4 rounded-full bg-text-muted/45" />
        ) : (
          <span className="block h-[26px] w-[4px] rounded-full bg-border" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {row.kind === "position" ? (
          <button
            type="button"
            onClick={() => row.location && onNavigate(row.location)}
            className="block max-w-full truncate text-left text-[12.5px] font-medium text-text-primary hover:text-accent-text"
          >
            {chapter || t("notes.keptPlace")}
          </button>
        ) : quote ? (
          <button
            type="button"
            onClick={() => row.location && onNavigate(row.location)}
            className="block w-full text-left"
          >
            <span className="line-clamp-2 text-[12.5px] leading-5 text-text-primary">&ldquo;{quote}&rdquo;</span>
          </button>
        ) : null}

        {editing ? (
          editor()
        ) : row.kind === "auto" ? null : body ? (
          <button type="button" onClick={onWrite} className="mt-1 block w-full text-left">
            <span className="line-clamp-3 whitespace-pre-wrap break-words text-[12px] leading-5 text-text-secondary">{body}</span>
          </button>
        ) : (
          <button type="button" onClick={onWrite} className="mt-1 block text-left text-[11.5px] text-text-placeholder hover:text-accent-text">
            {t("notes.writeSomething")}
          </button>
        )}

        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-text-muted">
          {row.kind === "auto" && (
            <span className="flex items-center gap-1">
              <AutoIcon size={11} />
              {row.auto.source === "lookup" && row.auto.label
                ? t("bookmarks.highlightsFromLookup", { word: row.auto.label })
                : t("bookmarks.highlightsFromChat")}
            </span>
          )}
          <span>{timeAgo(when)}</span>
        </div>

        {confirming && (
          <div className="mt-1.5 rounded-md border border-danger-border bg-danger-bg p-2">
            <p className="text-[11px] font-medium text-danger-text">
              {t(row.kind === "position" ? "notes.deletePlaceTitle" : "notes.deleteMarkTitle")}
            </p>
            <p className="mt-0.5 text-[10.5px] leading-[1.55] text-danger-text/80">
              {t(row.kind === "position" ? "notes.deletePlaceBody" : "notes.deleteMarkBody")}
            </p>
            <div className="mt-1.5 flex justify-end gap-1.5">
              <button type="button" onClick={onCancelDelete} className="h-6 rounded-md border border-danger-border bg-bg-surface px-2 text-[10.5px] text-danger-text">{t("common.cancel")}</button>
              <button type="button" onClick={onDelete} className="h-6 rounded-md bg-danger px-2 text-[10.5px] text-white">{t("common.delete")}</button>
            </div>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100">
        {row.kind === "auto" ? (
          <>
            <button type="button" onClick={onKeepAuto} className="cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium text-accent-text hover:bg-accent-bg">
              {t("bookmarks.highlightsKeep")}
            </button>
            <button type="button" onClick={onDismissAuto} className="cursor-pointer rounded-md px-1.5 py-1 text-[11px] text-text-muted hover:bg-bg-surface hover:text-text-primary">
              {t("bookmarks.highlightsDismiss")}
            </button>
          </>
        ) : (
          <button type="button" onClick={onConfirmDelete} aria-label={t("common.delete")} className="rounded p-1 text-text-muted hover:bg-bg-surface hover:text-danger-text">
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </article>
  );
}
