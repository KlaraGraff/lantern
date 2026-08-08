import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  bandShares,
  classifyOpenCardBody,
  classifyRidge,
  disclosureRows,
  estimateRemainingWords,
  formatApproxHours,
  isScannedPdf,
  openCardReasons,
  openSurface,
  referenceBookComparison,
  roundPercent,
  weightedHardShare,
  type BandPassRates,
} from "../src/components/book-open-card-view.ts";
import type { BookDifficulty } from "../src/hooks/useBookDifficulty.ts";
import type { BookDifficultySection } from "../src/hooks/useOpenCardData.ts";

function difficulty(overrides: Partial<BookDifficulty> = {}): BookDifficulty {
  return {
    bookId: "book",
    status: "done",
    totalTokens: 1000,
    distinctWords: 400,
    band1: 700,
    band2: 150,
    band3: 100,
    band4: 40,
    band5: 10,
    bandUnlisted: 0,
    sourceSha256: "sha",
    computedAt: "2026-01-01T00:00:00Z",
    error: null,
    override: null,
    stale: false,
    ...overrides,
  };
}

function book(overrides: Partial<{ format: string; status: string }> = {}) {
  return { format: "epub", status: "unread", ...overrides } as { format: string; status: "reading" | "finished" | "unread" };
}

// --- isScannedPdf / openCardReasons -----------------------------------

test("a scanned PDF is the exact failed + PDF_TEXT_LAYER_UNAVAILABLE signal, not a proxy", () => {
  const scanned = difficulty({ status: "failed", error: "PDF_TEXT_LAYER_UNAVAILABLE" });
  assert.equal(isScannedPdf({ format: "pdf" }, scanned), true);
  // Same status/error on a non-PDF format never counts — the error only
  // means something for the format it was raised against.
  assert.equal(isScannedPdf({ format: "epub" }, scanned), false);
  // A short PDF that simply failed for some other reason is not scanned.
  const otherFailure = difficulty({ status: "failed", error: "SOMETHING_ELSE" });
  assert.equal(isScannedPdf({ format: "pdf" }, otherFailure), false);
  // too_short is not failed — a short real-text PDF pamphlet must not be
  // mistaken for a scan.
  const short = difficulty({ status: "too_short", error: null, totalTokens: 200 });
  assert.equal(isScannedPdf({ format: "pdf" }, short), false);
});

test("openCardReasons collects every trigger condition independently", () => {
  const scanned = difficulty({ status: "failed", error: "PDF_TEXT_LAYER_UNAVAILABLE" });
  const reasons = openCardReasons(book({ format: "pdf", status: "unread" }), scanned);
  assert.deepEqual(reasons.sort(), ["scannedPdf", "unread"]);

  const stale = difficulty({ stale: true });
  assert.deepEqual(openCardReasons(book({ status: "finished" }), stale), ["stale"]);

  assert.deepEqual(openCardReasons(book({ status: "reading" }), difficulty()), []);
});

// --- openSurface ---------------------------------------------------------

test("a currently-reading book never gets the full card, regardless of reason", () => {
  const stale = difficulty({ stale: true });
  const result = openSurface(book({ status: "reading" }), stale, { enabled: true, sessionDismissed: false });
  assert.equal(result, "none");
});

test("the master toggle and a per-book session dismissal both suppress the card", () => {
  const unread = book({ status: "unread" });
  assert.equal(openSurface(unread, null, { enabled: false, sessionDismissed: false }), "none");
  assert.equal(openSurface(unread, null, { enabled: true, sessionDismissed: true }), "none");
});

test("an unread book with no reason present shows nothing", () => {
  // unread alone is already a reason (never opened), so this checks a
  // finished book with a clean, non-stale, non-scanned row.
  const finished = book({ status: "finished" });
  assert.equal(openSurface(finished, difficulty(), { enabled: true, sessionDismissed: false }), "none");
});

test("an unread book shows the card when enabled and not dismissed", () => {
  const unread = book({ status: "unread" });
  assert.equal(openSurface(unread, difficulty(), { enabled: true, sessionDismissed: false }), "card");
});

// --- classifyOpenCardBody -------------------------------------------------

