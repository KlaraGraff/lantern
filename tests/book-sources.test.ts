import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILT_IN_BOOK_SOURCES,
  isOpenableUrl,
  parseBookSources,
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
