import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * `ReaderSettings` is a component, so the rule under test lives in a DOM
 * keydown handler that this harness cannot mount. What can be pinned is the
 * guard's own shape, which is where the bug was: the handler skipped Escape
 * whenever *any* `[role="dialog"][aria-modal="true"]` was in the document —
 * and on the narrow layout that match is this panel itself.
 */
const source = readFileSync(
  path.join(import.meta.dirname, "../src/components/ReaderSettings.tsx"),
  "utf8",
);

test("the settings panel is itself a modal dialog on the narrow sheet", () => {
  // The premise of the bug. If this ever stops being true the guard below no
  // longer needs its exemption, and this test should be re-read rather than
  // silently passing.
  assert.match(source, /role=\{isNarrow \? "dialog" : undefined\}/);
  assert.match(source, /aria-modal=\{isNarrow \? true : undefined\}/);
});

test("the Escape guard ignores the settings surface itself", () => {
  const start = source.indexOf("const handleEscape = (event: KeyboardEvent) => {");
  assert.ok(start >= 0, "no Escape handler found in ReaderSettings");
  const end = source.indexOf('document.addEventListener("keydown", handleEscape)');
  assert.ok(end > start, "could not delimit the Escape handler");
  const handler = source.slice(start, end);

  // It must still defer to a dialog layered above the popover…
  assert.match(handler, /\[role="dialog"\]\[aria-modal="true"\]/);
  // …but a dialog that is this panel's own root (the narrow sheet) cannot be
  // above itself: compare it against the panel ref instead of skipping on any
  // match, which made Escape a no-op on a phone or narrow window.
  assert.match(
    handler,
    /popoverRef\.current\?\.contains\(/,
    "the switch to Escape must not be blocked by the panel's own dialog",
  );
});

const zoneGuide = readFileSync(
  path.join(import.meta.dirname, "../src/components/ReaderZoneGuide.tsx"),
  "utf8",
);

test("dismissing the zone guide with a key does not also leave the book", () => {
  // The guide portals to <body> and is not a modal dialog, so the reader's own
  // window-level Escape handler treats the same keypress as "back to the shelf".
  const start = zoneGuide.indexOf("onKeyDown={(event) => {");
  const end = zoneGuide.indexOf("aria-label=", start);
  assert.ok(start >= 0 && end > start, "no keydown handler found in ReaderZoneGuide");
  const handler = zoneGuide.slice(start, end);
  assert.match(handler, /onDismiss\(\)/);
  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /event\.stopPropagation\(\)/);
});