test("a scanned PDF classifies as scanned even though its status is literally failed", () => {
  const scanned = difficulty({ status: "failed", error: "PDF_TEXT_LAYER_UNAVAILABLE" });
  assert.equal(classifyOpenCardBody({ format: "pdf" }, scanned, true), "scanned");
});

test("no row at all, or a pending row, both read as never computed", () => {
  assert.equal(classifyOpenCardBody({ format: "epub" }, null, true), "neverComputed");
  assert.equal(classifyOpenCardBody({ format: "epub" }, difficulty({ status: "pending" }), true), "neverComputed");
});

test("running reads as computing; too_short/unsupported/a plain failure read as no conclusion", () => {
  assert.equal(classifyOpenCardBody({ format: "epub" }, difficulty({ status: "running" }), true), "computing");
  assert.equal(classifyOpenCardBody({ format: "epub" }, difficulty({ status: "too_short" }), true), "noConclusion");
  assert.equal(classifyOpenCardBody({ format: "epub" }, difficulty({ status: "unsupported" }), true), "noConclusion");
  assert.equal(
    classifyOpenCardBody({ format: "epub" }, difficulty({ status: "failed", error: "BOOK_NOT_FOUND" }), true),
    "noConclusion",
  );
});

test("a done book splits on whether the reader's own pass-rate record is sufficient", () => {
  const done = difficulty({ status: "done" });
  assert.equal(classifyOpenCardBody({ format: "epub" }, done, true), "ready");
  assert.equal(classifyOpenCardBody({ format: "epub" }, done, false), "insufficientRecord");
});

// --- bandShares / weightedHardShare / roundPercent ------------------------

test("bandShares divides each band by the book's total tokens", () => {
  const shares = bandShares(difficulty({ band1: 800, band2: 100, band3: 60, band4: 30, band5: 10, totalTokens: 1000 }));
  assert.deepEqual(shares, [0.8, 0.1, 0.06, 0.03, 0.01]);
});

test("bandShares is all zero for a book with no counted tokens", () => {
  assert.deepEqual(bandShares(difficulty({ totalTokens: 0 })), [0, 0, 0, 0, 0]);
});

test("weightedHardShare treats a band with no reader evidence as fully unfamiliar", () => {
  const shares: [number, number, number, number, number] = [0.5, 0.5, 0, 0, 0];
  const noEvidence: BandPassRates = [null, null, null, null, null];
  // Every band counts in full since (1 - 0) = 1 for a null rate.
  assert.equal(weightedHardShare(shares, noEvidence), 1);

  const fullyKnown: BandPassRates = [1, 1, null, null, null];
  assert.equal(weightedHardShare(shares, fullyKnown), 0);
});

test("roundPercent rounds to whole percent", () => {
  assert.equal(roundPercent(0.034), 3);
  assert.equal(roundPercent(0.035), 4);
  assert.equal(roundPercent(0), 0);
});

// --- disclosureRows --------------------------------------------------------

test("disclosureRows normalizes each row's bar against the largest contribution", () => {
  const shares: [number, number, number, number, number] = [0.5, 0.2, 0.2, 0.08, 0.02];
  const passRates: BandPassRates = [0.99, 0.9, 0.7, null, null];
  const rows = disclosureRows(shares, passRates);
  assert.equal(rows.length, 5);
  assert.equal(rows[3].passRatePercent, null);
  // Band 4 and 5 have no evidence, so their contribution is their full share
  // — band 4 (0.08) should out-weigh band 1's near-fully-known 0.5*0.01.
  const maxRow = rows.reduce((best, r) => (r.contribution > best.contribution ? r : best));
  assert.equal(maxRow.band, 4);
  assert.equal(maxRow.contributionWidthPercent, 100);
});

// --- classifyRidge -----------------------------------------------------

function section(overrides: Partial<BookDifficultySection> = {}): BookDifficultySection {
  return { sectionOrder: 0, chapterTitle: null, totalTokens: 1000, band4: 50, band5: 10, ...overrides };
}

test("no usable sections on a PDF is unavailable, never backfilling", () => {
  const state = classifyRidge([], { format: "pdf" }, "done");
  assert.deepEqual(state, { kind: "unavailable" });
});

test("no usable sections on a done non-PDF book is backfilling", () => {
  const state = classifyRidge([], { format: "epub" }, "done");
  assert.deepEqual(state, { kind: "backfilling" });
});

