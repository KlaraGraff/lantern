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
