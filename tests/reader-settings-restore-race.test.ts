import assert from "node:assert/strict";
import test from "node:test";

import {
  flushPendingBookSettings,
  restoreBookSettingsKeys,
} from "../src/pages/reader/useReaderSettingsSync.ts";

// Regression test for the restore-vs-flush race: `set_book_settings_bulk` (the
// debounced bulk write) must always be observed to complete before
// `delete_book_settings` is issued for the same book, even when the caller asks
// to restore mid-flush. Landing them out of order re-inserts the override the
// user asked to clear and drops the deletion tombstone that would otherwise stop
// it resurrecting via sync.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("restoreBookSettingsKeys waits for an in-flight bulk write before deleting", async () => {
  const calls: string[] = [];
  const pending: Record<string, Record<string, string>> = {
    "book-1": { reading_mode: "paginated" },
  };
  const bulkWrite = deferred<void>();

  const invokeSetBulk = () => {
    calls.push("bulk");
    return bulkWrite.promise;
  };
  const invokeDelete = (bookId: string, keys: string[]) => {
    calls.push("delete");
    return Promise.resolve(
      Object.fromEntries(keys.map((key) => [key, "some-value"])),
    );
  };

  // Start the debounced flush, matching `flushBookSettings` being kicked off by
  // its 400ms timer, but do not await it yet.
  const flushPromise = flushPendingBookSettings(pending, invokeSetBulk, true);

  // The user restores while that write is still in flight.
  const restorePromise = restoreBookSettingsKeys(
    "book-1",
    ["reading_mode"],
    pending,
    invokeDelete,
    () => flushPromise,
  );

  // Nothing has resolved yet: the bulk write must still be the only call made,
  // and the ref must still show the write as outstanding.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["bulk"]);
  assert.ok(pending["book-1"], "the in-flight write must still be tracked as pending");

  bulkWrite.resolve();
  await Promise.all([flushPromise, restorePromise]);

  assert.deepEqual(calls, ["bulk", "delete"]);
});

test("flushPendingBookSettings only clears an entry once its own write resolves", async () => {
  const pending: Record<string, Record<string, string>> = {
    "book-1": { margins: "10" },
  };
  const bulkWrite = deferred<void>();
  const invokeSetBulk = () => bulkWrite.promise;

  const flushPromise = flushPendingBookSettings(pending, invokeSetBulk, true);
  await Promise.resolve();
  assert.ok(pending["book-1"], "entry must remain while the write is outstanding");

  bulkWrite.resolve();
  await flushPromise;
  assert.equal(pending["book-1"], undefined, "entry is cleared once the write settles");
});

test("restoreBookSettingsKeys re-queues the pending edit if the delete itself fails", async () => {
  const pending: Record<string, Record<string, string>> = {};
  const requeued: Record<string, string>[] = [];
  const invokeDelete = () => Promise.reject(new Error("network error"));

  pending["book-1"] = { margins: "12" };
  await assert.rejects(
    () => restoreBookSettingsKeys(
      "book-1",
      ["margins"],
      pending,
      invokeDelete,
      () => Promise.resolve(),
      (pendingDeleted) => requeued.push(pendingDeleted),
    ),
    /network error/,
  );

  assert.deepEqual(requeued, [{ margins: "12" }]);
});
