import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { Library, BookOpen, CheckCircle2, FolderClosed, BookA, Plus, MessageSquare, Pencil, Trash2, GripVertical, RefreshCw, StickyNote, BarChart3, RotateCcw, MoreHorizontal } from "lucide-react";
import Button from "./ui/Button";
import LanternLogo from "./LanternLogo";
import { platform } from "../services/platform";
import type { Collection } from "../hooks/useCollections";

interface BookCounts {
  all: number;
  reading: number;
  finished: number;
}

interface SidebarProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  bookCounts: BookCounts;
  collections: {
    collections: Collection[];
    create: (name: string) => Promise<Collection>;
    rename: (id: string, name: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
  };
  userName?: string;
  onOpenSettings?: () => void;
  syncProgress?: { applied: number; total: number } | null;
  /**
   * Same component, same content, different container: below `md:` this sits in
   * Home's drawer instead of being a column of the page. Splitting it into two
   * components would fork the content on the first row anyone adds, so the fork
   * stops at the shell — width, chrome, and the mouse-only resize grip.
   */
  inDrawer?: boolean;
}

/**
 * 36px under a mouse, 44px under a finger. The height is the one thing the
 * drawer changes about a row, and it keys off width rather than pointer type
 * because that is what the plan settled on — the drawer only exists below `md:`,
 * so the two questions have the same answer everywhere this string is used.
 */
const ROW_HEIGHT = "h-11 md:h-9";

/**
 * The traffic lights are a macOS fact, not a wide-window fact: a window dragged
 * narrow still has them and still needs the strip left clear. Branching on width
 * here would put the brand name under the close button.
 */
const TOP_INSET = platform.hasTitleBarInset ? "pt-titlebar" : "pt-safe-top";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 224;
const STORAGE_KEY = "sidebar-width";

