import assert from "node:assert/strict";
import test from "node:test";

import { readerOpenKey, type ReaderOpenKeyInput } from "../src/pages/reader/reader-open-key.ts";

const BOOK = {
  id: "book-1",
  file_path: "/books/one.pdf",
  format: "pdf",
  render_format: "pdf",
  available: true,
};

const INPUT: ReaderOpenKeyInput = {
  book: BOOK,
  isTextBook: false,
  settingsReady: true,
  pdfReadingMode: "paginated",
  readerRetry: 0,
};

test("a fresh book object for the same file keeps the same key", () => {
  // The reader replaces the whole `book` row on a metadata change (and the
  // availability poll re-reads it wholesale). Neither is a reason to refetch
  // and reparse the file.
  const reopened = readerOpenKey({ ...INPUT, book: { ...BOOK } });
  assert.equal(reopened, readerOpenKey(INPUT));
});

test("settings landing after the book row does not open the book a second time", () => {
  // The bug this guards: `getBook` and the settings read race, settings lose,
  // and the settings-driven re-render used to restart the whole open sequence
  // while the first fetch was still in flight.
  assert.equal(readerOpenKey({ ...INPUT, settingsReady: false }), null);
  const afterSettings = readerOpenKey(INPUT);
  assert.notEqual(afterSettings, null);
  assert.equal(readerOpenKey(INPUT), afterSettings);
});

test("nothing is opened for a text book or a file that is not on disk yet", () => {
  assert.equal(readerOpenKey({ ...INPUT, isTextBook: true }), null);
  assert.equal(
    readerOpenKey({ ...INPUT, book: { ...BOOK, available: false } }),
    null,
  );
  assert.equal(readerOpenKey({ ...INPUT, book: null }), null);
});

test("an iCloud placeholder that finishes downloading opens once it lands", () => {
  const placeholder = readerOpenKey({ ...INPUT, book: { ...BOOK, available: false } });
  const downloaded = readerOpenKey({ ...INPUT, book: { ...BOOK, available: true } });
  assert.equal(placeholder, null);
  assert.notEqual(downloaded, null);
});

test("switching PDF reading mode reopens, because the renderer is chosen at open time", () => {
  assert.notEqual(
    readerOpenKey({ ...INPUT, pdfReadingMode: "scrolling" }),
    readerOpenKey(INPUT),
  );
});

test("an EPUB relayouts live, so no reading mode feeds its key", () => {
  const epub = {
    ...INPUT,
    book: { ...BOOK, file_path: "/books/one.epub", format: "epub", render_format: "epub" },
    pdfReadingMode: null,
  };
  assert.equal(readerOpenKey(epub), readerOpenKey({ ...epub }));
});

test("a retry and a different file each get their own key", () => {
  assert.notEqual(readerOpenKey({ ...INPUT, readerRetry: 1 }), readerOpenKey(INPUT));
  assert.notEqual(
    readerOpenKey({ ...INPUT, book: { ...BOOK, id: "book-2", file_path: "/books/two.pdf" } }),
    readerOpenKey(INPUT),
  );
  // Same book id, file replaced underneath it (re-import over the same row).
  assert.notEqual(
    readerOpenKey({ ...INPUT, book: { ...BOOK, file_path: "/books/one-v2.pdf" } }),
    readerOpenKey(INPUT),
  );
});

test("a render format that differs from the stored format reaches the key", () => {
  assert.notEqual(
    readerOpenKey({ ...INPUT, book: { ...BOOK, format: "azw3", render_format: "epub" } }),
    readerOpenKey({ ...INPUT, book: { ...BOOK, format: "azw3", render_format: "azw3" } }),
  );
});
