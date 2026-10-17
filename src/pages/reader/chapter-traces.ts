/**
 * The right card's 「本章」 (design §12): what the reader left in this chapter,
 * as one list rather than three tabs — words, then highlights and notes, then
 * the questions they asked. Only what the reader made goes in; the reading
 * engine's own auto-highlights stay out (rule ④).
 *
 * A chapter is a range of spine sections (`currentScope` in the reader), and a
 * trace belongs to it by the section its CFI names. Reading the section off the
 * CFI's first step needs no live view and no async resolve, so the list can be
 * built the moment its rows arrive.
 */

export interface ChapterScope {
  start?: number;
  /** Inclusive; undefined runs to the end of the book. */
  end?: number;
}

/**
 * The spine section a CFI points into: `epubcfi(/6/N…)` is section N/2 − 1.
 * Null for anything that is not an EPUB-style CFI (a text book's `textloc:`).
 */
export function cfiSectionIndex(cfi: string | null | undefined): number | null {
  if (!cfi) return null;
  const match = /^epubcfi\(\/6\/(\d+)/.exec(cfi);
  if (!match) return null;
  const step = Number(match[1]);
  if (step < 2 || step % 2 !== 0) return null;
  return step / 2 - 1;
}

export function inChapter(section: number | null | undefined, scope: ChapterScope): boolean {
  if (section == null || scope.start === undefined) return false;
  return section >= scope.start && (scope.end === undefined || section <= scope.end);
}

/** A question as the list reads it: the reader's own message in a saved chat. */
export interface ChapterQuestion {
  id: string;
  chatId: string;
  text: string;
  createdAt: number;
}

/** The fields of a `list_chat_messages` row the list reads. */
export interface ChatMessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  metadata: string | null;
  created_at: number;
}

/**
 * Which questions were asked in this chapter. A question carries the section
 * it was asked from in its metadata (`sectionIndex`, the scope's start when
 * one was known) and, when it began from a selection, that selection's CFI;
 * either places it.
 */
export function chapterQuestions(messages: readonly ChatMessageRow[], scope: ChapterScope): ChapterQuestion[] {
  const questions: ChapterQuestion[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !message.content.trim()) continue;
    let section: number | null;
    try {
      const metadata = message.metadata ? JSON.parse(message.metadata) as Record<string, unknown> : null;
      const index = metadata?.sectionIndex;
      section = typeof index === "number" && Number.isInteger(index) && index >= 0
        ? index
        : cfiSectionIndex(typeof metadata?.cfi === "string" ? metadata.cfi : null);
    } catch {
      section = null;
    }
    if (!inChapter(section, scope)) continue;
    questions.push({ id: message.id, chatId: message.chat_id, text: message.content.trim(), createdAt: message.created_at });
  }
  return questions.sort((left, right) => left.createdAt - right.createdAt);
}
