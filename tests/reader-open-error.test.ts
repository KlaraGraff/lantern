import assert from "node:assert/strict";
import test from "node:test";

import {
  fileStatusExplainsFailure,
  toReaderOpenError,
} from "../src/pages/reader/reader-open-error.ts";

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

test("an unreachable file outranks whatever the parser made of it", () => {
  // These three are the reason the open failed; the parser message describes a
  // symptom of them, so the error screen leads with the file instead.
  assert.equal(fileStatusExplainsFailure("missing"), true);
  assert.equal(fileStatusExplainsFailure("icloud_placeholder"), true);
  assert.equal(fileStatusExplainsFailure("unreadable"), true);
});

test("a readable file explains nothing, so the parser error stands", () => {
  assert.equal(fileStatusExplainsFailure("available"), false);
  // Undiagnosed: the probe has not answered, or failed. Same treatment.
  assert.equal(fileStatusExplainsFailure(undefined), false);
});
