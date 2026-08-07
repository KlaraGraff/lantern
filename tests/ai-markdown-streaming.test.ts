import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import AiMarkdown from "../src/components/ai-markdown/AiMarkdown.ts";
import { settleStreamingTail } from "../src/components/ai-markdown/streaming-tail.ts";

// Streaming is where a marker layer falls over: mid-stream the text ends in
// half a marker, and a naive renderer flashes raw `==` or reshapes a line a
// beat after it appeared. These tests feed the renderer exact prefixes of a
// streamed answer — the states real users see — and assert the output never
// shows a raw marker and never loses the already-arrived words.

const i18nDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "../src/i18n");
const en = JSON.parse(readFileSync(path.join(i18nDir, "en.json"), "utf8")) as Record<string, string>;

if (!i18next.isInitialized) {
  i18next.use(initReactI18next).init({
    resources: { en: { translation: en } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
}

function renderStreaming(markdown: string): string {
  return renderToStaticMarkup(
    createElement(AiMarkdown, { size: "chat", streaming: true, children: markdown }),
  );
}

// --- the guard itself ------------------------------------------------------

test("a lone trailing = (half of ==) is hidden", () => {
  assert.equal(settleStreamingTail("The key form ="), "The key form ");
});

test("a bare trailing opener is hidden until content follows", () => {
  assert.equal(settleStreamingTail("The key form =="), "The key form ");
});

test("an opened mark with content is closed so styling holds steady", () => {
  assert.equal(settleStreamingTail("The ==present per"), "The ==present per==");
});

test("closing a span that ends in a half marker does not create a === run", () => {
  assert.equal(settleStreamingTail("The ==present perfect="), "The ==present perfect==");
});

test("bold and strikethrough tails settle the same way", () => {
  assert.equal(settleStreamingTail("A **bo"), "A **bo**");
  assert.equal(settleStreamingTail("A ~~stri"), "A ~~stri~~");
});

test("an unbalanced backtick is closed, not shown raw", () => {
  assert.equal(settleStreamingTail("Compare `take u"), "Compare `take u`");
});

test("a half-arrived alert tag hides its whole line — no quote card flashes first", () => {
  assert.equal(settleStreamingTail("Intro.\n\n> [!WAR"), "Intro.\n\n");
  assert.equal(settleStreamingTail("> [!"), "");
});

test("a completed alert tag line passes through untouched", () => {
  const done = "> [!WARNING]\n> Easily confused.";
  assert.equal(settleStreamingTail(done), done);
});

test("inside an unclosed code fence nothing is rewritten", () => {
  const mid = "Look:\n\n```js\nif (a == b) {\nx ==";
  assert.equal(settleStreamingTail(mid), mid);
});

test("settling only touches the current block — earlier marks stay as sent", () => {
  const settled = settleStreamingTail("==done== earlier.\n\nNow ==half");
  assert.equal(settled, "==done== earlier.\n\nNow ==half==");
});

test("balanced text passes through byte-identical", () => {
  for (const text of [
    "",
    "Plain prose, nothing special.",
    "A ==closed mark== and `closed code` and **closed bold**.",
    "> [!TIP]\n> Complete alert.\n\nAnd a paragraph.",
  ]) {
    assert.equal(settleStreamingTail(text), text);
  }
});

// --- every prefix of a real answer, through the real renderer ---------------

const FULL_ANSWER = [
  "**Key distinction**",
  "",
  "The ==present perfect== links a past event to now, as in `have taken`.",
  "",
  "> [!WARNING]",
  "> Easily confused with the simple past.",
  "",
  "> The moment one definitely commits oneself, then providence moves too.",
].join("\n");

test("no prefix of a streamed answer ever shows a raw marker or half tag", () => {
  for (let cut = 0; cut <= FULL_ANSWER.length; cut += 1) {
    const html = renderStreaming(FULL_ANSWER.slice(0, cut));
    assert.ok(!html.includes("=="), `raw == at cut ${cut}: ${html}`);
    assert.ok(!/\[![A-Za-z]*/.test(html), `half alert tag at cut ${cut}: ${html}`);
  }
});

test("once a word has streamed in, no later chunk makes it disappear", () => {
  // Flicker check: the settled render of each prefix must contain every whole
  // word the raw prefix had already completed (a word is complete once the
  // character after it has arrived). Markers may be hidden; words may not.
  for (let cut = 1; cut <= FULL_ANSWER.length; cut += 1) {
    const raw = FULL_ANSWER.slice(0, cut);
    const html = renderStreaming(raw);
    const text = html.replace(/<[^>]+>/g, " ");
    const words = raw
      .slice(0, Math.max(0, raw.length - 20))
      // The alert tag word is *supposed* to disappear — it renders as the
      // translated strip label, not as prose.
      .replace(/\[!\w*\]?/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1);
    for (const word of words) {
      assert.ok(text.includes(word), `word "${word}" vanished at cut ${cut}: ${html}`);
    }
  }
});

test("the finished answer renders all four semantics at once", () => {
  const html = renderStreaming(FULL_ANSWER);
  assert.ok(html.includes('class="answer-lead"'), "lead heading missing");
  assert.match(html, /<mark>present perfect<\/mark>/);
  assert.match(html, /<code>have taken<\/code>/);
  assert.ok(html.includes('role="note"'), "alert strip missing");
  assert.match(html, /<blockquote[\s>]/);
});
