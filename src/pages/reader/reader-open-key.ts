/**
 * Identifies one open of one book file.
 *
 * The reader's foliate effect keys off this string and nothing else. That is
 * the whole point: the effect used to depend on the `book` object plus the
 * interaction callbacks, and both change identity a beat after the book row
 * arrives — the reader's settings and handlers resolve on their own async
 * path. Every open therefore ran twice, the second fetch and `makeBook` parse
 * starting while the first was still in flight, and the two raced inside
 * foliate-js. Keyed on the file's own identity, an ordinary settings or
 * handler update can no longer reopen anything.
 *
 * Returns null when there is nothing to open — no book, a book whose file
 * isn't on disk yet, a text book (which uses its own reader), or settings that
 * haven't loaded. The open sequence bakes settings in, so starting before they
 * land would itself force a second open.
 */
export interface ReaderOpenKeyInput {
  book: {
    id: string;
    file_path: string;
    format: string;
    render_format?: string | null;
    available?: boolean | null;
  } | null;
  isTextBook: boolean;
  settingsReady: boolean;
  /**
   * The PDF reading mode, or null for any format that relayouts live. PDFs
   * pick their renderer from `pdf-mode` at open time, so changing it is one of
   * the few preference changes that genuinely needs a re-open.
   */
  pdfReadingMode: string | null;
  readerRetry: number;
}

export function readerOpenKey({
  book,
  isTextBook,
  settingsReady,
  pdfReadingMode,
  readerRetry,
}: ReaderOpenKeyInput): string | null {
  if (!book || isTextBook || book.available === false || !settingsReady) return null;
  return JSON.stringify([
    book.id,
    book.file_path,
    book.format,
    book.render_format ?? null,
    pdfReadingMode,
    readerRetry,
  ]);
}
