import assert from "node:assert/strict";
import test from "node:test";

import {
  citedSourcesInContent,
  citationMarkerFromHref,
  markdownWithCitationLinks,
  markdownWithQuoteLinks,
  quoteMarkerFromHref,
  quotedSourcesInContent,
} from "../src/components/citation-markers.ts";

const source = {
  marker: "S1",
  chunkId: "chunk",
  sectionIndex: 0,
  snippet: "A source.",
};

const quote = {
  marker: "Q1",
  bookId: "book",
  bookTitle: "Another Book",
  sectionIndex: 3,
  text: "An example sentence.",
  prefix: "",
  suffix: "",
};

test("replaces only known citation markers with internal markdown links", () => {
  assert.equal(markdownWithCitationLinks("Fact [S1], unknown [S2]", [source]), "Fact [S1](lantern-citation:S1), unknown [S2]");
});

test("identifies cited sources and internal citation hrefs", () => {
  assert.deepEqual(citedSourcesInContent("Fact [S1]", [source]), [source]);
  assert.equal(citationMarkerFromHref("lantern-citation:S1"), "S1");
  assert.equal(citationMarkerFromHref("https://example.com"), undefined);
});

test("supports candidate-level source markers above two digits", () => {
  const source100 = { ...source, marker: "S100" };
  assert.equal(markdownWithCitationLinks("Fact [S100]", [source100]), "Fact [S100](lantern-citation:S100)");
});

test("example quotes get their own scheme, so [S1] and [Q1] never collide", () => {
  assert.equal(
    markdownWithQuoteLinks("Used here [Q1], not offered [Q2]", [quote]),
    "Used here [Q1](lantern-quote:Q1), not offered [Q2]",
  );
  assert.equal(quoteMarkerFromHref("lantern-quote:Q1"), "Q1");
  assert.equal(quoteMarkerFromHref("lantern-citation:S1"), undefined);
  assert.equal(citationMarkerFromHref("lantern-quote:Q1"), undefined);
});

test("a quote the answer never used is not listed under it", () => {
  const unused = { ...quote, marker: "Q2" };
  assert.deepEqual(quotedSourcesInContent("As in [Q1].", [quote, unused]), [quote]);
  assert.deepEqual(quotedSourcesInContent("No example fitted.", [quote, unused]), []);
});

test("citation rewriting leaves quote markers alone and the other way round", () => {
  assert.equal(markdownWithCitationLinks("Fact [S1] as in [Q1]", [source]),
    "Fact [S1](lantern-citation:S1) as in [Q1]");
  assert.equal(markdownWithQuoteLinks("Fact [S1] as in [Q1]", [quote]),
    "Fact [S1] as in [Q1](lantern-quote:Q1)");
});
