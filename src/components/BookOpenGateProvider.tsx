import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { Book } from "../hooks/useBooks";
import { getBookDifficulty } from "../hooks/useBookDifficulty";
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
   *  `useOpenBook()`, now routed through the mockup §0 gate first. Decides
   *  for itself whether that means the reader or the card. */
  requestOpen: (book: Book, target?: ReaderTarget) => void;
  /** The feature's one master switch, read here so no second surface has to
   *  know the key's name or its default. */
  openCardEnabled: boolean;
  /** Turn the whole feature off and offer the undo. Does not navigate — the
   *  card's own button pairs this with continuing into the reader, the
   *  reader-top strip is already there. */
  hideOpenCardForever: () => void;
}

const GateContext = createContext<GateContextValue | null>(null);

export function useBookOpenGate(): GateContextValue["requestOpen"] {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error("useBookOpenGate must be used within BookOpenGateProvider");
  return ctx.requestOpen;
}

/**
 * The master switch and its off button, for the feature's *other* surface —
 * `BookReaderDifficultyStrip`, which is the form the open card takes once a
 * book is already being read.
 *
 * Shared rather than reimplemented so the two surfaces cannot drift: one
 * settings key, one undo toast, one piece of copy. A strip that owned its own
 * copy of this would be a second thing to turn off, which is exactly what the
 * Settings row's comment warns against.
 */
export function useOpenCardControls(): Pick<GateContextValue, "openCardEnabled" | "hideOpenCardForever"> {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error("useOpenCardControls must be used within BookOpenGateProvider");
  return ctx;
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
  // the feature off says nothing the toast's copy needs, and the strip's own
  // off button has no book to hand over in the first place.
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimerRef = useRef<number | undefined>(undefined);

  const enabled = settings[BOOK_OPEN_CARD_ENABLED_KEY] !== "false";

  const requestOpen = useCallback((book: Book, target?: ReaderTarget) => {
    // A book already being read never gets the card (mockup §0) — and since
    // that is true regardless of what `book_difficulty` says, there is
    // nothing here worth a backend round trip for.
    if (book.status === "reading") {
      openInReader(book.id, target);
      return;
    }
    const sessionDismissed = sessionDismissedRef.current.has(book.id);
    if (!enabled || sessionDismissed) {
      openInReader(book.id, target);
      return;
    }
    getBookDifficulty(book.id)
      .then((difficulty) => {
        const surface = openSurface(book, difficulty, { enabled, sessionDismissed });
        if (surface === "card") {
          setCardState({ book, target });
        } else {
          openInReader(book.id, target);
        }
      })
      .catch(() => {
        // Fail open: a gate that cannot reach its own decision must not be
        // the reason a book will not open.
        openInReader(book.id, target);
      });
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

  const hideOpenCardForever = useCallback(() => {
    void saveBulk({ [BOOK_OPEN_CARD_ENABLED_KEY]: "false" });
    if (undoTimerRef.current !== undefined) window.clearTimeout(undoTimerRef.current);
    setUndoVisible(true);
    undoTimerRef.current = window.setTimeout(() => setUndoVisible(false), UNDO_WINDOW_MS);
  }, [saveBulk]);

  const hideForever = useCallback(() => {
    if (!cardState) return;
    const { book, target } = cardState;
    setCardState(null);
    hideOpenCardForever();
    // The button just told the reader the card is getting out of their way —
    // "不挽留": it does not also hold the door shut on the book they were
    // trying to open while the toast makes its case. This exact sequencing
    // (write the setting, then continue straight into the reader) is not
    // spelled out in the mockup text; it is the reading that best fits the
    // "no residual UI, ever" rule in §7.
    openInReader(book.id, target);
  }, [cardState, hideOpenCardForever, openInReader]);

  const undoHide = useCallback(() => {
    if (undoTimerRef.current !== undefined) window.clearTimeout(undoTimerRef.current);
    setUndoVisible(false);
    void saveBulk({ [BOOK_OPEN_CARD_ENABLED_KEY]: "true" });
  }, [saveBulk]);

  const value = useMemo(
    () => ({ requestOpen, openCardEnabled: enabled, hideOpenCardForever }),
    [requestOpen, enabled, hideOpenCardForever],
  );

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
