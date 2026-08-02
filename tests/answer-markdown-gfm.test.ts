// GFM is switched on for AI answers, and the citation scheme has to survive it.
// These render through the real pipeline — remark-gfm, react-markdown's URL
// sanitiser, `renderToStaticMarkup` — rather than asserting on a mock, because
// the failure being guarded against is an interaction between those parts.
import assert from "node:assert/strict";
import test from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  citationUrlTransform,
  markdownWithCitationLinks,
} from "../src/components/citation-markers.ts";

const source = {
  marker: "S1",
  chunkId: "chunk",
  sectionIndex: 0,
  snippet: "A source.",
};

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, {
      remarkPlugins: [remarkGfm],
      urlTransform: citationUrlTransform,
      children: markdown,
    }),
  );
}

test("a pipe table renders as a table rather than literal pipes", () => {
  const html = render("| Word | Sense |\n| --- | --- |\n| bank | riverside |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>Word<\/th>/);
  assert.match(html, /<td>riverside<\/td>/);
});

test("without gfm the same table is literal pipes — the regression this guards", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { children: "| Word | Sense |\n| --- | --- |\n| bank | riverside |" }),
  );
  assert.doesNotMatch(html, /<table>/);
});

test("a citation inside a table cell keeps its scheme through the sanitiser", () => {
  const html = render(
    markdownWithCitationLinks("| Term | Source |\n| --- | --- |\n| bank | [S1] |", [source]),
  );
  assert.match(html, /<table>/);
  assert.match(html, /href="lantern-citation:S1"/);
});

test("gfm autolinking does not swallow a citation marker", () => {
  const html = render(markdownWithCitationLinks("See www.example.com and [S1].", [source]));
  assert.match(html, /href="lantern-citation:S1"/);
  assert.match(html, /href="http:\/\/www\.example\.com"/);
});

test("the sanitiser still drops a dangerous scheme", () => {
  const html = render("[click](javascript:alert(1))");
  assert.doesNotMatch(html, /javascript:/);
});

test("task list items carry the class the bullet suppression matches on", () => {
  const html = render("- [x] done\n- [ ] todo");
  assert.match(html, /class="task-list-item"/);
  assert.match(html, /type="checkbox"/);
});
