import { useEffect, useRef, useState } from "react";
import { StickyNote, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { savedHighlightColor } from "./mark-palette";

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

  // Clamp position to viewport
  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    if (rect.right > vw) {
      ref.current.style.left = `${x - rect.width}px`;
    }
    if (rect.left < 0) {
      ref.current.style.left = "8px";
    }
    if (rect.top < 0) {
      ref.current.style.top = "8px";
    }
  }, [x, y]);

  const handleSaveNote = () => {
    onSaveNote(noteDraft.trim());
    setNoteOpen(false);
  };

  return (
    <div
      ref={ref}
      className="fixed z-50 flex flex-col w-[220px] gap-2 p-2 bg-bg-surface/95 backdrop-blur-sm rounded-2xl shadow-context"
      style={{ left: x, top: y - 44 }}
    >
      <div className="flex items-center gap-2 px-1 h-7">
        {Object.entries(savedHighlightColor).map(([name, hex]) => (
          <div
            key={name}
            onClick={() => onChangeColor(name)}
            className={`w-[14px] h-[14px] rounded-full cursor-pointer transition-transform shrink-0 ${
              name === color
                ? "ring-2 ring-accent ring-offset-1 ring-offset-bg-surface scale-110"
                : "hover:scale-110"
            }`}
            style={{ backgroundColor: hex }}
          />
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
