import type { PointerEvent as ReactPointerEvent, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, X } from "lucide-react";
import Button from "../../components/ui/Button";
import { isOpen, type RightView, type Side, type SideMode } from "./reader-sides";

interface ReaderRightSideProps {
  side: Side<RightView>;
  /** The mode the card is laid out in: a float with no room beside the text sits down as pinned. */
  layoutMode: SideMode;
  /** True when it sits only because floating would cover text; the pin then has nothing to change. */
  seated: boolean;
  width: number;
  slotWidth: number;
  slotRef: Ref<HTMLDivElement>;
  cardRef: Ref<HTMLDivElement>;
  /** Whether the 「划线笔记」 view exists for this format. */
  canShowTraces: boolean;
  onShowView: (view: RightView) => void;
  onPin: () => void;
  onClose: () => void;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
}

/**
 * The reader's right side on a wide screen (「浮笺」, design §10–11): one card
 * for the conversation and the traces, inset from the window.
 *
 * Floating, it lies over the right margin and the page at most steps aside
 * (the reader translates it; nothing reflows). Pinned, the slot before it opens
 * to its width and the page reflows once. Where the text leaves no room to
 * float — the default two columns, say — it opens seated, which is pinned by
 * another name: it never covers a word.
 */
export default function ReaderRightSide({
  side,
  layoutMode,
  seated,
  width,
  slotWidth,
  slotRef,
  cardRef,
  canShowTraces,
  onShowView,
  onPin,
  onClose,
  onResizePointerDown,
  children,
}: ReaderRightSideProps) {
  const { t } = useTranslation();
  const open = isOpen(side);
  const pinned = layoutMode === "pinned";

  const segment = (view: RightView, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={side.view === view}
      onClick={() => onShowView(view)}
      className={`relative h-full cursor-pointer text-[14px] transition-colors ${
        side.view === view ? "font-semibold text-text-primary" : "text-text-muted hover:text-text-secondary"
      }`}
    >
      {label}
      <span
        aria-hidden
        className={`absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-accent transition-opacity duration-[var(--motion-fast)] ${side.view === view ? "opacity-100" : "opacity-0"}`}
      />
    </button>
  );

  return (
    <>
      <div
        ref={slotRef}
        aria-hidden
        className="h-full shrink-0 transition-[width] duration-[var(--motion-travel)] ease-[var(--ease-out-soft)] motion-reduce:transition-none"
        style={{ width: slotWidth }}
      />
      <div
        ref={cardRef}
        className={`absolute top-3 right-3 bottom-3 z-30 flex flex-col overflow-hidden rounded-[16px] bg-bg-muted transition-[translate,opacity,box-shadow] duration-[var(--motion-base)] ease-[var(--ease-out-soft)] motion-reduce:transition-none ${
          open ? "" : "pointer-events-none translate-x-[calc(100%+12px)] opacity-0"
        } ${pinned ? "border border-border shadow-card" : "shadow-popover"}`}
        style={{ width }}
        inert={!open}
      >
        <div
          onPointerDown={onResizePointerDown}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-accent/30 transition-colors"
        />
        <div className="flex h-11 shrink-0 items-stretch gap-4 border-b border-border bg-bg-surface pl-4 pr-1.5">
          <div role="tablist" aria-label={t("reader.side.rightViews")} className="flex items-stretch gap-4">
            {segment("ai", t("reader.side.conversation"))}
            {canShowTraces && segment("traces", t("reader.traces.title"))}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="icon"
              size="sm"
              active={pinned}
              aria-pressed={pinned}
              disabled={seated}
              aria-label={seated ? t("reader.side.seated") : pinned ? t("reader.side.unpin") : t("reader.side.pin")}
              title={seated ? t("reader.side.seated") : pinned ? t("reader.side.unpin") : t("reader.side.pin")}
              onClick={onPin}
            >
              {pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </Button>
            <Button
              variant="icon"
              size="sm"
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            >
              <X size={15} />
            </Button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}
