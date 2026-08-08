import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { useOpenBook } from "../hooks/useOpenBook";
import { useSettings } from "../hooks/useSettings";
import type { ReaderTarget } from "../utils/openReaderWindow";
import { openSurface } from "./book-open-card-view";
import BookOpenCard from "./BookOpenCard";
import Toast from "./ui/Toast";

/** Same `settings` table key the Settings → Reading row reads and writes —
 *  see that row's own comment for why this must never fork into two keys. */
const BOOK_OPEN_CARD_ENABLED_KEY = "book_open_card_enabled";

const UNDO_WINDOW_MS = 6000;

interface CardState {
  book: Book;
  target?: ReaderTarget;
}

interface GateContextValue {
  /** "Open this book" — the same call every cover click already made through
   *  `useOpenBook()`, now routed through the first-open gate first. Decides
   *  for itself whether that means the reader or the card. */
  requestOpen: (book: Book, target?: ReaderTarget) => void;
}

const GateContext = createContext<GateContextValue | null>(null);

export function useBookOpenGate(): GateContextValue["requestOpen"] {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error("useBookOpenGate must be used within BookOpenGateProvider");
  return ctx.requestOpen;
}

/**
 * Mounted once, near the top of the app (`App.tsx`'s `AppContent`), so every
 * cover-click call site shares one card, one session-dismiss list, and one
 * undo toast instead of each reinventing the gate.
 */
export default function BookOpenGateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const openInReader = useOpenBook();
  const { settings, saveBulk } = useSettings();

  // A ref, not state: which books got their ✕ pressed this session gates
  // *future* clicks, it never needs to repaint anything on its own account.
  const sessionDismissedRef = useRef<Set<string>>(new Set());
  const [cardState, setCardState] = useState<CardState | null>(null);
  // Just "is the toast up": which book the reader was opening when they turned
  // the feature off says nothing the toast's copy needs.
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimerRef = useRef<number | undefined>(undefined);

  const enabled = settings[BOOK_OPEN_CARD_ENABLED_KEY] !== "false";

  // Deliberately synchronous, with no `await` anywhere on this path: opening a
  // book is the app's most-pressed button, and every millisecond between the
  // click and the reader is felt. It used to ask the backend for the book's
  // difficulty row before deciding — a round trip whose answer could not change
  // the decision, because a never-opened book gets the card whatever that row
  // says. Everything the card itself needs is fetched by the card, behind its
  // own loading states, after it is already on screen.
  const requestOpen = useCallback((book: Book, target?: ReaderTarget) => {
    const sessionDismissed = sessionDismissedRef.current.has(book.id);
    if (openSurface(book, { enabled, sessionDismissed }) === "card") {
      setCardState({ book, target });
      return;
    }
    openInReader(book.id, target);
  }, [enabled, openInReader]);

  const closeCard = useCallback(() => {
    if (cardState) sessionDismissedRef.current.add(cardState.book.id);
    setCardState(null);
  }, [cardState]);

  const continueToReader = useCallback(() => {
    if (!cardState) return;
    const { book, target } = cardState;
    sessionDismissedRef.current.add(book.id);
    setCardState(null);
    openInReader(book.id, target);
  }, [cardState, openInReader]);

  const hideForever = useCallback(() => {
    if (!cardState) return;
    const { book, target } = cardState;
    setCardState(null);
    void saveBulk({ [BOOK_OPEN_CARD_ENABLED_KEY]: "false" });
    if (undoTimerRef.current !== undefined) window.clearTimeout(undoTimerRef.current);
    setUndoVisible(true);
    undoTimerRef.current = window.setTimeout(() => setUndoVisible(false), UNDO_WINDOW_MS);
    // The button just told the reader the card is getting out of their way —
    // "不挽留": it does not also hold the door shut on the book they were
    // trying to open while the toast makes its case. This exact sequencing
    // (write the setting, then continue straight into the reader) is not
    // spelled out in the mockup text; it is the reading that best fits the
    // "no residual UI, ever" rule in §7.
    openInReader(book.id, target);
  }, [cardState, saveBulk, openInReader]);

  const undoHide = useCallback(() => {
    if (undoTimerRef.current !== undefined) window.clearTimeout(undoTimerRef.current);
    setUndoVisible(false);
    void saveBulk({ [BOOK_OPEN_CARD_ENABLED_KEY]: "true" });
  }, [saveBulk]);

  const value = useMemo(() => ({ requestOpen }), [requestOpen]);

  return (
    <GateContext.Provider value={value}>
      {children}
      {cardState ? (
        <BookOpenCard
          book={cardState.book}
          onClose={closeCard}
          onContinue={continueToReader}
          onHideForever={hideForever}
        />
      ) : null}
      {undoVisible ? (
        <Toast icon={<Check size={14} className="shrink-0 text-success-text" />}>
          {t("bookOpenCard.undoToastMessage")}{" "}
          <button type="button" onClick={undoHide} className="font-medium text-accent-text underline underline-offset-2">
            {t("bookOpenCard.undo")}
          </button>
        </Toast>
      ) : null}
    </GateContext.Provider>
  );
}
