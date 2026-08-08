import type { QuotedSource } from "../../hooks/useAiChat.ts";

/**
 * The one piece of state a jump between two books needs.
 *
 * `useJumpHistory` cannot carry this: its stack is per book and is cleared the
 * moment `bookId` changes, which is exactly what happens here. That is the
 * right behaviour for it — a CFI from one EPUB means nothing in another — so
 * this rides alongside rather than inside it.
 *
 * It travels in the router's navigation state and is kept for the length of the
 * visit, not persisted. A return offer that outlives the session would point at
 * a reading position the reader has since moved past, and the offer is only
 * worth anything while the detour is still fresh in their mind.
 */
export interface CrossBookJump {
  /** The sentence to anchor to in the book being opened. */
  quote: QuotedSource;
  /** Where to come back to. */
  from: {
    bookId: string;
    /** Reading position at the moment of leaving. Absent for a book with no
     *  CFI addressing (PDF), which simply reopens where it left off. */
    cfi?: string;
    /** Book title, for the return offer's wording. */
    title: string;
  };
}

function isQuotedSource(value: unknown): value is QuotedSource {
  if (!value || typeof value !== "object") return false;
  const quote = value as Record<string, unknown>;
  return typeof quote.marker === "string"
    && typeof quote.bookId === "string"
    && typeof quote.bookTitle === "string"
    && typeof quote.sectionIndex === "number"
    && typeof quote.text === "string";
}

/**
 * Read a jump out of the router's navigation state.
 *
 * Validated rather than cast: navigation state survives a reload and can be
 * anything a previous version of the app put there, and a half-shaped record
 * reaching the anchoring code would surface as a jump to nowhere.
 */
export function parseCrossBookJump(state: unknown): CrossBookJump | null {
  if (!state || typeof state !== "object") return null;
  const jump = (state as Record<string, unknown>).crossBookJump;
  if (!jump || typeof jump !== "object") return null;
  const { quote, from } = jump as Record<string, unknown>;
  if (!isQuotedSource(quote)) return null;
  if (!from || typeof from !== "object") return null;
  const origin = from as Record<string, unknown>;
  if (typeof origin.bookId !== "string" || !origin.bookId) return null;
  if (typeof origin.title !== "string") return null;
  return {
    quote,
    from: {
      bookId: origin.bookId,
      cfi: typeof origin.cfi === "string" && origin.cfi ? origin.cfi : undefined,
      title: origin.title,
    },
  };
}

/**
 * Navigation state for going back, in the shape the reader's existing
 * `location.state` handler already understands — a bare `cfi` is all it takes
 * to reopen a book at a position.
 */
export function crossBookReturnState(jump: CrossBookJump): { cfi?: string } {
  return jump.from.cfi ? { cfi: jump.from.cfi } : {};
}

/**
 * Whether a quote can be opened at all, versus only named.
 *
 * A quote whose book has since been removed from the library still belongs in
 * the answer — the sentence was real when it was retrieved and the answer was
 * built on it — but tapping it has nowhere to go, so the UI says so rather
 * than opening a blank reader.
 */
export function quoteIsReachable(quote: QuotedSource, libraryBookIds: Set<string>): boolean {
  return libraryBookIds.has(quote.bookId);
}
