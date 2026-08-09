import { useMemo } from "react";
import { useAllChats } from "../../hooks/useChats";
import { useExplanations } from "../../hooks/useExplanations";
import { toChatEntry, toExplanationEntry, type QaEntry } from "./types";

export interface QaBookOption {
  id: string;
  title: string;
}

/**
 * Merges the two sources — chats (fully loaded, no pagination) and
 * explanations (cursor-paginated, `useExplanations`'s own concern) — into
 * one list sorted newest-first by `updated_at`.
 *
 * Safe-merge rule: while explanations still has an unfetched older page
 * (`hasMore`), chats older than the oldest *already-loaded* explanation are
 * held back. Every chat is fetched up front, so without this cutoff a chat
 * from three months ago would render immediately while an explanation from
 * yesterday sits unfetched behind the cursor — wrong order. The cutoff
 * guarantees anything below it hasn't been fully accounted for yet, so it's
 * simply not shown.
 *
 * Clicking "load more" only ever fetches another explanations page; chats
 * need no fetch, they were already in memory. Because everything newly
 * revealed (the new explanation page *and* the chats the old cutoff was
 * hiding) is by construction older than everything already on screen, it
 * always lands at the *bottom* of the list, never spliced into the middle.
 * Once explanations run out (`hasMore` false), the cutoff lifts entirely and
 * every remaining chat is shown.
 */
export function useQaTimeline(search: string, bookId: string) {
  const { chats, remove: removeChat } = useAllChats();
  const {
    items: explanationItems,
    total: explanationTotal,
    books: explanationBooks,
    hasMore,
    loadingMore,
    refresh: refreshExplanations,
    loadMore: loadMoreExplanations,
    remove: moveOutExplanation,
  } = useExplanations();

  const filteredChats = useMemo(() => {
    let result = chats;
    const q = search.trim().toLowerCase();
    // Title and last message are everything a `ChatSummary` carries of what
    // was said; the rest of the thread isn't in memory and fetching every
    // message of every chat to search it is not worth what it costs. The
    // no-result copy says so rather than promising a full-text search.
    if (q) {
      result = result.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          (c.last_message?.toLowerCase().includes(q) ?? false),
      );
    }
    if (bookId) result = result.filter((c) => c.book_id === bookId);
    return result;
  }, [chats, search, bookId]);

  const cutoff = useMemo(() => {
    if (!hasMore) return -Infinity;
    let min = Infinity;
    for (const item of explanationItems) min = Math.min(min, item.updated_at);
    // No loaded explanation means no basis for a cutoff, so there is nothing
    // to hold chats back against — show them all. Reachable: `remove` drops
    // rows from `items` locally without touching the cursor, so moving out
    // every explanation on the loaded page leaves `items` empty while
    // `hasMore` is still true. Left as `Infinity`, that comparison is false
    // for every chat and the whole list would silently empty out.
    return min === Infinity ? -Infinity : min;
  }, [hasMore, explanationItems]);

  const entries = useMemo<QaEntry[]>(() => {
    const merged: QaEntry[] = [
      ...filteredChats.filter((c) => c.updated_at >= cutoff).map(toChatEntry),
      ...explanationItems.map(toExplanationEntry),
    ];
    merged.sort((a, b) => b.updated_at - a.updated_at);
    return merged;
  }, [filteredChats, explanationItems, cutoff]);

  const bookOptions = useMemo<QaBookOption[]>(() => {
    const map = new Map<string, string>();
    for (const chat of chats) {
      if (!map.has(chat.book_id)) map.set(chat.book_id, chat.book_title || "");
    }
    for (const facet of explanationBooks) {
      if (!map.has(facet.book_id) || !map.get(facet.book_id)) {
        map.set(facet.book_id, facet.book_title || "");
      }
    }
    return Array.from(map.entries()).map(([id, title]) => ({ id, title }));
  }, [chats, explanationBooks]);

  const refresh = (nextSearch: string, nextBookId: string) => refreshExplanations(nextSearch, nextBookId);
  const loadMore = (nextSearch: string, nextBookId: string) => loadMoreExplanations(nextSearch, nextBookId);

  return {
    entries,
    total: filteredChats.length + explanationTotal,
    bookOptions,
    hasMore,
    loadingMore,
    refresh,
    loadMore,
    removeChat,
    moveOutExplanation,
  };
}
