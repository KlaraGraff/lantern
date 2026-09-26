import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

export function BookSortContext({ ids, enabled, list, onMove, children }: {
  ids: string[];
  enabled: boolean;
  list: boolean;
  onMove: (from: number, to: number) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!enabled || !over || active.id === over.id) return;
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from >= 0 && to >= 0) onMove(from, to);
      }}
    >
      <SortableContext items={ids} strategy={list ? verticalListSortingStrategy : rectSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function SortableBookItem({ id, enabled, list, children }: {
  id: string;
  enabled: boolean;
  list: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !enabled });
  return (
    <div
      ref={setNodeRef}
      className={`relative min-w-0 ${isDragging ? "z-10 opacity-70" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children}
      {enabled && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={t("home.moveBook")}
          className={`absolute z-20 grid size-9 place-items-center rounded-md bg-bg-surface/95 text-text-secondary shadow-card cursor-grab active:cursor-grabbing ${list ? "right-6 top-6" : "right-2 top-2"}`}
          style={{ touchAction: "none" }}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={17} />
        </button>
      )}
    </div>
  );
}
