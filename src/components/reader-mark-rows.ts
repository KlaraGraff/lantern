import type { Highlight } from "../hooks/useBookmarks";
import type { AutoHighlight } from "../hooks/useAutoHighlights";

/**
 * What a note is fastened to.
 *
 * `position` is a place in the book and nothing else — the merged 书签 /
 * 独立笔记. Its `content` may be the empty string, which is the whole point:
 * keeping a place is worth doing before you know whether you have anything to
 * say about it.
 */
export interface ReaderNoteAnchor {
  anchorKind: "selection" | "word" | "position";
  word?: string | null;
  scope?: "book" | "global";
  location: string | null;
  selectedText: string | null;
}

/** A draft is scoped to a book and either the saved note or its source location. */
export function readerNoteDraftKey(bookId: string, noteId: string | null, anchor: ReaderNoteAnchor): string {
  const identity = noteId ?? `new:${anchor.anchorKind}:${anchor.location ?? "unanchored"}`;
  return `lantern.readerNotes.draft.v1:${encodeURIComponent(bookId)}:${encodeURIComponent(identity)}`;
}

/**
 * A `notes` row as the reader panel reads it. `anchor_kind` is deliberately a
 * plain string: the panel keeps only the kinds it renders and drops the rest,
 * so a kind it has never heard of is skipped rather than mis-drawn.
 */
export interface ReaderNote {
  id: string;
  book_id: string | null;
  anchor_kind: string;
  normalized_word: string | null;
  scope: string;
  location: string | null;
  selected_text: string | null;
  content: string;
  created_at: number;
  updated_at: number;
}

/**
 * One line in the reader's 笔记 panel.
 *
 * Bookmarks and highlights are one column ordered by where they sit in the
 * book, not two lists and not two tabs: the reader is looking for "the thing I
 * left around here", and which of the two it was is answered by the left-hand
 * cell, not by having to pick a tab first. Whether anything was written on it
 * is likewise not a category — an empty bookmark and a bookmark with a
 * paragraph under it are the same object at different moments.
 */
export type MarkRow =
  /** A range the reader drew, with whatever they wrote on it. */
  | { kind: "highlight"; key: string; location: string; sortedAt: number; highlight: Highlight; note: ReaderNote | null }
  /** A place the reader kept — the merged 书签 / 独立笔记. */
  | { kind: "position"; key: string; location: string | null; sortedAt: number; note: ReaderNote }
  /** Text written about a passage that carries no highlight of its own. */
  | { kind: "passage"; key: string; location: string | null; sortedAt: number; note: ReaderNote }
  /** A range nobody drew, derived from a lookup or a quote. */
  | { kind: "auto"; key: string; location: string; sortedAt: number; auto: AutoHighlight };

/** Compares two anchors by their place in the book, or null when it cannot. */
export type CompareLocation = (left: string, right: string) => number | null;

/**
 * The note that speaks for an anchor: the most recently updated one, which is
 * the same one the annotations timeline folds in. Any older note at the same
 * anchor stays a row of its own rather than disappearing.
 */
function foldSelectionNotes(notes: readonly ReaderNote[]): Map<string, ReaderNote> {
  const byLocation = new Map<string, ReaderNote>();
  for (const note of notes) {
    if (note.anchor_kind !== "selection" || !note.location) continue;
    const held = byLocation.get(note.location);
    if (!held || note.updated_at > held.updated_at || (note.updated_at === held.updated_at && note.id > held.id)) {
      byLocation.set(note.location, note);
    }
  }
  return byLocation;
}

export function mergeMarkRows(
  highlights: readonly Highlight[],
  notes: readonly ReaderNote[],
  autos: readonly AutoHighlight[],
): MarkRow[] {
  const spokenFor = foldSelectionNotes(notes);
  const attached = new Set<string>();
  const rows: MarkRow[] = [];

  for (const highlight of highlights) {
    const note = spokenFor.get(highlight.cfi_range) ?? null;
    if (note) attached.add(note.id);
    rows.push({
      kind: "highlight",
      key: `h:${highlight.id}`,
      location: highlight.cfi_range,
      sortedAt: Math.max(highlight.updated_at, note?.updated_at ?? highlight.updated_at),
      highlight,
      note,
    });
  }

  for (const note of notes) {
    // Words are the vocabulary page's business, in the reader as well as in the
    // library. One thing, one home.
    if (note.anchor_kind === "word") continue;
    if (note.anchor_kind === "position") {
      rows.push({ kind: "position", key: `p:${note.id}`, location: note.location, sortedAt: note.updated_at, note });
      continue;
    }
    if (note.anchor_kind !== "selection" || attached.has(note.id)) continue;
    rows.push({ kind: "passage", key: `n:${note.id}`, location: note.location, sortedAt: note.updated_at, note });
  }

  for (const auto of autos) {
    rows.push({ kind: "auto", key: `a:${auto.anchor}`, location: auto.cfi, sortedAt: auto.created_at, auto });
  }

  return rows;
}

/**
 * Reading order. Anchors the CFI module cannot place fall to the bottom, newest
 * first — a row with an unreadable anchor still has a date, and burying it
 * mid-list where nothing explains its position would be worse than parking it.
 */
export function sortMarkRows(rows: readonly MarkRow[], compare: CompareLocation): MarkRow[] {
  return [...rows].sort((left, right) => {
    if (left.location && right.location) {
      const order = compare(left.location, right.location);
      if (order != null && order !== 0) return order;
      if (order != null) return right.sortedAt - left.sortedAt || left.key.localeCompare(right.key);
    }
    if (left.location && !right.location) return -1;
    if (!left.location && right.location) return 1;
    return right.sortedAt - left.sortedAt || left.key.localeCompare(right.key);
  });
}

/**
 * Where 「你现在读到这里」 goes: the index of the first row at or after the
 * reader's current position. Returns null when there is nothing to divide —
 * no current position, an unplaceable one, or a marker that would land at an
 * end of the list and separate nothing from anything.
 */
export function currentPositionIndex(
  rows: readonly MarkRow[],
  currentCfi: string | null,
  compare: CompareLocation,
): number | null {
  if (!currentCfi) return null;
  let index: number | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    const location = rows[i].location;
    if (!location) break;
    const order = compare(currentCfi, location);
    if (order == null) return null;
    if (order <= 0) {
      index = i;
      break;
    }
  }
  if (index === null) index = rows.findIndex((row) => !row.location);
  if (index < 0) index = rows.length;
  return index === 0 || index === rows.length ? null : index;
}

export function markRowText(row: MarkRow): string {
  switch (row.kind) {
    case "highlight":
      return `${row.highlight.text_content ?? ""} ${row.note?.content ?? ""}`;
    case "auto":
      return `${row.auto.text} ${row.auto.label ?? ""}`;
    default:
      return `${row.note.selected_text ?? ""} ${row.note.content}`;
  }
}

export function filterMarkRows(rows: readonly MarkRow[], search: string): MarkRow[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((row) => markRowText(row).toLowerCase().includes(needle));
}
