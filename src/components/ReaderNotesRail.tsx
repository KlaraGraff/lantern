import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronLeft, FileText, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  NOTE_SAVED_FLASH_MS,
  isNotesTruncated,
  layoutReaderRailNotes,
  readerNoteDraftKey,
  readerNotePageNumber,
  resolveReaderNoteEditorStatus,
  type ReaderNoteAnchor,
} from "./reader-notes-rail";

interface Note {
  id: string;
  book_id: string | null;
  anchor_kind: "selection" | "word";
  normalized_word: string | null;
  scope: "book" | "global";
  location: string | null;
  selected_text: string | null;
  content: string;
  content_format: string;
  updated_at: number;
}

interface NotePage { notes: Note[]; total: number; next_cursor: string | null; }

const NOTES_PAGE_SIZE = 100;

export type { ReaderNoteAnchor } from "./reader-notes-rail";

export interface ReaderNotesRailProps {
  bookId: string;
  currentCfi: () => string | null;
  onNavigate: (cfi: string) => void;
  /**
   * Main reader wiring can provide a just-created text selection here. The rail
   * opens an editor with its original CFI/text rather than reconstructing it.
   */
  selectedAnchor?: ReaderNoteAnchor | null;
  onSelectedAnchorHandled?: () => void;
  /** CFI-resolved y offsets, relative to this rail, for visible source text. */
  anchorPositions?: Readonly<Record<string, number | undefined>>;
  /** Resolves a visible source CFI into a y offset relative to the reader body. */
  resolveAnchorPosition?: (cfi: string, layoutKey?: string | number | null) => number | undefined;
  /**
   * Resolves a source CFI into the page it sits on, where the reader can say.
   * Returning nothing simply leaves the card without a page chip.
   */
  resolveAnchorPage?: (cfi: string, layoutKey?: string | number | null) => number | undefined;
  /** Changes whenever the visible Foliate range moves, forcing CFI re-resolution. */
  layoutKey?: string | number | null;
}

type View = "rail" | "index" | "editor";

function noteAnchor(note: Note): ReaderNoteAnchor {
  return {
    anchorKind: note.anchor_kind,
    word: note.normalized_word,
    scope: note.scope,
    location: note.location,
    selectedText: note.selected_text,
  };
}

function fallbackAnchor(currentCfi: string | null): ReaderNoteAnchor {
  return { anchorKind: "selection", scope: "book", location: currentCfi, selectedText: null };
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
    // Private browsing and a full local-storage quota must not block editing.
  }
}

/**
 * Tells the reader body that the set of anchored passages changed, so the faint
 * marks under them are redrawn. Same shape as `highlight-changed`.
 */
function notifyNotesChanged(bookId: string) {
  window.dispatchEvent(new CustomEvent("note-changed", { detail: { bookId } }));
}

function clearDraft(key: string | null) {
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Saving to the database still succeeded even if browser storage is unavailable.
  }
}

