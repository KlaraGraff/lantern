import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { Collection } from "../hooks/useCollections";

interface ShelfChipsProps {
  activeFilter: string;
  onFilterChange: (filter: string) => void;
  bookCounts: { all: number; reading: number; finished: number };
  collections: {
    collections: Collection[];
    create: (name: string) => Promise<Collection>;
    rename: (id: string, name: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
  };
}

/** How far a pointer must travel before a press on a chip becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

const CHIP =
  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors duration-[var(--motion-instant)]";
const chipTone = (active: boolean) =>
  active
    ? "border-transparent bg-accent-bg text-accent-text"
    : "border-border bg-bg-surface text-text-secondary hover:border-text-muted/40 hover:text-text-primary";
const COUNT = "text-[11.5px] font-medium tabular-nums opacity-70";
const CHIP_INPUT =
  "h-8 w-40 shrink-0 rounded-full border border-accent bg-bg-input px-3 text-[13px] text-text-primary outline-none placeholder:text-text-placeholder";

/**
 * The shelf's filters, as one row of chips under its title (design v2 §5:
 * 「筛选进内容区」). 全部 / 正在读 / 读完, then every collection. Collections
 * keep everything the sidebar gave them: create, rename and delete from the
 * context menu, and drag to reorder.
 */
export default function ShelfChips({ activeFilter, onFilterChange, bookCounts, collections: collectionsHook }: ShelfChipsProps) {
  const { t } = useTranslation();
  const { collections, create, rename, remove, reorder } = collectionsHook;
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; collection: Collection } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOrder, setDragOrder] = useState<string[]>([]);
  const dragOrderRef = useRef<string[]>([]);
  // A drag ends in a `click` on the chip it started on; that click must not
  // also select the collection.
  const swallowClickRef = useRef(false);

  const statusChips = [
    { id: "all", label: t("shelf.all"), count: bookCounts.all },
    { id: "reading", label: t("shelf.reading"), count: bookCounts.reading },
    { id: "finished", label: t("shelf.finished"), count: bookCounts.finished },
  ];

  const shown = dragId
    ? dragOrder.map((id) => collections.find((c) => c.id === id)).filter((c): c is Collection => Boolean(c))
    : collections;

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Horizontal drag: the chip's slot is the number of other chips whose
  // centre the pointer has passed. Centres are measured once at press time —
  // the row does not reflow under the pointer in a way that matters for that.
  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return;
    const row = event.currentTarget.parentElement;
    if (!row) return;
    const startX = event.clientX;
    const ids = collections.map((c) => c.id);
    const from = ids.indexOf(id);
    const centres = Array.from(row.querySelectorAll<HTMLElement>("[data-collection-chip]")).map((chip) => {
      const rect = chip.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    let dragging = false;

    const onMove = (ev: PointerEvent) => {
      if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      const slot = centres.filter((centre, index) => index !== from && ev.clientX > centre).length;
      const next = ids.filter((other) => other !== id);
      next.splice(slot, 0, id);
      dragOrderRef.current = next;
      setDragOrder(next);
      setDragId(id);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (!dragging) return;
      swallowClickRef.current = true;
      setDragId(null);
      const next = dragOrderRef.current;
      if (next.join() !== ids.join()) void reorder(next);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const submitCreate = async () => {
    const name = newName.trim();
    if (name) await create(name);
    setNewName("");
    setCreating(false);
  };

  const submitRename = async () => {
    const name = renameValue.trim();
    if (renamingId && name) await rename(renamingId, name);
    setRenamingId(null);
    setRenameValue("");
  };

  const deleteCollection = async (id: string) => {
    if (activeFilter === `collection:${id}`) onFilterChange("all");
    setMenu(null);
    await remove(id);
  };

  return (
    <div role="toolbar" aria-label={t("shelf.filtersLabel")} className="flex min-w-0 items-center gap-2 overflow-x-auto scrollbar-none">
      {statusChips.map((chip) => {
        const active = activeFilter === chip.id;
        return (
          <button
            key={chip.id}
            type="button"
            aria-pressed={active}
            onClick={() => onFilterChange(chip.id)}
            className={`${CHIP} ${chipTone(active)}`}
          >
            {chip.label}
            <span className={COUNT}>{chip.count}</span>
          </button>
        );
      })}

      {(shown.length > 0 || creating) && <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />}

      {shown.map((collection) => {
        const filter = `collection:${collection.id}`;
        const active = activeFilter === filter;
        if (renamingId === collection.id) {
          return (
            <form key={collection.id} onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
              <input
                autoFocus
                aria-label={t("sidebar.renameCollection")}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onBlur={() => { void submitRename(); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                }}
                className={CHIP_INPUT}
              />
            </form>
          );
        }
        return (
          <button
            key={collection.id}
            type="button"
            data-collection-chip
            aria-pressed={active}
            onPointerDown={(event) => startDrag(event, collection.id)}
            onClick={() => {
              if (swallowClickRef.current) { swallowClickRef.current = false; return; }
              onFilterChange(filter);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, collection });
            }}
            className={`${CHIP} ${chipTone(active)} touch-none ${dragId === collection.id ? "opacity-60" : ""}`}
          >
            {collection.name}
            <span className={COUNT}>{collection.book_count}</span>
          </button>
        );
      })}

      {creating ? (
        <form onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
          <input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onBlur={() => { if (!newName.trim()) setCreating(false); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { setNewName(""); setCreating(false); }
            }}
            placeholder={t("sidebar.collectionPlaceholder")}
            className={CHIP_INPUT}
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          aria-label={t("shelf.newCollection")}
          title={t("shelf.newCollection")}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-text-muted/40 text-text-muted transition-colors duration-[var(--motion-instant)] hover:border-accent hover:text-accent"
        >
          <Plus size={14} />
        </button>
      )}

      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="motion-pop fixed z-50 w-[180px] rounded-[10px] border border-border bg-bg-surface py-1 shadow-popover"
          style={{ left: Math.min(menu.x, window.innerWidth - 188), top: Math.min(menu.y, window.innerHeight - 96) }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenamingId(menu.collection.id);
              setRenameValue(menu.collection.name);
              setMenu(null);
            }}
            className="mx-1 flex h-[31.5px] w-[calc(100%-8px)] cursor-pointer items-center gap-3 rounded-sm px-3 text-left hover:bg-accent-bg"
          >
            <Pencil size={14} className="text-text-muted" />
            <span className="text-[13px] font-medium text-text-primary">{t("sidebar.renameCollection")}</span>
          </button>
          <div className="mx-3 my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            onClick={() => { void deleteCollection(menu.collection.id); }}
            className="mx-1 flex h-[31.5px] w-[calc(100%-8px)] cursor-pointer items-center gap-3 rounded-sm px-3 text-left hover:bg-accent-bg"
          >
            <Trash2 size={14} className="text-danger-text" />
            <span className="text-[13px] font-medium text-danger-text">{t("sidebar.deleteCollection")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
