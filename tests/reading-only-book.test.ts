import assert from "node:assert/strict";
import test from "node:test";
import { isReadingOnlyBook } from "../src/components/reader-settings.ts";

test("FB2 and CBZ books are marked reading-only; converted and native formats are not", () => {
  assert.equal(isReadingOnlyBook({ format: "fb2", render_format: null }), true);
  assert.equal(isReadingOnlyBook({ format: "cbz", render_format: null }), true);
  assert.equal(isReadingOnlyBook({ format: "mobi", render_format: "epub" }), false);
  assert.equal(isReadingOnlyBook({ format: "epub", render_format: null }), false);
  assert.equal(isReadingOnlyBook({ format: "pdf", render_format: null }), false);
  assert.equal(isReadingOnlyBook({ format: "text", render_format: "text" }), false);
});
