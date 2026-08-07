import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import AiMarkdown, { type AiMarkdownProps } from "../src/components/ai-markdown/AiMarkdown.ts";
import { leadingAlertTag } from "../src/components/ai-markdown/plugins.ts";
import type { CitedSource } from "../src/hooks/useAiChat.ts";

// These tests render through the real pipeline — the actual AiMarkdown
// component, real remark plugins, real react-markdown — and assert on the
// produced HTML. No mocks: what passes here is what the app ships.

const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;
const zh = JSON.parse(readFileSync(path.join(i18nDir, "zh.json"), "utf8")) as Record<string, string>;

// The app's i18n module reads navigator/localStorage at import time, so tests
// initialise a bare instance with the same resources instead.
i18next.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

function render(markdown: string, props: Partial<AiMarkdownProps> = {}): string {
  return renderToStaticMarkup(
    createElement(AiMarkdown, { size: "chat", ...props, children: markdown }),
  );
}

const SOURCES: CitedSource[] = [
  {
    marker: "S1",
    chunkId: "c1",
    sectionIndex: 0,
    sectionTitle: "Chapter I",
    snippet: "It is a truth universally acknowledged...",
  },
];

// --- highlight marks -------------------------------------------------------

test("==text== renders a <mark> and leaves no raw marker", () => {
  const html = render("The ==present perfect== links past to now.");
  assert.match(html, /<mark>present perfect<\/mark>/);
  assert.ok(!html.includes("=="), `raw marker leaked: ${html}`);
});

test("a mark can span bold inside it", () => {
  const html = render("==**gerund** as subject== is the key form.");
  assert.match(html, /<mark><strong>gerund<\/strong> as subject<\/mark>/);
});

test("=== runs stay literal — triple equals in prose is not a marker", () => {
  const html = render("In JS, a === b compares without coercion.");
  assert.ok(!html.includes("<mark"), `unexpected mark: ${html}`);
  assert.ok(html.includes("a === b"));
});

test("spaced == as an operator never opens a mark", () => {
  const html = render("Here x == y and later z == w, all plain prose.");
  assert.ok(!html.includes("<mark"), `unexpected mark: ${html}`);
});

test("an unclosed ==pair in a finished message degrades to literal text, no error node", () => {
  const html = render("This ==never closes and the message ended.");
  assert.ok(!html.includes("<mark"));
  assert.ok(html.includes("==never closes"));
});

test("== inside inline code or a fence is untouched", () => {
  const inline = render("Compare with `a == b` in code.");
  assert.ok(!inline.includes("<mark"), `mark inside code span: ${inline}`);
  const fenced = render("```js\nif (a == b) {}\n```\n");
  assert.ok(!fenced.includes("<mark"), `mark inside fence: ${fenced}`);
  assert.match(fenced, /<pre[\s>]/);
});

test("marks work inside list items and table cells", () => {
  const html = render("| form | use |\n| --- | --- |\n| ==did== | past |\n\n- ==so== as filler");
  const markCount = html.split("<mark>").length - 1;
  assert.equal(markCount, 2, `expected 2 marks: ${html}`);
});

test("real model output: a highlight spanning code spans that ARE == and ===", () => {
  // Verbatim from deepseek-v4-flash (the production model) answering a
  // JavaScript question: the highlighted sentence contains backticked `===`
  // and `==` — the worst-case collision between the mark syntax and code.
  const html = render("==最重要的一点：`===` 要求类型和值都相等，而 `==` 只要求转换后值相等。==");
  assert.match(html, /<mark>最重要的一点：<code>===<\/code>/);
  assert.match(html, /<code>==<\/code>/);
  const outsideCode = html.replace(/<code>[^<]*<\/code>/g, "");
  assert.ok(!outsideCode.includes("=="), `marker leaked outside code: ${html}`);
});

// --- deterministic headword highlight --------------------------------------

test("highlightTerm marks the term without model cooperation", () => {
  const html = render("To take up a hobby means to begin it.", { highlightTerm: "take up" });
  assert.match(html, /<mark>take up<\/mark>/);
});

test("highlightTerm respects Latin word boundaries", () => {
  const html = render("I had already read it.", { highlightTerm: "read" });
  const markCount = html.split("<mark>").length - 1;
  assert.equal(markCount, 1, `"read" must not light up inside "already": ${html}`);
  assert.match(html, /<mark>read<\/mark>/);
});

test("highlightTerm matches CJK substrings", () => {
  const html = render("无法把握机会的时候。", { highlightTerm: "把握" });
  assert.match(html, /<mark>把握<\/mark>/);
});

// --- alerts ----------------------------------------------------------------

test("> [!WARNING] renders the alert strip with the i18n label, tag stripped", () => {
  const html = render("> [!WARNING]\n> Easily confused with the simple past.");
  assert.ok(html.includes('role="note"'), `no note role: ${html}`);
  assert.ok(html.includes(en["ai.markdown.alert.warning"]), `label missing: ${html}`);
  assert.ok(html.includes("Easily confused with the simple past."));
  assert.ok(!html.includes("[!WARNING]"), `tag leaked: ${html}`);
  assert.ok(!html.includes("<blockquote"), `alert still a quote: ${html}`);
});