function getStoredWidth(): number {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const n = parseInt(stored, 10);
    if (!isNaN(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n;
  }
  return SIDEBAR_DEFAULT;
}

export default function Sidebar({ activeFilter, onFilterChange, bookCounts, collections: collectionsHook, userName, onOpenSettings, syncProgress, inDrawer = false }: SidebarProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sidebarWidth, setSidebarWidth] = useState(getStoredWidth);
  const resizingRef = useRef(false);

  const libraryFilters = [
    { id: "all", label: t("sidebar.allBooks"), icon: Library },
    { id: "reading", label: t("sidebar.currentlyReading"), icon: BookOpen },
    { id: "finished", label: t("sidebar.finished"), icon: CheckCircle2 },
  ];
  const { collections, create, rename, remove, reorder } = collectionsHook;
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; collection: Collection } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const collectionListRef = useRef<HTMLDivElement>(null);
  // Touch has no equivalent of "grab the handle": the handles are hidden on a
  // coarse pointer until the reader asks for them, because a list that is
  // always draggable fights both the drawer's horizontal gesture and its own
  // vertical scroll. Long-press is not the answer — it is spoken for by word
  // lookup in the reader, and one gesture meaning two things is worse than a
  // button. Under a mouse nothing changes: the handles are always there.
  const [isSortingCollections, setIsSortingCollections] = useState(false);

  const handlePointerDown = useCallback((e: React.PointerEvent, id: string) => {
    // Only start drag from grip handle
    if (!(e.target as HTMLElement).closest("[data-grip]")) return;
    e.preventDefault();
    const listEl = collectionListRef.current;
    if (!listEl) return;
    const items = Array.from(listEl.children) as HTMLElement[];
    const startY = e.clientY;
    const ids = collections.map((c) => c.id);
    const startIdx = ids.indexOf(id);
    const itemHeight = items[0]?.getBoundingClientRect().height ?? 36;

    setDragId(id);
    setDragOrder(ids);

    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      const offset = Math.round(dy / itemHeight);
      const newIdx = Math.max(0, Math.min(ids.length - 1, startIdx + offset));
      if (newIdx !== startIdx) {
        const newIds = [...ids];
        newIds.splice(startIdx, 1);
        newIds.splice(newIdx, 0, id);
        setDragOrder(newIds);
      } else {
        setDragOrder(ids);
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setDragId(null);
      setDragOrder((current) => {
        const original = collections.map((c) => c.id);
        if (current.join() !== original.join()) reorder(current);
        return current;
      });
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, [collections, reorder]);

  const displayCollections = dragId ? dragOrder.map((id) => collections.find((c) => c.id === id)!).filter(Boolean) : collections;

  const getCount = (filterId: string) => {
    if (filterId === "all") return bookCounts.all;
    if (filterId === "reading") return bookCounts.reading;
    if (filterId === "finished") return bookCounts.finished;
    return 0;
  };

  const handleCreateCollection = async () => {
    const name = newName.trim();
    if (!name) return;
    await create(name);
    setNewName("");
    setIsCreating(false);
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (renamingId && name) {
      await rename(renamingId, name);
    }
    setRenamingId(null);
    setRenameValue("");
  };

  // The trailing `···` and the desktop right-click open the same menu; only the
  // anchor differs. Clamped, because a row near the bottom of a phone screen
  // would otherwise anchor the menu off the end of the viewport.
  const openCollectionMenu = (anchor: DOMRect, collection: Collection) => {
    const MENU_WIDTH = 180;
    const MENU_HEIGHT = 88;
    setContextMenu({
      x: Math.max(8, Math.min(anchor.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - MENU_HEIGHT - 8)),
      collection,
    });
  };

  const handleDelete = async (id: string) => {
    if (activeFilter === `collection:${id}`) onFilterChange("all");
    await remove(id);
    setContextMenu(null);
  };

  // Dismiss context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [contextMenu]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      resizingRef.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((w) => {
        localStorage.setItem(STORAGE_KEY, String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [sidebarWidth]);

  return (
    <aside
      style={inDrawer ? undefined : { width: sidebarWidth }}
      className={inDrawer
        ? "w-full bg-bg-muted h-full flex flex-col gap-6 px-4 relative select-none overflow-y-auto overscroll-contain"
        : "shrink-0 bg-bg-muted border-r border-border h-full flex flex-col gap-6 px-4 relative select-none overflow-hidden"}
    >
      {platform.hasTitleBarInset && <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-titlebar" />}
      <div className={`flex items-center gap-2.5 pb-2 ${TOP_INSET}`}>
        <div className="size-[26px] shrink-0 overflow-hidden rounded-[7px] border border-border">
          <LanternLogo size={26} className="block object-cover" />
        </div>
        <span className="text-[18px] font-semibold tracking-[0.5px] text-text-primary">
          Lantern
        </span>
        {syncProgress ? (
          <span className="ml-auto shrink-0 flex items-center gap-1.5 rounded-md bg-accent/10 px-2 py-1">
            <RefreshCw size={12} className="text-accent animate-spin" />
            {syncProgress.total > 0 && (
              <span className="text-[11px] font-medium text-accent">
                {syncProgress.applied}/{syncProgress.total}
              </span>
            )}
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          {t("sidebar.library")}
        </h2>
        <div className="flex flex-col gap-1">
          {libraryFilters.map((filter) => {
            const Icon = filter.icon;
            const isActive = activeFilter === filter.id;
            return (
              <button
                key={filter.id}
                onClick={() => onFilterChange(filter.id)}
                className={`flex items-center justify-between px-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {filter.label}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {getCount(filter.id)}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => navigate("/reading-stats")}
          className={`flex ${ROW_HEIGHT} w-full items-center gap-2 rounded-lg px-3 text-left hover:bg-bg-input`}
        >
          <BarChart3 size={16} className="text-text-muted" />
          <span className="text-[14px] font-medium text-text-secondary">{t("sidebar.readingStats")}</span>
        </button>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          {t("sidebar.chats")}
        </h2>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onFilterChange("chats")}
            className={`flex items-center gap-2 px-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
              activeFilter === "chats" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <MessageSquare size={16} className={activeFilter === "chats" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "chats" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.chats")}
            </span>
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
          {t("sidebar.saved")}
        </h2>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => onFilterChange("vocab")}
            className={`flex items-center gap-2 px-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
              activeFilter === "vocab" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <BookA size={16} className={activeFilter === "vocab" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "vocab" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.vocab")}
            </span>
          </button>
          <button
            onClick={() => onFilterChange("review")}
            className={`flex items-center gap-2 px-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
              activeFilter === "review" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <RotateCcw size={16} className={activeFilter === "review" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium tracking-[-0.15px] ${
              activeFilter === "review" ? "text-accent-text" : "text-text-secondary"
            }`}>
              {t("sidebar.review")}
            </span>
          </button>
          <button
            onClick={() => onFilterChange("notes")}
            className={`flex items-center gap-2 px-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
              activeFilter === "notes" ? "bg-accent-bg" : "hover:bg-bg-input"
            }`}
          >
            <StickyNote size={16} className={activeFilter === "notes" ? "text-accent-text" : "text-text-muted"} />
            <span className={`text-[14px] font-medium ${activeFilter === "notes" ? "text-accent-text" : "text-text-secondary"}`}>
              {t("sidebar.notes")}
            </span>
          </button>
        </div>
      </div>

      <div className={`flex flex-col gap-3 ${inDrawer ? "min-h-[132px]" : "min-h-0"} flex-1`}>
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.3px] text-text-muted">
            {t("sidebar.collections")}
          </h2>
          {/* `hidden` at every width under a mouse, so this is not a flex item
              on the desktop at all and the heading row is untouched there. */}
          {displayCollections.length > 0 && (
            <button
              type="button"
              onClick={() => setIsSortingCollections((editing) => !editing)}
              className="hidden touch:inline-flex items-center h-8 px-2 rounded-md text-[12px] font-semibold text-accent"
            >
              {isSortingCollections ? t("sidebar.doneSortingCollections") : t("sidebar.sortCollections")}
            </button>
          )}
          <Button
            variant="icon"
            size="sm"
            className="size-5 touch:size-8"
            onClick={() => setIsCreating(true)}
          >
            <Plus size={16} />
          </Button>
        </div>

        {isCreating && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleCreateCollection();
            }}
            className="px-1"
          >
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (!newName.trim()) setIsCreating(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setNewName("");
                  setIsCreating(false);
                }
              }}
              placeholder={t("sidebar.collectionPlaceholder")}
              className={`w-full ${ROW_HEIGHT} px-3 rounded-lg bg-bg-input text-[14px] text-text-primary placeholder:text-text-placeholder outline-none border border-accent`}
            />
          </form>
        )}

        <div ref={collectionListRef} className="flex flex-col gap-1 overflow-y-auto min-h-0 scrollbar-none">
          {displayCollections.map((collection) => {
            const isActive = activeFilter === `collection:${collection.id}`;
            if (renamingId === collection.id) {
              return (
                <form
                  key={collection.id}
                  onSubmit={(e) => { e.preventDefault(); handleRename(); }}
                  className="px-1"
                >
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={handleRename}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                    }}
                    className={`w-full ${ROW_HEIGHT} px-3 rounded-lg bg-bg-input text-[14px] text-text-primary placeholder:text-text-placeholder outline-none border border-accent`}
                  />
                </form>
              );
            }
            return (
              <div
                key={collection.id}
                onPointerDown={(e) => handlePointerDown(e, collection.id)}
                onClick={() => onFilterChange(`collection:${collection.id}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, collection });
                }}
                className={`flex items-center justify-between px-1 pr-3 ${ROW_HEIGHT} rounded-lg w-full cursor-pointer ${
                  isActive ? "bg-accent-bg" : "hover:bg-bg-input"
                } ${dragId === collection.id ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-1">
                  {/* Hidden rather than disabled on a coarse pointer: a handle
                      that cannot be grabbed is worse than no handle, and
                      `display: none` also takes it out of hit testing, which is
                      what keeps `handlePointerDown` from ever firing there. */}
                  <div data-grip className={`items-center justify-center w-5 ${ROW_HEIGHT} cursor-grab touch-none ${isSortingCollections ? "flex" : "flex touch:hidden"}`}>
                    <GripVertical size={12} className="text-text-muted/40" />
                  </div>
                  <FolderClosed
                    size={16}
                    className={isActive ? "text-accent-text" : "text-text-muted"}
                  />
                  <span
                    className={`text-[14px] font-medium tracking-[-0.15px] ${
                      isActive ? "text-accent-text" : "text-text-secondary"
                    }`}
                  >
                    {collection.name}
                  </span>
                </div>
                <span className="text-[12px] font-medium text-text-muted">
                  {collection.book_count}
                </span>
                {/* Right-click has no finger equivalent, so the same menu gets a
                    button — visible only on a coarse pointer, and stopping its
                    own pointerdown so the row's drag never sees it. */}
                <button
                  type="button"
                  aria-label={t("sidebar.collectionActions")}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    openCollectionMenu(e.currentTarget.getBoundingClientRect(), collection);
                  }}
                  className="hidden touch:flex size-11 -mr-2 shrink-0 items-center justify-center rounded-lg text-text-muted"
                >
                  <MoreHorizontal size={16} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {/* User profile */}
      <div className={`border-t border-border pt-3 ${inDrawer ? "pb-[calc(var(--spacing-safe-bottom)+0.75rem)]" : "pb-3"}`}>
        <button
          onClick={onOpenSettings}
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg w-full cursor-pointer hover:bg-bg-input"
        >
          <div className="size-7 rounded-full bg-accent flex items-center justify-center text-[12px] font-semibold text-white shrink-0">
            {userName
              ? userName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
              : "R"}
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-text-primary truncate">{userName || "Reader"}</p>
            <p className="text-[11px] text-text-muted">{t("settings.title")}</p>
          </div>
        </button>
      </div>
      {/* Collection context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-bg-surface/95 border border-border/80 rounded-[10px] py-1 w-[180px] backdrop-blur-sm shadow-[0px_20px_25px_0px_rgba(0,0,0,0.15),0px_8px_10px_0px_rgba(0,0,0,0.15)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setRenamingId(contextMenu.collection.id);
              setRenameValue(contextMenu.collection.name);
              setContextMenu(null);
            }}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <Pencil size={14} className="text-text-muted" />
            <span className="text-[13px] font-medium text-text-primary tracking-[-0.08px]">
              {t("sidebar.renameCollection")}
            </span>
          </button>
          <div className="mx-3 my-1 h-px bg-border/80" />
          <button
            onClick={() => handleDelete(contextMenu.collection.id)}
            className="flex items-center gap-3 w-[calc(100%-8px)] mx-1 px-3 h-[31.5px] touch:h-11 rounded-sm text-left cursor-pointer hover:bg-accent-bg transition-colors"
          >
            <Trash2 size={14} className="text-red-500" />
            <span className="text-[13px] font-medium text-red-500 tracking-[-0.08px]">
              {t("sidebar.deleteCollection")}
            </span>
          </button>
        </div>
      )}
      {/* Resize handle — a 4px mouse target, and the drawer has a fixed width,
          so it has nothing to drag there. */}
      {!inDrawer && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 transition-colors"
        />
      )}
    </aside>
  );
}
