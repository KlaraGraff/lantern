import type { DictionaryWord } from "../../hooks/useDictionary";

/**
 * Mirrors src-tauri/src/commands/review_piles.rs's `ReviewPileKind`/`ReviewPile`
 * exactly — the backend is the source of truth for shape and ordering. The
 * board renders `list_review_piles()`'s result as-is; nothing here re-sorts it.
 */
export type ReviewPileKind =
  | {
      kind: "repeat_lookups_in_book";
      book_id: string;
      book_title: string;
      /** AI cards, and dictionary checks, counted separately — see `pileReasonKey`. Both null unless the pile holds exactly one word. */
      solo_word_lookups: number | null;
      solo_word_glances: number | null;
    }
  | { kind: "promoted_then_looked_up" }
  | { kind: "recent_chapter_lookups"; book_id: string; book_title: string; chapter: string }
  | { kind: "long_unseen" };

export interface ReviewPile {
  kind: ReviewPileKind;
  word_ids: string[];
  words: DictionaryWord[];
  newest_activity_at: number;
}

export interface CappedChips {
  visible: DictionaryWord[];
  /** Count of words folded into the trailing "+N" chip; 0 means no overflow chip. */
  overflow: number;
}

/**
 * A pile's card shows at most `cap` word chips; the rest collapse into one
 * "+N" chip. A pile at or under the cap shows every word and no overflow chip
 * — piles have no minimum size, so a 3-word pile is not padded or merged.
 */
export function capPileChips(words: DictionaryWord[], cap = 4): CappedChips {
  if (words.length <= cap) return { visible: words, overflow: 0 };
  return { visible: words.slice(0, cap), overflow: words.length - cap };
}

/** Stable React key for a pile — the backend gives piles no id of their own. */
export function pileKey(pile: Pick<ReviewPile, "kind">): string {
  const kind = pile.kind;
  switch (kind.kind) {
    case "repeat_lookups_in_book":
      return `repeat_lookups_in_book:${kind.book_id}`;
    case "recent_chapter_lookups":
      return `recent_chapter_lookups:${kind.book_id}:${kind.chapter}`;
    case "promoted_then_looked_up":
      return "promoted_then_looked_up";
    case "long_unseen":
      return "long_unseen";
  }
}

export interface SplitReviewPiles {
  /** Everything except `long_unseen`, in the order the backend returned them. */
  cards: ReviewPile[];
  /** The one `long_unseen` pile, demoted to the quieter "Also" section — absent when the backend omitted it. */
  longUnseen: ReviewPile | null;
}

/**
 * Separates the main card grid from the demoted "还有"/"Also" section, which
 * holds only `long_unseen`. The backend already drops empty piles and always
 * places `long_unseen` last, so this is a pure partition, not a re-sort.
 */
export function splitReviewPiles(piles: ReviewPile[]): SplitReviewPiles {
  const cards = piles.filter((pile) => pile.kind.kind !== "long_unseen");
  const longUnseen = piles.find((pile) => pile.kind.kind === "long_unseen") ?? null;
  return { cards, longUnseen };
}

export interface PileCopyKey {
  key: string;
  params?: Record<string, string>;
}

/** i18n key (and interpolation params, if any) for a pile's title. */
export function pileTitleKey(kind: ReviewPileKind): PileCopyKey {
  switch (kind.kind) {
    case "repeat_lookups_in_book":
      return { key: "reviewBoard.pile.repeatLookupsInBook.title", params: { book: kind.book_title } };
    case "promoted_then_looked_up":
      return { key: "reviewBoard.pile.promotedThenLookedUp.title" };
    case "recent_chapter_lookups":
      return { key: "reviewBoard.pile.recentChapterLookups.title", params: { chapter: kind.chapter } };
    case "long_unseen":
      return { key: "reviewBoard.pile.longUnseen.title" };
  }
}

/**
 * i18n key (and interpolation params) for a pile's 来由/reason sentence.
 * `repeat_lookups_in_book` is the only kind with variants: a one-word pile
 * reads its own repeat count as the point, rather than "more than once in
 * this book" — chosen by word-count, not by anything the caller decides. That
 * count then splits three ways by *how* the reader stopped, the same split
 * `mastery-explanation.ts` makes: cards only, dictionary only, or both. Four
 * dictionary checks are not "you looked it up four times", so the sentence
 * names what actually happened.
 * `ago` is a pre-formatted relative-time string (see `../../utils/timeAgo`);
 * this module stays i18n-agnostic, so it takes the resolved string, not a
 * timestamp.
 */
export function pileReasonKey(pile: Pick<ReviewPile, "kind" | "word_ids">, ago?: string): PileCopyKey {
  const kind = pile.kind;
  switch (kind.kind) {
    case "repeat_lookups_in_book":
      if (pile.word_ids.length === 1) {
        const cards = kind.solo_word_lookups ?? 0;
        const glances = kind.solo_word_glances ?? 0;
        if (glances === 0) {
          return {
            key: "reviewBoard.pile.repeatLookupsInBook.reasonSolo",
            params: { count: String(cards) },
          };
        }
        if (cards === 0) {
          return {
            key: "reviewBoard.pile.repeatLookupsInBook.reasonSoloGlances",
            params: { glances: String(glances) },
          };
        }
        return {
          key: "reviewBoard.pile.repeatLookupsInBook.reasonSoloMixed",
          params: { count: String(cards), glances: String(glances) },
        };
      }
      return { key: "reviewBoard.pile.repeatLookupsInBook.reason" };
    case "promoted_then_looked_up":
      return { key: "reviewBoard.pile.promotedThenLookedUp.reason" };
    case "recent_chapter_lookups":
      return { key: "reviewBoard.pile.recentChapterLookups.reason", params: { ago: ago ?? "" } };
    case "long_unseen":
      return { key: "reviewBoard.pile.longUnseen.reason" };
  }
}
