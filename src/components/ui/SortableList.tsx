import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

/**
 * What a row spreads onto its grip to make that grip — and only that grip —
 * start a drag. `touchAction: "none"` is the whole reason a finger drag works
 * at all: without it the browser claims the gesture for scrolling long before
 * the 8px activation distance is met, so the handle would be a control that
 * does nothing. Confining that opt-out to the grip is also why the rest of the
 * row still scrolls the page under a finger.
 */
export interface SortableHandleProps {
  ref: (node: HTMLElement | null) => void;
  onPointerDown: (event: SyntheticEvent) => void;
  style: CSSProperties;
  "data-drag-handle": string;
}

interface SortableRenderState {
  dragging: boolean;
  overlay: boolean;
  handleProps: SortableHandleProps;
}

interface SortableListProps<T> {
  items: T[];
  getId: (item: T) => string;
  onReorder: (items: T[]) => void | Promise<void>;
  renderItem: (item: T, index: number, state: SortableRenderState) => ReactNode;
  disabled?: boolean | ((item: T) => boolean);
  className?: string;
}

const INTERACTIVE_SELECTOR = "input,textarea,select,a,[contenteditable='true'],[data-no-drag]";

function isInteractiveTarget(event: SyntheticEvent) {
  return (event.target as Element | null)?.closest(INTERACTIVE_SELECTOR) !== null;
}

function isHandleTarget(event: SyntheticEvent) {
  return (event.target as Element | null)?.closest("[data-drag-handle]") !== null;
}

/** The props a row spreads onto its grip; `null` where the list is not sortable. */
const NO_HANDLE: SortableHandleProps = {
  ref: () => {},
  onPointerDown: () => {},
  style: {},
  "data-drag-handle": "",
};

function SortableItem<T>({
  item,
  index,
  id,
  disabled,
  renderItem,
}: {
  item: T;
  index: number;
  id: string;
  disabled: boolean;
  renderItem: SortableListProps<T>["renderItem"];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id, disabled });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
  };
  const handleProps: SortableHandleProps = {
    ref: setActivatorNodeRef,
    onPointerDown: (event) => listeners?.onPointerDown?.(event),
    style: { touchAction: "none" },
    "data-drag-handle": "",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      onPointerDown={(event) => {
        if (isInteractiveTarget(event)) return;
        // The grip forwarded it already; forwarding again from the row would
        // hand dnd-kit the same press twice.
        if (isHandleTarget(event)) return;
        // A finger anywhere but the grip belongs to the page: mixing the two
        // means a list that sometimes reorders when it was asked to scroll.
        // A mouse keeps whole-row dragging — it has nothing to scroll with.
        if (event.pointerType === "touch") return;
        listeners?.onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (!(event.target as Element | null)?.closest("button,input,textarea,select,a,[contenteditable='true'],[data-no-drag]")) {
          listeners?.onKeyDown?.(event);
        }
      }}
      className={`relative outline-none ${disabled ? "" : "cursor-grab active:cursor-grabbing"} ${isDragging ? "opacity-35" : "opacity-100"}`}
    >
      {isOver && !isDragging && (
        <span className="pointer-events-none absolute inset-x-0 -top-px z-10 h-0.5 bg-accent" />
      )}
      {renderItem(item, index, { dragging: isDragging, overlay: false, handleProps })}
    </div>
  );
}

export default function SortableList<T>({
  items,
  getId,
  onReorder,
  renderItem,
  disabled = false,
  className,
}: SortableListProps<T>) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map(getId);
  const activeIndex = activeId ? ids.indexOf(activeId) : -1;
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
  const itemDisabled = (item: T) => typeof disabled === "function" ? disabled(item) : disabled;

  const finishDrag = (event: DragEndEvent) => {
    setActiveId(null);
    if (!event.over || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    void onReorder(arrayMove(items, from, to));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      autoScroll
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={finishDrag}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {items.map((item, index) => (
            <SortableItem
              key={getId(item)}
              item={item}
              index={index}
              id={getId(item)}
              disabled={itemDisabled(item)}
              renderItem={renderItem}
            />
          ))}
        </div>
      </SortableContext>
      {/*
        The overlay is portalled to the body because it is `position: fixed`,
        and a fixed element is only viewport-positioned while no ancestor has
        claimed it. Sortable lists live inside dialogs, and a dialog that is
        transformed — mid-entrance, or filling a finished entrance — becomes
        the containing block for everything fixed inside it: the preview then
        sits offset by the dialog's own top-left and is clipped at its edge.
        Rendering it at the body keeps that out of the list's hands entirely.
      */}
      {createPortal(
        <DragOverlay dropAnimation={{ duration: 160, easing: "ease" }}>
          {activeItem ? (
            <div className="cursor-grabbing overflow-hidden rounded-md bg-bg-surface opacity-95 shadow-context">
              {renderItem(activeItem, activeIndex, { dragging: true, overlay: true, handleProps: NO_HANDLE })}
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}
