import assert from "node:assert/strict";
import test from "node:test";

import {
  citedSourcesInContent,
  citationMarkerFromHref,
  markdownWithCitationLinks,
} from "../src/components/citation-markers.ts";

const source = {
  marker: "S1",
  chunkId: "chunk",
  sectionIndex: 0,
  snippet: "A source.",
};

test("replaces only known citation markers with internal markdown links", () => {
  assert.equal(markdownWithCitationLinks("Fact [S1], unknown [S2]", [source]), "Fact [S1](quill-citation:S1), unknown [S2]");
});

test("identifies cited sources and internal citation hrefs", () => {
  assert.deepEqual(citedSourcesInContent("Fact [S1]", [source]), [source]);
  assert.equal(citationMarkerFromHref("quill-citation:S1"), "S1");
  assert.equal(citationMarkerFromHref("https://example.com"), undefined);
});
