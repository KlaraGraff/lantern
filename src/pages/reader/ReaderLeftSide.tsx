import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { List, Pin, PinOff, Search } from "lucide-react";
import Button from "../../components/ui/Button";
import type { SpineSegment } from "./reader-spine";
import { LEFT_CARD_WIDTH, isOpen, type LeftView, type Side } from "./reader-sides";

/** Design §11: resting this long on the spine peeks the card; leaving for this long ends the peek. */
const PEEK_IN_MS = 120;
const PEEK_OUT_MS = 180;

interface ReaderLeftSideProps {
  side: Side<LeftView>;
  segments: SpineSegment[];
  /** The room the page gives a pinned card. Transitions; `slotRef` is how the reader watches it. */
  slotWidth: number;
  slotRef: Ref<HTMLDivElement>;
  chapterCount: number;
  /** Search is not offered for every format; without it the card has no view switch. */
  canSearch: boolean;
  /** Resting the mouse on the edge peeks the card; Settings → Reading can turn it off. */
  peekOnHover: boolean;
  onPeek: () => void;
  onEndPeek: () => void;
  onPin: () => void;
  onShowView: (view: LeftView) => void;
  children: ReactNode;
}

/**
 * The reader's left side on a wide screen (「浮笺」, design §11): the 3px spine
 * along the edge, and the card it opens into.
 *
 * The card floats over the page and never moves it, except when pinned: then
 * the slot before the page opens to the card's width plus its insets, once.
 * Below the breakpoint the reader renders none of this; the TOC and search
 * stay the full-screen sheets they are on a phone.
 */
export default function ReaderLeftSide({
  side,
  segments,
  slotWidth,
  slotRef,
  chapterCount,
  canSearch,
  peekOnHover,
  onPeek,
  onEndPeek,
  onPin,
  onShowView,
  children,
}: ReaderLeftSideProps) {
  const { t } = useTranslation();
  const open = isOpen(side);
  const pinned = side.mode === "pinned";
  const peeking = side.mode === "peek";
  const peekTimer = useRef(0);

  const clearTimer = () => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = 0;
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);

  const scheduleEndPeek = () => {
    if (!peeking) return;
    clearTimer();
    peekTimer.current = window.setTimeout(onEndPeek, PEEK_OUT_MS);
  };

  // The short name: the card's header also carries the count, search and the pin.
  const title = side.view === "search" ? t("reader.search.title") : t("reader.side.contents");

  return (
    <>
      <div
        ref={slotRef}
        aria-hidden
        className="h-full shrink-0 transition-[width] duration-[var(--motion-travel)] ease-[var(--ease-out-soft)] motion-reduce:transition-none"
        style={{ width: slotWidth }}
      />

      {/* The edge zone. Wider than the spine so the pointer can find it, and
          gone while a standing card covers it. Mouse only: a finger or a pen
          resting on the edge is a page turn or a scroll, not a question. */}
      {(!open || peeking) && (
        <div
          className="group/spine absolute inset-y-0 left-0 z-20 w-6"
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse" || !peekOnHover) return;
            clearTimer();
            if (!peeking) peekTimer.current = window.setTimeout(onPeek, PEEK_IN_MS);
          }}
          onPointerLeave={() => {
            if (peeking) scheduleEndPeek();
            else clearTimer();
          }}
          // A press is a page turn or a selection starting at the margin.
          onPointerDown={clearTimer}
        >
          <div
            aria-hidden
            className={`absolute inset-y-4 left-2 flex w-[3px] flex-col gap-[2px] transition-opacity duration-[var(--motion-fast)] ${open ? "opacity-0" : "opacity-60 group-hover/spine:opacity-100"}`}
          >
            {segments.map((segment) => (
              <div
                key={segment.start}
                className="relative min-h-[2px] overflow-hidden rounded-full bg-border"
                style={{ flexGrow: segment.end - segment.start, flexBasis: 0 }}
              >
                <div
                  className={`absolute inset-x-0 top-0 rounded-full ${segment.current ? "bg-accent" : "bg-accent/70"}`}
                  style={{ height: `${segment.fill * 100}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div
        className={`absolute top-3 bottom-3 left-3 z-30 flex flex-col overflow-hidden rounded-[14px] bg-bg-surface transition-[translate,opacity,box-shadow] duration-[var(--motion-base)] ease-[var(--ease-out-soft)] motion-reduce:transition-none ${
          open ? "" : "pointer-events-none -translate-x-[calc(100%+12px)] opacity-0"
        } ${pinned ? "border border-border shadow-card" : "shadow-popover"}`}
        style={{ width: LEFT_CARD_WIDTH }}
        inert={!open}
        onPointerEnter={clearTimer}
        onPointerLeave={scheduleEndPeek}
      >
        <div className="flex shrink-0 items-center gap-0.5 py-2.5 pl-4 pr-2">
          <h2 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[15px] font-semibold leading-5 text-text-primary">
            <span className="truncate">{title}</span>
            {side.view === "toc" && chapterCount > 0 && (
              <span className="shrink-0 text-[12px] font-normal text-text-muted">
                {t("reader.side.chapterCount", { count: chapterCount })}
              </span>
            )}
          </h2>
          {canSearch && (
            <Button
              variant="icon"
              size="sm"
              aria-label={side.view === "search" ? t("reader.tocTitle") : t("reader.search.open")}
              title={side.view === "search" ? t("reader.tocTitle") : t("reader.search.open")}
              onClick={() => onShowView(side.view === "search" ? "toc" : "search")}
            >
              {side.view === "search" ? <List size={15} /> : <Search size={15} />}
            </Button>
          )}
          <Button
            variant="icon"
            size="sm"
            active={pinned}
            aria-pressed={pinned}
            aria-label={pinned ? t("reader.side.unpin") : t("reader.side.pin")}
            title={pinned ? t("reader.side.unpin") : t("reader.side.pin")}
            onClick={onPin}
          >
            {pinned ? <PinOff size={15} /> : <Pin size={15} />}
          </Button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </>
  );
}