test("every alert tag has a label in both locales", () => {
  for (const tag of ["note", "tip", "important", "warning", "caution"]) {
    const key = `ai.markdown.alert.${tag}`;
    assert.ok(key in en, `missing from en.json: ${key}`);
    assert.ok(key in zh, `missing from zh.json: ${key}`);
  }
});

test("an untagged blockquote stays an excerpt quote", () => {
  const html = render("> It is a truth universally acknowledged.");
  assert.match(html, /<blockquote[\s>]/);
  assert.ok(!html.includes('role="note"'));
});

test("an unknown tag degrades to a plain quote with its text intact", () => {
  const html = render("> [!BANANA]\n> Something the model made up.");
  assert.match(html, /<blockquote[\s>]/);
  assert.ok(html.includes("[!BANANA]"), `unknown tag must stay visible: ${html}`);
});

test("leadingAlertTag lifts an inline tag off a card field", () => {
  assert.deepEqual(leadingAlertTag("[!warning] Uncountable — no plural."), {
    tag: "warning",
    rest: "Uncountable — no plural.",
  });
  assert.equal(leadingAlertTag("No tag here"), null);
});

// --- citations -------------------------------------------------------------

test("[S1] renders as a citation chip when its source exists", () => {
  const html = render("The novel opens with irony [S1].", { sources: SOURCES });
  assert.ok(html.includes('aria-label="Source 1"'), `no chip: ${html}`);
  assert.ok(html.includes("Chapter I"), "tooltip lost the section title");
  assert.ok(!html.includes("[S1]"), "raw marker left in output");
});

test("[S2] with no matching source stays literal text", () => {
  const html = render("A dangling citation [S2].", { sources: SOURCES });
  assert.ok(html.includes("[S2]"));
  assert.ok(!html.includes("<button"), `phantom chip: ${html}`);
});

test("a citation chip works inside a table cell", () => {
  const html = render("| point | src |\n| --- | --- |\n| irony | [S1] |", { sources: SOURCES });
  assert.ok(html.includes('aria-label="Source 1"'), `no chip in cell: ${html}`);
});

// --- injection safety ------------------------------------------------------

test("script tags in model output never reach the DOM", () => {
  const html = render('Before <script>alert("x")</script> after.');
  assert.ok(!html.includes("<script"), `script leaked: ${html}`);
});

test("event-handler attributes in model output never reach the DOM", () => {
  const html = render('An image <img src=x onerror="steal()"> here.');
  // The fixture may survive as escaped text — that is safe. What must never
  // exist is a real element carrying the handler.
  assert.ok(!html.includes("<img"), `element leaked: ${html}`);
  assert.ok(!html.includes('onerror="'), `live handler attribute: ${html}`);
});

test("javascript: links are stripped by the url transform", () => {
  const html = render("[click](javascript:alert(1))");
  assert.ok(!html.includes("javascript:"), `scheme leaked: ${html}`);
});

test("the citation scheme itself cannot be forged into navigation", () => {
  // A model writing a lantern-citation link by hand, with no matching source,
  // must not produce a chip or a live link target.
  const html = render("[fake](lantern-citation:S9)", { sources: SOURCES });
  assert.ok(!html.includes("<button"), `forged chip: ${html}`);
});

// --- inline mode (card fields) ---------------------------------------------

test("inline mode unwraps block structure a field should not contain", () => {
  const html = render("- one\n- two", { size: "compact", inline: true });
  assert.ok(!html.includes("<ul"), `list survived inline mode: ${html}`);
  assert.ok(html.includes("one"));
  const heading = render("# Big Title", { size: "compact", inline: true });
  assert.ok(!heading.includes("<h1"), `heading survived inline mode: ${heading}`);
  assert.ok(heading.includes("Big Title"));
});

test("inline mode keeps term chips, marks, and bold", () => {
  const html = render("==Uncountable== — compare `much` vs `many`.", {
    size: "compact",
    inline: true,
  });
  assert.match(html, /<mark>Uncountable<\/mark>/);
  assert.match(html, /<code>much<\/code>/);
});

test("inline mode drops link anchors but keeps their text", () => {
  const html = render("See [the appendix](https://example.com).", {
    size: "compact",
    inline: true,
  });
  assert.ok(!html.includes("<a"), `anchor survived inline mode: ${html}`);
  assert.ok(html.includes("the appendix"));
});

// --- surface structure ------------------------------------------------------

test("tables get a scroll wrapper so wide content cannot widen the surface", () => {
  const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
  assert.ok(html.includes("overflow-x-auto"), `no scroll wrapper: ${html}`);
});

test("a lone bold line is classed as an answer lead in chat size only", () => {
  const chat = render("**Key forms**\n\nBody text.");
  assert.ok(chat.includes('class="answer-lead"'), `no lead class: ${chat}`);
  const compact = render("**Key forms**\n\nBody text.", { size: "compact" });
  assert.ok(!compact.includes("answer-lead"));
});

test("empty and whitespace-only input renders nothing, not an error", () => {
  assert.equal(render("").includes("undefined"), false);
  assert.doesNotThrow(() => render("   \n\n  "));
});
