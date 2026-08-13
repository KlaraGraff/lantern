import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { savedHighlightColor } from "./mark-palette";
import { anchorTransformOrigin } from "./motion";

/** How far above the highlight the toolbar sits, so it clears the text. */
const TOOLBAR_LIFT = 44;
/** Breathing room kept between the toolbar and the window edge. */
const VIEWPORT_MARGIN = 8;

interface HighlightToolbarProps {
  x: number;
  y: number;
  color: string;
  note: string | null;
  onChangeColor: (color: string) => void;
  onSaveNote: (note: string) => void;
  onDeleteNote: () => void;
  onDeleteHighlight: () => void;
  onClose: () => void;
}

/**
 * The popover for an existing highlight: recolor, edit its note, delete it.
 *
 * Delete is a single click when there is no note to lose — the same directness
 * the row-level delete always had. Once a note exists, one click can no longer
 * silently take it with the highlight, so the trash icon opens a two-way choice
 * instead of acting immediately.
 */
export default function HighlightToolbar({
  x,
  y,
  color,
  note,
  onChangeColor,
  onSaveNote,
  onDeleteNote,
  onDeleteHighlight,
  onClose,
}: HighlightToolbarProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(note ?? "");
  const [deleteMenuOpen, setDeleteMenuOpen] = useState(false);
  const hasNote = Boolean(note?.trim());

  useEffect(() => {
    setNoteDraft(note ?? "");
  }, [note]);

  useEffect(() => {
    if (noteOpen) textareaRef.current?.focus();
  }, [noteOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Clamp position to viewport, then point the entry animation at the
  // highlight. Layout size rather than the rendered rect, and before paint
  // rather than after, because the toolbar is mid-scale on the frame this
  // runs — a rect would be short and an after-paint write would show the
  // toolbar in the wrong place first.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const width = element.offsetWidth;
    let left = x;
    let top = y - TOOLBAR_LIFT;
    if (left + width > window.innerWidth) left = x - width;
    if (left < 0) left = VIEWPORT_MARGIN;
    if (top < 0) top = VIEWPORT_MARGIN;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    anchorTransformOrigin(element, { x, y }, { left, top });
  }, [x, y]);

  const handleSaveNote = () => {
    onSaveNote(noteDraft.trim());
    setNoteOpen(false);
  };

  return (
    <div
      ref={ref}
      className="motion-pop fixed z-50 flex flex-col w-[220px] gap-2 p-2 bg-bg-surface/95 backdrop-blur-sm rounded-2xl shadow-context"
      style={{ left: x, top: y - TOOLBAR_LIFT }}
    >
      <div className="flex items-center gap-2 px-1 h-7">
        {Object.entries(savedHighlightColor).map(([name, hex]) => (
          <div
            key={name}
            onClick={() => onChangeColor(name)}
            /* The dot stays 14px; a transparent pseudo-element carries the
               touch target. It grows to a full 44px vertically but only into
               half the gap horizontally: five swatches at 44px wide do not fit
               a 220px toolbar that also holds the note and delete buttons, and
               overlapping targets would be worse than small ones — the later
               sibling paints on top, so every tap near a boundary would pick
               the colour to its right. */
            className="relative flex shrink-0 cursor-pointer items-center justify-center touch:before:absolute touch:before:content-[''] touch:before:-inset-x-[3px] touch:before:-inset-y-[15px]"
          >
            <div
              className={`w-[14px] h-[14px] rounded-full transition-transform ${
                name === color
                  ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-surface scale-110"
                  : "hover:scale-110"
              }`}
              style={{ backgroundColor: hex }}
            />
          </div>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setNoteOpen((open) => !open)}
          aria-label={t("bookmarks.highlightNoteButton")}
          className={`p-1 rounded-full cursor-pointer hover:bg-bg-input transition-colors ${
            hasNote ? "text-accent-text" : "text-text-muted"
          }`}
        >
          <StickyNote size={14} />
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => (hasNote ? setDeleteMenuOpen((open) => !open) : onDeleteHighlight())}
            aria-label={t("common.delete")}
            className="p-1 rounded-full cursor-pointer text-text-muted hover:bg-danger-bg hover:text-danger-text transition-colors"
          >
            <Trash2 size={14} />
          </button>
          {deleteMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-[172px] rounded-md border border-border bg-bg-surface py-1 shadow-context z-10">
              <button
                type="button"
                onClick={() => { setDeleteMenuOpen(false); onDeleteNote(); }}
                className="flex w-full items-center px-3 h-8 text-left text-[12px] text-text-primary hover:bg-bg-input cursor-pointer"
              >
                {t("bookmarks.deleteNoteOnly")}
              </button>
              <button
                type="button"
                onClick={() => { setDeleteMenuOpen(false); onDeleteHighlight(); }}
                className="flex w-full items-center px-3 h-8 text-left text-[12px] text-danger-text hover:bg-danger-bg cursor-pointer"
              >
                {t("bookmarks.deleteHighlightAndNote")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        className={`overflow-hidden transition-all duration-150 motion-reduce:transition-none ${
          noteOpen ? "max-h-40 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        <div className="flex flex-col gap-1.5 px-1 pt-0.5 pb-0.5">
          <textarea
            ref={textareaRef}
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder={t("bookmarks.highlightNotePlaceholder")}
            rows={3}
            className="w-full resize-none rounded-md bg-bg-input px-2 py-1.5 text-[13px] text-text-primary placeholder:text-text-placeholder outline-none focus:ring-1 focus:ring-accent"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveNote}
              className="text-[13px] font-medium text-accent-text hover:opacity-70 cursor-pointer"
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
