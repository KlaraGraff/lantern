import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkPlus, Clock, Trash2 } from "lucide-react";
import { useBookmarks } from "../hooks/useBookmarks";
import { timeAgo } from "../utils/timeAgo";

interface BookmarksPanelProps {
  bookId: string;
  onNavigate?: (cfi: string) => void;
  getCurrentCfi?: () => string | null;
  getCurrentLabel?: () => string;
  getPageFromCfi?: (cfi: string) => number | null;
}

/**
 * Bookmarks only. Highlights used to live here behind a nested tab bar — they
 * are `HighlightsPanel` now, a sibling tab rather than a child, which is what
 * ended the "书签 inside 书签" naming collision.
 */
export default function BookmarksPanel({ bookId, onNavigate, getCurrentCfi, getCurrentLabel, getPageFromCfi }: BookmarksPanelProps) {
  const { t } = useTranslation();
  const { bookmarks, add: addBookmark, remove: removeBookmark } = useBookmarks(bookId);

  const handleAddBookmark = async () => {
    const cfi = getCurrentCfi?.();
    if (!cfi) return;
    const label = getCurrentLabel?.() || "Bookmark";
    await addBookmark(cfi, label);
  };

  return (
    <div className="flex h-full flex-col bg-bg-muted">
      <div className="flex h-[45px] shrink-0 items-center justify-end px-3">
        <button
          onClick={handleAddBookmark}
          className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-bg-input px-2.5 hover:bg-border"
        >
          <BookmarkPlus size={16} className="text-text-primary" />
          <span className="text-[14px] font-medium tracking-[-0.15px] text-text-primary">
            {t("bookmarks.addHere")}
          </span>
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {bookmarks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-10 text-center">
            <div className="grid size-[46px] place-items-center rounded-full bg-bg-input">
              <Bookmark size={19} className="text-text-muted" />
            </div>
            <p className="text-[13.5px] text-text-secondary">{t("bookmarks.emptyTitle")}</p>
            <p className="text-[12px] leading-relaxed text-text-muted">{t("bookmarks.emptyHint")}</p>
          </div>
        ) : (
          bookmarks.map((bookmark) => (
            <button
              key={bookmark.id}
              onClick={() => onNavigate?.(bookmark.cfi)}
              className="group flex w-full cursor-pointer items-start gap-0 border-l-2 border-transparent py-3 pl-[18px] pr-4 text-left hover:bg-bg-input"
            >
              <Bookmark size={16} className="mt-0.5 shrink-0 text-text-muted" />
              <div className="ml-3 min-w-0 flex-1">
                <span className="block truncate text-[14px] leading-5 tracking-[-0.15px] text-text-primary">
                  {bookmark.label || "Bookmark"}
                </span>
                <div className="mt-1.5 flex items-center gap-3">
                  {getPageFromCfi && (() => {
                    const page = getPageFromCfi(bookmark.cfi);
                    return page != null ? (
                      <span className="text-[11px] tracking-[0.06px] text-text-muted">
                        {t("bookmarks.page", { page })}
                      </span>
                    ) : null;
                  })()}
                  <span className="flex items-center gap-1 text-[11px] tracking-[0.06px] text-text-muted">
                    <Clock size={12} />
                    {timeAgo(bookmark.created_at)}
                  </span>
                </div>
              </div>
              <div
                onClick={(e) => { e.stopPropagation(); removeBookmark(bookmark.id); }}
                className="rounded p-1 opacity-0 transition-opacity hover:bg-bg-surface group-hover:opacity-100"
              >
                <Trash2 size={14} className="text-text-muted" />
              </div>
            </button>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 pb-3 pt-[11px]">
        <p className="text-center text-[11px] tracking-[0.06px] text-text-muted">
          {t("bookmarks.count", { count: bookmarks.length })}
        </p>
      </div>
    </div>
  );
}
