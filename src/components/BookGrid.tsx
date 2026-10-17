import { useState, useEffect, useRef } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useBookOpenGate } from "./BookOpenGateProvider";
import { deleteBook, markFinished, isPendingPreparation, needsPreparation, retryPreparation, updateBookStatus } from "../hooks/useBooks";
import { useNavigate } from "react-router";
import BookContextMenu from "./BookContextMenu";
import EditMetadataModal from "./EditMetadataModal";
import { useTranslation } from "react-i18next";
import { CloudDownload } from "lucide-react";
import DeleteBookDialog, { type DeleteBookNotePolicy } from "./DeleteBookDialog";
import IndexManagerModal from "./IndexManagerModal";
import { useShelfCoverage } from "../hooks/useShelfCoverage";
import { useLongPress } from "../hooks/useLongPress";
import { SortableBookItem } from "./BookSort";
import { platform } from "../services/platform";
import { wantsNewWindow } from "../utils/reader-open-mode";
import { nameBookCover } from "../utils/book-transition";

function CoverImage({ src, alt, title }: { src: string; alt: string; title: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-muted">
        <span className="text-[14px] text-text-muted text-center px-4">{title}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Whether this launch has already spent its shelf entrance.
 *
 * Module scope on purpose. The entrance is meant to happen once per cold
 * start, and every narrower place to keep the flag would fire it again:
 * component state resets when the grid remounts, and the grid remounts every
 * time the user comes back from the reader or switches collection. Walking
 * back into a shelf you have already seen should be instant.
 *
 * It resets when the page context does — a real app relaunch, or a dev
 * reload — which is exactly the boundary we want.
 */
let shelfEntranceSpent = false;

/**
 * Where the stagger stops growing. Cards past this share the last delay.
 *
 * Past roughly a dozen the rest are below the fold, so letting the delay keep
 * climbing buys an animation nobody sees and a shelf whose tail is still
 * fading in a second after it arrived.
 */
const STAGGER_CAP = 12;

interface BookGridProps {
  books: Book[];
  hasMore?: boolean;
  loadMore?: () => void;
  loadingMore?: boolean;
  activeCollectionId?: string;
  onBooksChanged?: () => void;
  /** A last cell after the books — the desktop shelf's import tile. */
  trailing?: React.ReactNode;
  /**
   * Narrow-screen column count, chosen by the segmented control in `Home.tsx`.
   * `undefined` (always the case on a wide screen) keeps the auto-fill grid
   * this component has always had. 3 and 4 columns leave little room per card,
   * so the title/author type shrinks to match — 2 columns keeps the same sizes
   * the auto-fill grid uses.
   */
  columns?: 2 | 3 | 4;
  sortable?: boolean;
}

export default function BookGrid({ books, hasMore, loadMore, loadingMore, activeCollectionId, onBooksChanged, columns, trailing, sortable = false }: BookGridProps) {
  const { t } = useTranslation();
  const requestOpen = useBookOpenGate();
  const navigate = useNavigate();
  const coverageOf = useShelfCoverage();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    book: Book;
  } | null>(null);
  const [editBook, setEditBook] = useState<Book | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Book | null>(null);
  const [indexBookId, setIndexBookId] = useState<string | null>(null);

  // The staggered entrance, decided once at mount and never revisited.
  const [staggerEntrance] = useState(() => !shelfEntranceSpent);
  useEffect(() => {
    shelfEntranceSpent = true;
  }, []);

  // How many books the shelf held when it first had any. The grid often mounts
  // empty and fills a tick later, so the count cannot be read at mount; and
  // freezing it once is what keeps "load more" from staggering page two into
  // view under a user who is already scrolling.
  //
  // Set during render rather than in an effect on purpose: an effect runs
  // after the browser has already painted the cards, so the animation would
  // start from a frame in which they were visible. React re-renders in place
  // here, before any commit, and the cards paint once — already animating.
  const [entranceSize, setEntranceSize] = useState<number | null>(null);
  if (staggerEntrance && entranceSize === null && books.length > 0) {
    setEntranceSize(books.length);
  }

  const handleContextMenu = (e: React.MouseEvent, book: Book) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, book });
  };

  // The finger's spelling of the same gesture. Without it the nine actions in
  // `BookContextMenu` have no entry point at all on a phone.
  const longPressBook = useRef<Book | null>(null);
  const longPress = useLongPress((x, y) => {
    const book = longPressBook.current;
    if (book) setContextMenu({ x, y, book });
  });

  // An unavailable book still opens: the reader owns the iCloud download and
  // shows the waiting screen. Refusing the click here left evicted books dead.
  const openBook = async (book: Book, newWindow = false) => {
    if (needsPreparation(book) && book.preparation_state === "failed") {
      await retryPreparation(book);
      onBooksChanged?.();
      return;
    }
    if (!isPendingPreparation(book)) requestOpen(book, newWindow ? { newWindow: true } : undefined);
  };

  // ⌘/Ctrl-click asks for a window of its own; a plain click grows this cover
  // into the reader (`utils/book-transition.ts`).
  const clickBook = (event: React.MouseEvent<HTMLElement>, book: Book) => {
    const newWindow = platform.hasWindow && wantsNewWindow(event, platform.id === "macos");
    if (!newWindow) nameBookCover(event.currentTarget.querySelector<HTMLElement>("[data-book-cover]"));
    openBook(book, newWindow).catch(() => {});
  };

  const gridClass =
    columns === 2
      ? "grid grid-cols-2 gap-4"
      : columns === 3
        ? "grid grid-cols-3 gap-3"
        : columns === 4
          ? "grid grid-cols-4 gap-2"
          : "grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-x-5 gap-y-6";
  // The wide shelf is the 「纸灯」 one (design v2 §8 step 2): narrower covers
  // with a spine, a serif title, and progress as a line under the author
  // instead of a badge on the cover. The phone's column modes keep their own
  // sizes.
  const paper = columns === undefined;
  const titleClass =
    columns === 4
      ? "mt-1.5 text-[11px] font-semibold text-text-primary tracking-[-0.15px] truncate"
      : columns === 3
        ? "mt-2 text-[12.5px] font-semibold text-text-primary tracking-[-0.15px] truncate"
        : "mt-2.5 font-serif text-[13px] font-semibold text-text-primary truncate";
  const authorClass =
    columns === 4
      ? "text-[10px] text-text-secondary truncate"
      : columns === 3
        ? "text-[11px] text-text-secondary truncate"
        : "text-[11.5px] text-text-muted truncate";

  return (
    <>
      <div className={gridClass}>
        {books.map((book, index) => (
          <SortableBookItem key={book.id} id={book.id} enabled={sortable} list={false}>
          <button
            onClick={(event) => clickBook(event, book)}
            onContextMenu={(e) => handleContextMenu(e, book)}
            {...longPress}
            onPointerDown={(e) => { longPressBook.current = book; longPress.onPointerDown(e); }}
            className={`block w-full min-w-0 text-left group ${sortable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${staggerEntrance && index < (entranceSize ?? 0) ? "motion-stagger-in" : ""} ${book.available === false ? "opacity-60" : ""} ${isPendingPreparation(book) ? "cursor-wait" : ""}`}
            style={staggerEntrance ? ({ "--motion-stagger-index": Math.min(index, STAGGER_CAP) } as React.CSSProperties) : undefined}
          >
            <div data-book-cover className={`relative bg-border overflow-hidden shadow-card aspect-[3/4] ${paper ? "rounded-[4px_8px_8px_4px] transition-transform duration-[var(--motion-instant)] ease-[var(--ease-out-soft)] group-hover:-translate-y-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0" : "rounded-lg"}`}>
              {book.cover_data ? (
                <CoverImage src={book.cover_data} alt={book.title} title={book.title} />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-bg-muted">
                  <span className="text-[14px] text-text-muted text-center px-4">
                    {book.title}
                  </span>
                </div>
              )}
              {paper && (
                <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.22)_0,rgba(0,0,0,.06)_6px,rgba(255,255,255,.08)_8px,transparent_12px)]" />
              )}
              {book.available === false && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <CloudDownload size={32} className="text-white" />
                </div>
              )}
              {isPendingPreparation(book) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 px-3 text-center">
                  {book.preparation_state === "failed" ? <AlertCircle size={26} className="text-white" /> : <Loader2 size={26} className="animate-spin text-white" />}
                  <span className="text-[12px] font-medium text-white leading-4">
                    {book.preparation_state === "failed" ? t("book.preparationFailed") : t("book.preparing")}
                  </span>
                </div>
              )}
              {!paper && book.status === "finished" && book.available !== false && (
                <div className="absolute top-2 right-2 bg-success text-white text-[12px] px-2 py-1 rounded-full">
                  {t("bookGrid.finished")}
                </div>
              )}
              {/* Bottom-left: the top-right corner already belongs to 已读完,
                  and a cover that is dimmed or still being prepared has
                  nothing to say about how readable it is. */}
              {book.available !== false && !isPendingPreparation(book) && (() => {
                const percent = coverageOf(book.id);
                return percent === null ? null : (
                  <div
                    className="absolute bottom-2 left-2 rounded-full bg-black/55 px-2 py-1 text-[12px] font-medium text-white"
                    title={t("shelfCoverage.badgeTitle", { percent })}
                  >
                    {t("shelfCoverage.badge", { percent })}
                  </div>
                );
              })()}
            </div>
            <h3 className={titleClass}>
              {book.title}
            </h3>
            <p className={authorClass}>{book.author}</p>
            {paper && book.status === "finished" ? (
              <p className="mt-1 text-[10.5px] font-medium text-success-text">{t("bookGrid.finished")}</p>
            ) : paper && book.progress > 0 ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-bg-input">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.round(book.progress))}%` }} />
                </div>
                <span className="text-[10.5px] tabular-nums text-text-muted">{Math.round(book.progress)}%</span>
              </div>
            ) : null}
          </button>
          </SortableBookItem>
        ))}
        {trailing}
      </div>

      {contextMenu && (
        <BookContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          bookId={contextMenu.book.id}
          bookStatus={contextMenu.book.status}
          activeCollectionId={activeCollectionId}
          onClose={() => setContextMenu(null)}
          onOpenInNewWindow={() => {
            const book = contextMenu.book;
            setContextMenu(null);
            openBook(book, true).catch(() => {});
          }}
          onViewDetails={() => {
            const id = contextMenu.book.id;
            setContextMenu(null);
            navigate(`/book/${id}`);
          }}
          onMarkFinished={async () => {
            await markFinished(contextMenu.book.id);
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onMarkReading={async () => {
            await updateBookStatus(contextMenu.book.id, "reading");
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onMarkUnread={async () => {
            await updateBookStatus(contextMenu.book.id, "unread");
            setContextMenu(null);
            onBooksChanged?.();
          }}
          onEditInfo={() => {
            setEditBook(contextMenu.book);
            setContextMenu(null);
          }}
          onManageIndex={() => { setIndexBookId(contextMenu.book.id); setContextMenu(null); }}
          onDelete={() => {
            setDeleteTarget(contextMenu.book);
            setContextMenu(null);
          }}
          onBooksChanged={onBooksChanged}
        />
      )}

      {deleteTarget && (
        <DeleteBookDialog
          title={deleteTarget.title}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (policy: DeleteBookNotePolicy) => {
            await deleteBook(deleteTarget.id, policy === "preserve");
            setDeleteTarget(null);
            onBooksChanged?.();
          }}
        />
      )}

      {editBook && (
        <EditMetadataModal
          bookId={editBook.id}
          currentTitle={editBook.title}
          currentAuthor={editBook.author}
          currentCover={editBook.cover_data}
          onClose={() => setEditBook(null)}
          onSaved={() => {
            setEditBook(null);
            onBooksChanged?.();
          }}
        />
      )}
      {indexBookId && (
        <IndexManagerModal
          bookId={indexBookId}
          bookTitle={books.find((book) => book.id === indexBookId)?.title}
          onClose={() => setIndexBookId(null)}
        />
      )}

      {hasMore && <LoadMoreSentinel loadMore={loadMore} loadingMore={loadingMore} />}
    </>
  );
}

function LoadMoreSentinel({ loadMore, loadingMore }: { loadMore?: () => void; loadingMore?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !loadMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <div ref={ref} className="flex justify-center py-4">
      {loadingMore && <Loader2 size={20} className="text-text-muted animate-spin" />}
    </div>
  );
}
