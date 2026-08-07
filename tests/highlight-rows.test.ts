import assert from "node:assert/strict";
import test from "node:test";

import {
  filterHighlightRows,
  mergeHighlightRows,
  type HighlightRow,
} from "../src/components/highlight-rows.ts";
import type { Highlight } from "../src/hooks/useBookmarks.ts";
import type { AutoHighlight } from "../src/hooks/useAutoHighlights.ts";

/**
 * The highlights list merges two sources into one timeline. The rules under
 * test are product rulings, not conveniences: order is chronological whatever
 * the filters say, and filtering only ever narrows.
 */

function manual(id: string, createdAt: number, color = "yellow", text = "drawn"): Highlight {
  return {
    id,
    book_id: "book",
    cfi_range: `cfi-${id}`,
    color,
    text_content: text,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function auto(
  anchor: string,
  createdAt: number,
  overrides: Partial<AutoHighlight> = {},
): AutoHighlight {
  return {
    anchor,
    book_id: "book",
    cfi: `cfi-${anchor}`,
    text: "derived",
    source: "lookup",
    label: null,
    created_at: createdAt,
    ...overrides,
  };
}

function keys(rows: readonly HighlightRow[]): string[] {
  return rows.map((row) => row.key);
}

test("the two sources interleave strictly by time, never by kind", () => {
  const rows = mergeHighlightRows(
    [manual("h1", 100), manual("h2", 300)],
    [auto("lookup:a", 200), auto("chat:b:0", 400)],
  );
  assert.deepEqual(keys(rows), ["a:chat:b:0", "h:h2", "a:lookup:a", "h:h1"]);
});

test("rows recorded in the same millisecond keep a stable order", () => {
  const rows = mergeHighlightRows([manual("h1", 100)], [auto("lookup:a", 100)]);
  const again = mergeHighlightRows([manual("h1", 100)], [auto("lookup:a", 100)]);
  assert.deepEqual(keys(rows), keys(again));
});

test("the source filter narrows without touching the order", () => {
  const rows = mergeHighlightRows(
    [manual("h1", 100), manual("h2", 300)],
    [auto("lookup:a", 200), auto("chat:b:0", 400)],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "manual", color: null, search: "" })),
    ["h:h2", "h:h1"],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "auto", color: null, search: "" })),
    ["a:chat:b:0", "a:lookup:a"],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "all", color: null, search: "" })),
    keys(rows),
  );
});

test("picking a colour excludes automatic rows, which have none", () => {
  const rows = mergeHighlightRows(
    [manual("h1", 100, "yellow"), manual("h2", 300, "blue")],
    [auto("lookup:a", 200)],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "all", color: "blue", search: "" })),
    ["h:h2"],
  );
});

test("search reads the passage and the looked-up word behind it", () => {
  const rows = mergeHighlightRows(
    [manual("h1", 100, "yellow", "a drawn passage")],
    [auto("lookup:a", 200, { text: "He admired her resolve.", label: "steadfastness" })],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "all", color: null, search: "STEADFAST" })),
    ["a:lookup:a"],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "all", color: null, search: "drawn" })),
    ["h:h1"],
  );
  assert.deepEqual(
    keys(filterHighlightRows(rows, { source: "all", color: null, search: "   " })),
    keys(rows),
  );
});

test("a highlight with no captured text still survives an empty search", () => {
  const rows = mergeHighlightRows([{ ...manual("h1", 100), text_content: null }], []);
  assert.equal(filterHighlightRows(rows, { source: "all", color: null, search: "" }).length, 1);
  assert.equal(filterHighlightRows(rows, { source: "all", color: null, search: "x" }).length, 0);
});
