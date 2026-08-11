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
}

export default function BookGrid({ books, hasMore, loadMore, loadingMore, activeCollectionId, onBooksChanged }: BookGridProps) {
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
  const openBook = async (book: Book) => {
    if (needsPreparation(book) && book.preparation_state === "failed") {
      await retryPreparation(book);
      onBooksChanged?.();
      return;
    }
    if (!isPendingPreparation(book)) requestOpen(book);
  };

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-6">
        {books.map((book, index) => (
          <button
            key={book.id}
            onClick={() => { openBook(book).catch(() => {}); }}
            onContextMenu={(e) => handleContextMenu(e, book)}
            {...longPress}
            onPointerDown={(e) => { longPressBook.current = book; longPress.onPointerDown(e); }}
            className={`text-left cursor-pointer group ${staggerEntrance && index < (entranceSize ?? 0) ? "motion-stagger-in" : ""} ${book.available === false ? "opacity-60" : ""} ${isPendingPreparation(book) ? "cursor-wait" : ""}`}
            style={staggerEntrance ? ({ "--motion-stagger-index": Math.min(index, STAGGER_CAP) } as React.CSSProperties) : undefined}
          >
            <div className="relative bg-border rounded-lg overflow-hidden shadow-card aspect-[3/4]">
              {book.cover_data ? (
                <CoverImage src={book.cover_data} alt={book.title} title={book.title} />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-bg-muted">
                  <span className="text-[14px] text-text-muted text-center px-4">
                    {book.title}
                  </span>
                </div>
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
              {book.status === "finished" && book.available !== false && (
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
            <h3 className="mt-3 text-[14px] font-semibold text-text-primary tracking-[-0.15px] truncate">
              {book.title}
            </h3>
            <p className="text-[12px] text-text-secondary truncate">{book.author}</p>
          </button>
        ))}
      </div>

      {contextMenu && (
        <BookContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          bookId={contextMenu.book.id}
          bookStatus={contextMenu.book.status}
          activeCollectionId={activeCollectionId}
          onClose={() => setContextMenu(null)}
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
