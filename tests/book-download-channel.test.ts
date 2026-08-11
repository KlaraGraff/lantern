import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { bookDownloadEventName } from "../src/hooks/book-download.ts";

// D-013's channel: the reader mints a request id, subscribes to
// `book-download-<id>`, and only then invokes `diagnose_book_file`. If the two
// sides ever spell that name differently the download still runs — it just
// runs silently behind an error screen, which is the exact failure this whole
// item existed to remove, and nothing else would catch it.

test("the channel name is the request id with the agreed prefix", () => {
  assert.equal(bookDownloadEventName("abc-123"), "book-download-abc-123");
});

test("the prefix matches the backend's `event_name` literally", () => {
  const rust = readFileSync(new URL("../src-tauri/src/icloud/download.rs", import.meta.url), "utf8");
  // The format string in `pub fn event_name`, read rather than restated, so
  // this fails when the Rust side is edited instead of when someone remembers
  // to update the test.
  const match = rust.match(/format!\("(book-download-)\{request_id\}"\)/);
  assert.ok(match, "could not find event_name's format string in icloud/download.rs");
  assert.equal(bookDownloadEventName("x"), `${match[1]}x`);
});
