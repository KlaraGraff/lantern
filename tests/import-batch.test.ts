import test from "node:test";
import assert from "node:assert/strict";
import { summarizeImportFailures } from "../src/hooks/import-batch.ts";

test("no failures summarizes to kind 'none'", () => {
  assert.deepEqual(summarizeImportFailures([]), { kind: "none", message: null, failedCount: 0 });
});

test("a single failure keeps its own message, unchanged from today's one-file UX", () => {
  const result = summarizeImportFailures([{ file_name: "bad.epub", error: "corrupt zip" }]);
  assert.deepEqual(result, { kind: "singleFailure", message: "corrupt zip", failedCount: 1 });
});

test("two failures switch to a count instead of stacking messages", () => {
  const result = summarizeImportFailures([
    { file_name: "a.epub", error: "corrupt zip" },
    { file_name: "b.pdf", error: "unsupported format" },
  ]);
  assert.deepEqual(result, { kind: "batchFailure", message: null, failedCount: 2 });
});

test("many failures still just report the count, not each message", () => {
  const failures = Array.from({ length: 5 }, (_, i) => ({
    file_name: `book-${i}.epub`,
    error: `error ${i}`,
  }));
  const result = summarizeImportFailures(failures);
  assert.deepEqual(result, { kind: "batchFailure", message: null, failedCount: 5 });
});
