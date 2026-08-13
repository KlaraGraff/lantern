import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  CircleDashed,
  FolderPlus,
  FolderMinus,
  Pencil,
  Database,
  Info,
  Trash2,
  ChevronRight,
  Plus,
  Check,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useCollections } from "../hooks/useCollections";
import { useCoarsePointer } from "../hooks/useCoarsePointer";
import { useTranslation } from "react-i18next";
import { deriveBookIndexState, type BookIndexState, type IndexDetails } from "./index-state";
import { anchorTransformOrigin } from "./motion";
import { platform } from "../services/platform";

/** Fixed width of the collections submenu — it is set on the element too. */
const SUBMENU_WIDTH = 200;

/** How close to the viewport edge the clamped submenu is allowed to sit. */
const SUBMENU_EDGE_GAP = 8;

interface BookContextMenuProps {
  x: number;
  y: number;
  bookId: string;
  bookStatus: string;
  activeCollectionId?: string;
  onClose: () => void;
  onViewDetails: () => void;
  onMarkFinished: () => void;
  onMarkReading: () => void;
  onMarkUnread: () => void;
  onEditInfo: () => void;
  onManageIndex: () => void;
  onDelete: () => void;
  onBooksChanged?: () => void;
}

export default function BookContextMenu({
  x,
  y,
  bookId,
  bookStatus,
  activeCollectionId,
  onClose,
  onViewDetails,
  onMarkFinished,
  onMarkReading,
  onMarkUnread,
  onEditInfo,
  onManageIndex,
  onDelete,
  onBooksChanged,
}: BookContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showCollections, setShowCollections] = useState(false);
  const [newName, setNewName] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);
  const { collections, create, addBook, removeBook } = useCollections();
  const { t } = useTranslation();
  // A finger has no hover, so the collections row cannot be a hover trigger on
  // a phone — and it cannot be *both* either: WebKit's post-tap compatibility
  // burst fires `mouseover` and `click` at the same element, so a row that
  // opened on hover and toggled on click would open and close on one tap.
  // Each pointer kind therefore gets exactly one of the two.
  const coarsePointer = useCoarsePointer();
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const submenuRef = useRef<HTMLDivElement>(null);
  // Where the clamp above actually put the menu. Kept rather than re-measured
  // so the submenu can be placed against it without a `getBoundingClientRect`,
  // which would read the menu mid-entry-animation if the pointer reaches the
  // collections row inside the first frames.
  const placement = useRef({ left: x, top: y });
  // The same reading the index modal opens on, so the menu can say whether
  // it's worth opening at all. Until it arrives the item keeps its plain
  // label rather than flashing a state it hasn't checked.
  const [indexState, setIndexState] = useState<BookIndexState | null>(null);

  useEffect(() => {
    // The row this feeds is hidden entirely when the platform can't configure
    // an index (see the button below) — no point reading its state.
    if (!platform.hasEmbeddingIndex) return;
    let disposed = false;
    invoke<IndexDetails>("ai_index_details", { bookId })
      .then((details) => { if (!disposed) setIndexState(deriveBookIndexState(details)); })
      .catch(() => {});
    return () => { disposed = true; };
  }, [bookId]);

  useEffect(() => {
    // `pointerdown`, not `mousedown`, and the difference is the whole gesture
    // on a phone. This menu opens from a long press while the finger is still
    // down; the press ends with a `touchend`, and WebKit answers that with a
    // synthetic `mouseover → mousedown → mouseup → click` burst aimed at the
    // cover underneath. A `mousedown` listener reads that burst as "pressed
    // outside" and closes the menu in the same frame the finger lifts —
    // deterministically, not now and then. Pointer events are generated from
    // the touch itself and have no compatibility burst, so the only
    // `pointerdown` this ever sees is a real second press.
    const handlePressOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePressOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePressOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Clamp main menu position to viewport, then grow it out of the cursor.
  // Layout size rather than the rendered rect: the menu is mid-scale on the
  // frame this runs, and a rect would measure the smaller, in-flight box.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = x + width > window.innerWidth ? x - width : x;
    const top = y + height > window.innerHeight ? y - height : y;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    placement.current = { left, top };
    anchorTransformOrigin(element, { x, y }, { left, top });
  }, [x, y]);

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  const statusLabel =
    bookStatus === "reading"
      ? t("bookMenu.currentlyReading")
      : bookStatus === "finished"
        ? t("bookMenu.finished")
        : t("bookMenu.notStarted");

  const handleAddToCollection = async (collectionId: string) => {
    await addBook(collectionId, bookId);
    onBooksChanged?.();
    onClose();
  };

  const handleRemoveFromCollection = async () => {
    if (!activeCollectionId) return;
    await removeBook(activeCollectionId, bookId);
    onBooksChanged?.();
    onClose();
  };

  const handleCreateAndAdd = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const collection = await create(trimmed);
    await addBook(collection.id, bookId);
    onBooksChanged?.();
    onClose();
  };

  // Compute submenu position
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({ left: x + SUBMENU_WIDTH, top: y });
  useEffect(() => {
    const element = menuRef.current;
    if (!showCollections || !element) return;
    const { left, top: menuTop } = placement.current;
    const right = left + element.offsetWidth;
    // `offsetTop` is measured inside the menu, which is the row's offset
    // parent — the same reason it survives the entry animation that a
    // viewport-relative rect would not.
    const trigger = element.querySelector<HTMLElement>("[data-collection-trigger]");
    const top = menuTop + (trigger?.offsetTop ?? 0);
    const opensLeft = right + SUBMENU_WIDTH > window.innerWidth;
    // Clamped, because on a phone neither side fits: a 220px menu opened under
    // a finger near the left edge leaves less than 200px to its right, and
    // flipping it left puts it off the screen entirely. A desktop window is
    // always wide enough for one side or the other, so the clamp never bites
    // there.
    const unclampedLeft = opensLeft ? left - SUBMENU_WIDTH : right;
    setSubmenuStyle({
      left: Math.max(
        SUBMENU_EDGE_GAP,
        Math.min(unclampedLeft, window.innerWidth - SUBMENU_WIDTH - SUBMENU_EDGE_GAP),
      ),
      top,
      // Unfolds from the edge it is attached to, so it reads as coming out of
      // the parent menu rather than appearing beside it.
      transformOrigin: opensLeft ? "right top" : "left top",
    });
  }, [showCollections, x, y]);

  return (
    <>
      <div
        ref={menuRef}
        className="motion-pop fixed z-50 bg-bg-surface/95 border border-border/80 rounded-[10px] py-1 w-[220px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
        style={{ left: x, top: y }}
      >
        {/* Status indicator */}
        <button
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-default"
        >
          <BookOpen size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-text-muted tracking-[-0.08px]">
            {statusLabel}
          </span>
        </button>

        {/* Details. First actionable item, because it is the only one that
            opens something rather than changing something — and because the
            left click on a book goes straight to the reader, which leaves the
            right click as the only way in. */}
        <button
          onClick={onViewDetails}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
        >
          <Info size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
            {t("bookMenu.viewDetails")}
          </span>
        </button>

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Status actions — show all transitions except the current status */}
        {bookStatus !== "reading" && (
          <button
            onClick={onMarkReading}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <BookOpen size={16} className="text-text-muted" />
            <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("bookMenu.currentlyReading")}
            </span>
          </button>
        )}
        {bookStatus !== "finished" && (
          <button
            onClick={onMarkFinished}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <CheckCircle2 size={16} className="text-text-muted" />
            <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("bookMenu.markFinished")}
            </span>
          </button>
        )}
        {bookStatus !== "unread" && (
          <button
            onClick={onMarkUnread}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <CircleDashed size={16} className="text-text-muted" />
            <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("bookMenu.markUnread")}
            </span>
          </button>
        )}

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Edit Info */}
        <button
          onClick={onEditInfo}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
        >
          <Pencil size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
            {t("bookMenu.editInfo")}
          </span>
        </button>
        {platform.hasEmbeddingIndex && (
          <button
            onClick={onManageIndex}
            className="flex h-[31.5px] w-[calc(100%-8px)] items-center gap-3 rounded-sm px-3 mx-1 text-left hover:bg-accent-bg"
          >
            <Database size={16} className="text-text-muted" />
            <span className="flex-1 truncate text-[13px] font-medium text-text-primary">
              {indexState
                ? t("bookMenu.aiIndexWithState", { state: t(`indexManager.stateShort.${indexState}`) })
                : t("bookMenu.aiIndex")}
            </span>
          </button>
        )}

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Add to Collection — hover under a cursor, tap under a finger */}
        <button
          data-collection-trigger
          onClick={coarsePointer ? () => setShowCollections((open) => !open) : undefined}
          onMouseEnter={coarsePointer ? undefined : () => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
            setShowCollections(true);
          }}
          onMouseLeave={coarsePointer ? undefined : () => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
          className={`flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer transition-colors ${showCollections ? "bg-accent-bg" : "hover:bg-accent-bg"}`}
        >
          <FolderPlus size={16} className="text-text-muted" />
          <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
            {t("bookMenu.addToCollection")}
          </span>
          <ChevronRight size={12} className="text-text-muted" />
        </button>

        {/* Remove from Collection (only when viewing a collection) */}
        {activeCollectionId && (
          <button
            onClick={handleRemoveFromCollection}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <FolderMinus size={16} className="text-text-muted" />
            <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px] whitespace-nowrap">
              {t("bookMenu.removeFromCollection")}
            </span>
          </button>
        )}

        <div className="mx-3 my-1 h-px bg-border/80" />

        {/* Delete Book */}
        <button
          onClick={onDelete}
          className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
        >
          <Trash2 size={16} className="text-red-400" />
          <span className="flex-1 text-[13px] font-medium text-red-400 tracking-[-0.08px]">
            {t("bookMenu.deleteBook")}
          </span>
        </button>
      </div>

      {/* Collection submenu */}
      {showCollections && (
        <div
          ref={submenuRef}
          className="motion-pop fixed z-[51] bg-bg-surface/95 border border-border/80 rounded-[10px] py-1 w-[200px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
          style={submenuStyle}
          onMouseEnter={coarsePointer ? undefined : () => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
          }}
          onMouseLeave={coarsePointer ? undefined : () => {
            hoverTimeoutRef.current = setTimeout(() => setShowCollections(false), 150);
          }}
        >
          {collections.length === 0 && !creatingNew && (
            <div className="px-4 py-2 text-[12px] text-text-muted">
              {t("bookMenu.noCollections")}
            </div>
          )}
          {collections.map((c) => (
            <button
              key={c.id}
              onClick={() => handleAddToCollection(c.id)}
              className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
            >
              <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px] truncate">
                {c.name}
              </span>
            </button>
          ))}

          <div className="mx-3 my-1 h-px bg-border/80" />

          {/* Create new collection */}
          {creatingNew ? (
            <div className="flex items-center gap-1 mx-1 px-2 h-[31.5px]">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateAndAdd();
                  if (e.key === "Escape") setCreatingNew(false);
                }}
                placeholder={t("bookMenu.collectionPlaceholder")}
                className="flex-1 min-w-0 text-[13px] bg-transparent outline-none placeholder:text-text-muted"
              />
              <button
                onClick={handleCreateAndAdd}
                className="p-1 rounded hover:bg-accent-bg transition-colors"
              >
                <Check size={14} className="text-text-muted" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreatingNew(true)}
              className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
            >
              <Plus size={16} className="text-text-muted" />
              <span className="flex-1 text-[13px] font-medium text-text-primary tracking-[-0.08px]">
                {t("bookMenu.newCollection")}
              </span>
            </button>
          )}
        </div>
      )}
    </>
  );
}
