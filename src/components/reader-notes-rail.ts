export interface ReaderNoteAnchor {
  anchorKind: "selection" | "word";
  word?: string | null;
  scope?: "book" | "global";
  location: string | null;
  selectedText: string | null;
}

export interface ReaderRailNote {
  id: string;
  location: string | null;
  updated_at: number;
}

export interface ReaderRailNoteLayout {
  id: string;
  top: number;
}

/**
 * How long a card wears its "saved" confirmation, in ms.
 *
 * Saving closes the editor, so a status line inside it would never be read. The
 * confirmation has to appear where the reader's eye lands next — on the card —
 * and then get out of the way on its own.
 */
export const NOTE_SAVED_FLASH_MS = 2500;

/**
 * What the editor's status line is currently saying.
 *
 * `idle` is a note that has never been saved and has nothing typed in it yet:
 * there is neither a save to confirm nor an edit to warn about, and claiming
 * either would be a lie. It renders nothing.
 */
export type ReaderNoteEditorStatus = "idle" | "saving" | "unsaved" | "saved";

export function resolveReaderNoteEditorStatus({ saving, draft, savedContent }: {
  saving: boolean;
  draft: string;
  /** The note as it exists in the database, or null for a note not saved yet. */
  savedContent: string | null;
}): ReaderNoteEditorStatus {
  if (saving) return "saving";
  // Saving trims, so a draft that differs from its saved form only by
  // surrounding whitespace would save to exactly what is already there. Calling
  // that "unsaved edits" would leave the warning lit with nothing to save.
  const pending = draft.trim();
  if (savedContent === null) return pending ? "unsaved" : "idle";
  return pending === savedContent.trim() ? "saved" : "unsaved";
}

/**
 * The page number a card may show, or null when there is nothing honest to show.
 *
 * The reader can only page a location it is currently rendering, so most
 * whole-book list entries resolve to nothing — and a chip is better absent than
 * wrong. Zero and fractions are rejected rather than rounded: both mean the
 * caller failed to resolve a page, not that the page is 0.
 */
export function readerNotePageNumber(page: number | null | undefined): number | null {
  return typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : null;
}

/** The list view fetched fewer notes than the backend reports exist; the user must be told. */
export function isNotesTruncated(total: number, loadedCount: number): boolean {
  return total > loadedCount;
}

/** A new-note draft is scoped to a book and either the saved note or its source location. */
export function readerNoteDraftKey(bookId: string, noteId: string | null, anchor: ReaderNoteAnchor): string {
  const identity = noteId ?? `new:${anchor.anchorKind}:${anchor.location ?? "unanchored"}`;
  return `lantern.readerNotes.draft.v1:${encodeURIComponent(bookId)}:${encodeURIComponent(identity)}`;
}

/**
 * Keeps the cards in reading order and leaves enough vertical space for each card.
 * `anchorPositions` are offsets in the rail's coordinate system, supplied by the
 * reader when it can resolve a CFI to a visible text position.
 */
export function layoutReaderRailNotes(
  notes: ReaderRailNote[],
  anchorPositions: Readonly<Record<string, number | undefined>> = {},
  cardHeight = 150,
  gap = 12,
): ReaderRailNoteLayout[] {
  return [...notes]
    .sort((left, right) => {
      const leftPosition = anchorPositions[left.id];
      const rightPosition = anchorPositions[right.id];
      if (leftPosition != null && rightPosition != null && leftPosition !== rightPosition) return leftPosition - rightPosition;
      if (leftPosition != null) return -1;
      if (rightPosition != null) return 1;
      if (left.location !== right.location) return (left.location ?? "").localeCompare(right.location ?? "");
      return right.updated_at - left.updated_at;
    })
    .reduce<ReaderRailNoteLayout[]>((layout, note) => {
      const requested = anchorPositions[note.id];
      const previous = layout[layout.length - 1];
      const minimum = previous ? previous.top + cardHeight + gap : 0;
      layout.push({ id: note.id, top: Math.max(minimum, requested ?? minimum) });
      return layout;
    }, []);
}