export default function ReaderNotesRail({
  bookId,
  currentCfi,
  onNavigate,
  selectedAnchor,
  onSelectedAnchorHandled,
  anchorPositions,
  resolveAnchorPosition,
  resolveAnchorPage,
  layoutKey,
}: ReaderNotesRailProps) {
  const { t, i18n } = useTranslation();
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [view, setView] = useState<View>("rail");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Note | null>(null);
  const [editingAnchor, setEditingAnchor] = useState<ReaderNoteAnchor | null>(null);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // The note whose deletion failed, not a flag: a delete failure is nearly
  // always transient, and retrying has to know what to retry.
  const [deleteFailedNote, setDeleteFailedNote] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const handledSelectionRef = useRef<string | null>(null);
  // Saving closes the editor, so the confirmation has to live on the card the
  // reader is looking at next — and then leave on its own.
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  const savedFlashRef = useRef<number | null>(null);

  const clearSavedFlash = useCallback(() => {
    if (savedFlashRef.current !== null) window.clearTimeout(savedFlashRef.current);
    savedFlashRef.current = null;
  }, []);

  // An unmount mid-flash must not leave a timer holding a setState, and a second
  // save must not be confirmed on the first save's schedule.
  useEffect(() => clearSavedFlash, [clearSavedFlash]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(false);
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
      setTotal(page.total);
      setNextCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await invoke<NotePage>("list_notes", {
        bookId,
        anchorKind: null,
        word: null,
        search: null,
        updatedAfter: null,
        updatedBefore: null,
        cursor: nextCursor,
        limit: NOTES_PAGE_SIZE,
      });
      setNotes((current) => [...current, ...page.notes]);
      setTotal(page.total);
      setNextCursor(page.next_cursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [bookId, loadingMore, nextCursor]);

  const openEditor = useCallback((note: Note | null = null, anchor?: ReaderNoteAnchor) => {
    const nextAnchor = note ? noteAnchor(note) : anchor ?? fallbackAnchor(currentCfi());
    const nextDraftKey = readerNoteDraftKey(bookId, note?.id ?? null, nextAnchor);
    setEditing(note);
    setEditingAnchor(nextAnchor);
    setDraftKey(nextDraftKey);
    setDraft(readDraft(nextDraftKey, note?.content ?? ""));
    setDeleting(null);
    setSaveFailed(false);
    setDeleteFailedNote(null);
    setView("editor");
  }, [bookId, currentCfi]);

  useEffect(() => {
    if (!selectedAnchor) {
      handledSelectionRef.current = null;
      return;
    }
    const identity = `${selectedAnchor.anchorKind}\u0000${selectedAnchor.location ?? ""}\u0000${selectedAnchor.selectedText ?? ""}`;
    if (handledSelectionRef.current === identity) return;
    handledSelectionRef.current = identity;
    openEditor(null, selectedAnchor);
    onSelectedAnchorHandled?.();
  }, [onSelectedAnchorHandled, openEditor, selectedAnchor]);

  const updateDraft = (value: string) => {
    setDraft(value);
    if (draftKey) writeDraft(draftKey, value);
  };

  const closeEditor = () => {
    setDeleting(null);
    setSaveFailed(false);
    setDeleteFailedNote(null);
    setView("rail");
  };

  // Escape leaves the editor/index view without discarding the draft: the
  // draft is already persisted to localStorage on every keystroke, and
  // closeEditor never clears it (only save/delete do). One layer at a time —
  // an open delete confirmation is dismissed first, so Escape never both
  // cancels the confirmation and walks the user out of the note behind it.
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDeleteFailedNote(null);
      if (deleting) {
        setDeleting(null);
        return;
      }
      setSaveFailed(false);
      setView((current) => (current === "rail" ? current : "rail"));
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [deleting]);

  const save = async () => {
    if (!draft.trim() || saving || !editingAnchor) return;
    setSaving(true);
    setSaveFailed(false);
    // A second save cancels the first one's confirmation rather than inheriting
    // its countdown, so the new card is not congratulated for a moment.
    clearSavedFlash();
    setJustSavedId(null);
    try {
      const saved = await invoke<Note>("save_note", {
        // Existing notes deliberately retain their original type, scope, CFI,
        // quoted text, word metadata, and book/global ownership.
        id: editing?.id ?? null,
        bookId: editing ? editing.book_id : bookId,
        anchorKind: editingAnchor.anchorKind,
        word: editingAnchor.word ?? null,
        scope: editingAnchor.scope ?? "book",
        location: editingAnchor.location,
        selectedText: editingAnchor.selectedText,
        content: draft.trim(),
      });
      clearDraft(draftKey);
      await refresh();
      notifyNotesChanged(bookId);
      setView("rail");
      setEditing(null);
      setEditingAnchor(null);
      setDraftKey(null);
      setDraft("");
      setJustSavedId(saved.id);
      savedFlashRef.current = window.setTimeout(() => {
        savedFlashRef.current = null;
        setJustSavedId(null);
      }, NOTE_SAVED_FLASH_MS);
    } catch {
      writeDraft(draftKey ?? readerNoteDraftKey(bookId, editing?.id ?? null, editingAnchor), draft);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note: Note) => {
    setDeleteFailedNote(null);
    try {
      await invoke("delete_note", { id: note.id });
      clearDraft(draftKey);
      await refresh();
      notifyNotesChanged(bookId);
      if (justSavedId === note.id) {
        clearSavedFlash();
        setJustSavedId(null);
      }
      setDeleting(null);
      setEditing(null);
      setEditingAnchor(null);
      setDraftKey(null);
      setDraft("");
      setView("rail");
    } catch {
      setDeleting(null);
      setDeleteFailedNote(note);
    }
  };

  const formatDate = useMemo(() => new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }), [i18n.language]);
  const visible = useMemo(() => notes.filter((note) => `${note.content} ${note.selected_text ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [notes, search]);
  const resolvedAnchorPositions = useMemo(() => {
    const next: Record<string, number | undefined> = { ...anchorPositions };
    if (resolveAnchorPosition) {
      for (const note of notes) {
        if (note.location && next[note.id] == null) {
          next[note.id] = resolveAnchorPosition(note.location, layoutKey);
        }
      }
    }
    return next;
  }, [anchorPositions, layoutKey, notes, resolveAnchorPosition]);
  const anchorPages = useMemo(() => {
    const pages: Record<string, number | null> = {};
    if (!resolveAnchorPage) return pages;
    for (const note of notes) {
      if (note.location) pages[note.id] = readerNotePageNumber(resolveAnchorPage(note.location, layoutKey));
    }
    return pages;
  }, [layoutKey, notes, resolveAnchorPage]);
  const hasPositionProvider = Boolean(anchorPositions || resolveAnchorPosition);
  const railSourceNotes = useMemo(
    () => hasPositionProvider
      ? notes.filter((note) => resolvedAnchorPositions[note.id] != null)
      : notes,
    [hasPositionProvider, notes, resolvedAnchorPositions],
  );
  const railLayout = useMemo(
    () => layoutReaderRailNotes(railSourceNotes, resolvedAnchorPositions),
    [railSourceNotes, resolvedAnchorPositions],
  );
  const railNotes = useMemo(() => railLayout.map(({ id, top }) => ({ note: railSourceNotes.find((candidate) => candidate.id === id)!, top })), [railLayout, railSourceNotes]);
  const railHeight = railLayout.length === 0 ? 0 : railLayout[railLayout.length - 1].top + 162;
  const truncated = isNotesTruncated(total, notes.length);
  const editorStatus = resolveReaderNoteEditorStatus({
    saving,
    draft,
    savedContent: editing?.content ?? null,
  });

  return <aside aria-label={t("readerNotes.title")} className="flex h-full min-h-0 w-full flex-col bg-bg-muted">
    {/* 45px and no bottom rule, like every other traces tab. The tab already
        says "笔记", so only the index view needs to name itself. */}
    <header className="flex h-[45px] shrink-0 items-center gap-2 px-3">
      <div className="min-w-0 flex-1">{view === "index" && <b className="text-[12px] text-text-primary">{t("readerNotes.all")}</b>}<span className={`text-[11px] text-text-muted${view === "index" ? " ml-2" : ""}`}>{t("readerNotes.count", { count: total })}</span></div>
      {view !== "rail" && <button type="button" onClick={closeEditor} aria-label={t("common.back")} className="grid size-7 place-items-center rounded-md text-text-muted hover:bg-bg-input"><ChevronLeft size={16} /></button>}
      <button type="button" onClick={() => openEditor()} aria-label={t("readerNotes.new")} title={t("readerNotes.new")} className="grid size-7 place-items-center rounded-md text-text-muted hover:bg-bg-input"><Plus size={17} /></button>
    </header>
    {error && <div role="alert" className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-danger-bg p-2 text-[11px] text-danger-text"><span className="min-w-0 flex-1">{t("readerNotes.loadFailed")}</span><button type="button" onClick={() => void refresh()} className="font-medium">{t("common.retry")}</button></div>}
    {deleteFailedNote && <div role="alert" className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-danger-bg p-2 text-[11px] text-danger-text"><span className="min-w-0 flex-1">{t("readerNotes.deleteFailed")}</span><button type="button" onClick={() => void remove(deleteFailedNote)} className="font-medium">{t("common.retry")}</button></div>}
    {loading ? <div className="grid min-h-0 flex-1 place-items-center text-text-muted"><Loader2 size={18} className="animate-spin motion-reduce:animate-none" /></div> : view === "editor" ? <div className="min-h-0 flex-1 overflow-auto p-3">
      {saveFailed && <div role="alert" className="mb-3 flex items-center gap-2 rounded-md bg-danger-bg p-2 text-[11px] text-danger-text"><span className="min-w-0 flex-1">{t("readerNotes.saveFailed")}</span><button type="button" disabled={saving} onClick={() => void save()} className="font-medium disabled:opacity-60">{t("common.retry")}</button></div>}
      {editingAnchor?.selectedText && <blockquote className="mb-3 border-l-2 border-accent/40 pl-2 text-[12px] leading-5 text-text-muted">{editingAnchor.selectedText}</blockquote>}
      <div className=""><label className="sr-only" htmlFor="reader-note-draft">{t("learningCard.notes.editorLabel")}</label>
        <textarea id="reader-note-draft" autoFocus value={draft} onChange={(event) => updateDraft(event.target.value)} placeholder={t("learningCard.notes.placeholder")} className="min-h-36 w-full resize-y rounded-lg border border-border bg-bg-surface p-3 text-[13px] leading-6 text-text-primary outline-none focus:border-accent" />
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className={`flex min-w-0 flex-1 items-center gap-1 text-[11px] ${editorStatus === "saved" ? "text-success-text" : "text-text-muted"}`}>
          {editorStatus === "saving" && <><Loader2 size={12} className="animate-spin motion-reduce:animate-none" />{t("readerNotes.saving")}</>}
          {/* The device-local warning is only news while something is unsaved —
              on a note with nothing pending it was a permanent line of noise. */}
          {editorStatus === "unsaved" && `${t("readerNotes.unsavedEdits")} · ${t("readerNotes.localDraft")}`}
          {editorStatus === "saved" && editing && <><Check size={12} />{`${t("readerNotes.saved")} · ${formatDate.format(editing.updated_at)}`}</>}
        </span>
        {editing && <button type="button" disabled={saving} onClick={() => setDeleting(editing.id)} className="grid size-8 place-items-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text disabled:opacity-50" aria-label={t("common.delete")}><Trash2 size={15} /></button>}
        <button type="button" disabled={saving} onClick={closeEditor} className="h-8 px-2 text-[12px] text-text-muted disabled:opacity-50">{t("common.cancel")}</button>
        <button type="button" disabled={!draft.trim() || saving} onClick={() => void save()} className="flex h-8 items-center gap-1 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50">{saving && <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />}{t("common.save")}</button>
      </div>
      {deleting === editing?.id && editing && <div className="mt-3 rounded-lg border border-danger/30 bg-danger-bg p-3 text-[12px] text-danger-text"><b>{t("readerNotes.deleteTitle")}</b><p className="mt-1">{t("readerNotes.deleteDetail")}</p><div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => setDeleting(null)} className="h-7 px-2">{t("common.cancel")}</button><button type="button" onClick={() => void remove(editing)} className="h-7 rounded-md bg-danger px-2 text-white">{t("common.delete")}</button></div></div>}
    </div> : <>
      {view === "index" && <div className="mx-3 mt-3 flex h-8 shrink-0 items-center gap-2 rounded-md bg-bg-input px-2"><Search size={14} className="text-text-muted" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("notes.search")} className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-text-placeholder" /></div>}
      {(view === "rail" ? railSourceNotes.length === 0 : notes.length === 0) ? <div className="grid min-h-0 flex-1 place-items-center p-3 text-center"><div><FileText size={28} className="mx-auto text-text-placeholder" /><p className="mt-3 text-[13px] font-medium text-text-secondary">{t("readerNotes.empty")}</p><p className="mt-1 text-[12px] leading-5 text-text-muted">{t("readerNotes.emptyHint")}</p><button type="button" onClick={() => openEditor()} className="mt-3 rounded-md bg-accent px-3 py-2 text-[12px] font-medium text-white">{t("readerNotes.new")}</button></div></div> : view === "rail" ? <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="relative" style={{ minHeight: railHeight }}>
        {railNotes.map(({ note, top }) => <NoteCard key={note.id} note={note} top={top} page={anchorPages[note.id]} justSaved={justSavedId === note.id} formatDate={formatDate} pageLabel={(page) => t("readerNotes.page", { page })} savedLabel={t("readerNotes.saved")} locateLabel={t("readerNotes.locate")} editLabel={t("common.edit")} onEdit={openEditor} onNavigate={onNavigate} />)}
      </div></div> : <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {visible.map((note) => <NoteCard key={note.id} note={note} page={anchorPages[note.id]} justSaved={justSavedId === note.id} formatDate={formatDate} pageLabel={(page) => t("readerNotes.page", { page })} savedLabel={t("readerNotes.saved")} locateLabel={t("readerNotes.locate")} editLabel={t("common.edit")} onEdit={openEditor} onNavigate={onNavigate} />)}
        {view === "index" && truncated && <div role="status" className="mt-2 rounded-md bg-bg-input p-2 text-center text-[11px] text-text-muted">
          <p>{t("readerNotes.truncated", { loaded: notes.length, total })}</p>
          <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="mt-1.5 inline-flex items-center gap-1 font-medium text-accent-text disabled:opacity-60">
            {loadingMore && <Loader2 size={12} className="animate-spin motion-reduce:animate-none" />}
            {loadingMore ? t("readerNotes.loadingMore") : t("readerNotes.loadMore")}
          </button>
        </div>}
      </div>}
      {view === "rail" && <footer className="shrink-0 border-t border-border p-2"><button type="button" onClick={() => setView("index")} className="w-full rounded-md py-1.5 text-[12px] text-text-muted hover:bg-bg-input">{t("readerNotes.viewAll")}</button></footer>}
    </>}
  </aside>;
}

function NoteCard({ note, top, page, justSaved, formatDate, pageLabel, savedLabel, locateLabel, editLabel, onEdit, onNavigate }: {
  note: Note;
  top?: number;
  /** The page the quoted passage sits on, when the reader can say. */
  page?: number | null;
  /** Wearing the transient confirmation of the save that just landed. */
  justSaved?: boolean;
  formatDate: Intl.DateTimeFormat;
  pageLabel: (page: number) => string;
  savedLabel: string;
  locateLabel: string;
  editLabel: string;
  onEdit: (note: Note) => void;
  onNavigate: (cfi: string) => void;
}) {
  const positioned = top != null;
  return <article style={positioned ? { top } : undefined} className={`group rounded-lg border p-3 shadow-sm ${justSaved ? "border-success/40 bg-success/5" : "border-border bg-bg-surface"} ${positioned ? "absolute inset-x-3 max-h-[150px] overflow-y-auto" : "relative mb-3"}`}>
    {note.selected_text && <button type="button" onClick={() => note.location && onNavigate(note.location)} className="mb-2 block border-l-2 border-accent/40 pl-2 text-left text-[11px] italic leading-5 text-text-muted hover:text-text-primary">{note.selected_text}</button>}
    <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-text-primary">{note.content}</p>
    {/* One line, and it has to stay one line: the chip carries no vertical
        padding and no larger type than the date beside it, so a card is exactly
        as tall with a page number as without one. */}
    <div className="mt-2 flex items-center gap-2 text-[10px] text-text-muted">{page != null && <span className="rounded bg-bg-input px-1.5">{pageLabel(page)}</span>}<span>{formatDate.format(note.updated_at)}</span>{justSaved && <span className="flex items-center gap-0.5 text-success-text"><Check size={11} />{savedLabel}</span>}<span className="min-w-0 flex-1" />{note.location && <button type="button" onClick={() => onNavigate(note.location!)} className="hover:text-accent-text">{locateLabel}</button>}<button type="button" onClick={() => onEdit(note)} aria-label={editLabel} className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"><Pencil size={13} /></button></div>
  </article>;
}
