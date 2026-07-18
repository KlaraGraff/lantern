import assert from "node:assert/strict";
import test from "node:test";

import { toReaderOpenError } from "../src/pages/reader/reader-open-error.ts";

test("classifies PDF.js structural failures as invalid PDFs", () => {
  const error = new Error("Invalid PDF structure.");
  error.name = "InvalidPDFException";

  assert.deepEqual(toReaderOpenError(error, "pdf"), {
    kind: "invalid-pdf",
    detail: "Invalid PDF structure.",
  });
});

test("classifies Foliate's unsupported-type fallback as PDF damage for PDF books", () => {
  assert.deepEqual(toReaderOpenError(new Error("File type not supported"), "pdf"), {
    kind: "invalid-pdf",
    detail: "File type not supported",
  });
});

test("does not relabel the same fallback for a non-PDF book", () => {
  assert.deepEqual(toReaderOpenError(new Error("File type not supported"), "epub"), {
    kind: "generic",
    detail: "File type not supported",
  });
});

test("keeps timeouts as generic reader failures", () => {
  assert.deepEqual(toReaderOpenError(new Error("READER_OPEN_TIMEOUT"), "pdf"), {
    kind: "generic",
    detail: "READER_OPEN_TIMEOUT",
  });
});
