import { invoke } from "@tauri-apps/api/core";

interface NotePage<T> { notes: T[]; next_cursor: string | null; }

/** Cancellation stops paging and prevents publishing a partial, obsolete list. */
export async function loadReaderNotes<T>(
  bookId: string,
  anchorKind: "selection" | null,
  signal: AbortSignal,
): Promise<T[] | null> {
  const notes: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    if (signal.aborted) return null;
    const page: NotePage<T> = await invoke("list_notes", {
      bookId,
      anchorKind,
      word: null,
      search: null,
      updatedAfter: null,
      updatedBefore: null,
      cursor,
      limit: 500,
    });
    if (signal.aborted) return null;
    notes.push(...page.notes);
    cursor = page.next_cursor;
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error("Repeated note cursor");
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return notes;
}
