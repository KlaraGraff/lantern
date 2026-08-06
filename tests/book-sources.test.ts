import test from "node:test";
import assert from "node:assert/strict";
import { presetDeleteConfirm } from "../src/components/settings/presetDeletion.ts";
import {
  BUILT_IN_BOOK_SOURCES,
  bookSourceDeleteKind,
  isOpenableUrl,
  parseBookSources,
  resolveBookSources,
  restoreBuiltInBookSources,
  serializeBookSources,
  type BookSource,
} from "../src/components/book-sources.ts";

const userEntry: BookSource = {
  id: "user:1",
  name: "My site",
  url: "https://example.com/",
  kind: "library",
};

test("restoring defaults leaves entries the user added alone", () => {
  const edited = BUILT_IN_BOOK_SOURCES.map((source) => ({ ...source, name: "renamed" }));
  const restored = restoreBuiltInBookSources([...edited.slice(1), userEntry]);

  // Every built-in is back, at its factory name…
  for (const builtIn of BUILT_IN_BOOK_SOURCES) {
    assert.deepEqual(restored.find((source) => source.id === builtIn.id), builtIn);
  }
  // …and the user's own entry survived untouched.
  assert.deepEqual(restored.filter((source) => source.id.startsWith("user:")), [userEntry]);
});

test("a malformed stored list degrades to empty rather than throwing", () => {
  assert.deepEqual(parseBookSources(undefined), []);
  assert.deepEqual(parseBookSources("not json"), []);
  assert.deepEqual(parseBookSources('{"id":"x"}'), []);
  // Entries missing required fields are dropped, valid siblings are kept.
  assert.deepEqual(
    parseBookSources(serializeBookSources([userEntry])).concat(
      parseBookSources('[{"id":"broken"}]'),
    ),
    [userEntry],
  );
});

test("only http(s) links are handed to the system browser", () => {
  assert.ok(isOpenableUrl("https://example.com"));
  assert.ok(isOpenableUrl("  http://example.com/books  "));
  assert.ok(!isOpenableUrl("file:///etc/passwd"));
  assert.ok(!isOpenableUrl("javascript:alert(1)"));
  assert.ok(!isOpenableUrl("example.com"));
});

test("a device that was never told anything shows the defaults without owning them", () => {
  // The whole seeding trap in one assertion pair. `book_sources` syncs now, so
  // a second device must show the built-ins from an absent row rather than
  // write them — a write would carry that device's clock and beat the list the
  // first device curated earlier, on both machines.
  assert.deepEqual(resolveBookSources(undefined), [...BUILT_IN_BOOK_SOURCES]);

  const curated = serializeBookSources([userEntry]);
  assert.deepEqual(
    resolveBookSources(curated),
    [userEntry],
    "a list that arrived from a peer must be shown as-is",
  );
});

test("the order the list and the launch happen in does not change the outcome", () => {
  const curated = serializeBookSources([userEntry]);

  // Device B opens the pane first, then the peer's list arrives: the pane read
  // an absent row and wrote nothing, so there is nothing to overwrite.
  assert.deepEqual(resolveBookSources(undefined), [...BUILT_IN_BOOK_SOURCES]);
  assert.deepEqual(resolveBookSources(curated), [userEntry]);

  // The other order — list first, then the pane opens — reads the same row and
  // reaches the same list. Resolution has no memory, which is the point.
  assert.deepEqual(resolveBookSources(curated), [userEntry]);
});

test("an empty stored list is a decision, not an absence", () => {
  // A user who deleted every source gets an empty list back, not the defaults;
  // handing the built-ins back here is exactly the bug the old "seeded once"
  // flag existed to prevent, and presence of the row replaces it.
  assert.deepEqual(resolveBookSources("[]"), []);
  // Garbage degrades the same way `parseBookSources` does — the row exists, so
  // it is honoured, even when it says nothing legible.
  assert.deepEqual(resolveBookSources("not json"), []);
});

test("a source the user typed cannot be deleted without a warning", () => {
  // The bug this locks: the settings pane passed a literal "builtin" for every
  // row, so a user's own entry deleted silently while the built-ins were still
  // there — and "restore defaults" cannot bring it back.
  assert.equal(bookSourceDeleteKind(userEntry.id), "custom");
  assert.equal(bookSourceDeleteKind(BUILT_IN_BOOK_SOURCES[0].id), "builtin");

  const listIsNotEmptied = false;
  assert.ok(
    presetDeleteConfirm(bookSourceDeleteKind(userEntry.id), listIsNotEmptied, "sources", userEntry.name),
    "deleting a user entry among many must still confirm",
  );
  assert.equal(
    presetDeleteConfirm(
      bookSourceDeleteKind(BUILT_IN_BOOK_SOURCES[0].id),
      listIsNotEmptied,
      "sources",
    ),
    null,
    "a built-in among many stays a one-click delete",
  );
});