test("no usable sections on a not-yet-done book is unavailable, not backfilling", () => {
  const state = classifyRidge([], { format: "epub" }, "pending");
  assert.deepEqual(state, { kind: "unavailable" });
});

test("a peak well above the median names the hardest titled chapter", () => {
  const sections = [
    section({ sectionOrder: 0, chapterTitle: "Chapter One", band4: 20, band5: 5, totalTokens: 1000 }),
    section({ sectionOrder: 1, chapterTitle: "Chapter Two", band4: 300, band5: 200, totalTokens: 1000 }),
    section({ sectionOrder: 2, chapterTitle: "Chapter Three", band4: 25, band5: 5, totalTokens: 1000 }),
  ];
  const state = classifyRidge(sections, { format: "epub" }, "done");
  assert.equal(state.kind, "peak");
  if (state.kind === "peak") {
    assert.equal(state.peakSectionOrder, 1);
    assert.equal(state.peakTitle, "Chapter Two");
    assert.equal(state.bars.length, 3);
  }
});

test("a peak with no chapter title falls back to unavailable rather than a machine index", () => {
  const sections = [
    section({ sectionOrder: 0, chapterTitle: "Chapter One", band4: 20, band5: 5, totalTokens: 1000 }),
    section({ sectionOrder: 1, chapterTitle: null, band4: 300, band5: 200, totalTokens: 1000 }),
    section({ sectionOrder: 2, chapterTitle: "Chapter Three", band4: 22, band5: 6, totalTokens: 1000 }),
  ];
  const state = classifyRidge(sections, { format: "epub" }, "done");
  assert.deepEqual(state, { kind: "unavailable" });
});

test("a flat distribution reads as flat even when every section is titled", () => {
  const sections = [
    section({ sectionOrder: 0, chapterTitle: "Chapter One", band4: 40, band5: 10, totalTokens: 1000 }),
    section({ sectionOrder: 1, chapterTitle: "Chapter Two", band4: 41, band5: 10, totalTokens: 1000 }),
    section({ sectionOrder: 2, chapterTitle: "Chapter Three", band4: 39, band5: 11, totalTokens: 1000 }),
  ];
  const state = classifyRidge(sections, { format: "epub" }, "done");
  assert.equal(state.kind, "flat");
});

// --- estimateRemainingWords / formatApproxHours ---------------------------

test("estimateRemainingWords scales down by progress and clamps to [0,1]", () => {
  assert.equal(estimateRemainingWords(10_000, 0.25), 7_500);
  assert.equal(estimateRemainingWords(10_000, 0), 10_000);
  assert.equal(estimateRemainingWords(10_000, 1.5), 0);
  assert.equal(estimateRemainingWords(10_000, -1), 10_000);
});

test("formatApproxHours rounds to a whole hour, minimum one, and is null without a usable pace", () => {
  assert.equal(formatApproxHours(60_000, 148), 7);
  assert.equal(formatApproxHours(500, 148), 1);
  assert.equal(formatApproxHours(60_000, 0), null);
  assert.equal(formatApproxHours(60_000, null), null);
  assert.equal(formatApproxHours(0, 148), null);
});

// --- referenceBookComparison ------------------------------------------

test("referenceBookComparison only ever reports a direction, never both shares", () => {
  assert.equal(referenceBookComparison(0.10, 0.03), "referenceLighter");
  assert.equal(referenceBookComparison(0.02, 0.10), "referenceHeavier");
  assert.equal(referenceBookComparison(0.05, 0.05), "referenceSimilar");
});

// --- i18n key existence ----------------------------------------------------

test("every bookOpenCard.* key used by the card exists in both locales", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const en = JSON.parse(readFileSync(path.join(root, "src/i18n/en.json"), "utf-8")) as Record<string, string>;
  const zh = JSON.parse(readFileSync(path.join(root, "src/i18n/zh.json"), "utf-8")) as Record<string, string>;
  const enKeys = Object.keys(en).filter((key) => key.startsWith("bookOpenCard."));
  const zhKeys = Object.keys(zh).filter((key) => key.startsWith("bookOpenCard."));
  assert.ok(enKeys.length > 0, "expected bookOpenCard.* keys in en.json");
  assert.deepEqual(enKeys.sort(), zhKeys.sort());
});
