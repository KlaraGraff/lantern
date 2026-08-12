import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowZoneGuide } from "../src/pages/reader/zone-guide.ts";

const due = {
  narrow: true,
  readingMode: "paginated",
  bookReady: true,
  shownFlag: undefined as string | undefined,
};

test("shows once: narrow + paginated + book ready + never shown", () => {
  assert.equal(shouldShowZoneGuide(due), true);
});

test("never again once the flag is written", () => {
  assert.equal(shouldShowZoneGuide({ ...due, shownFlag: "true" }), false);
});

test("only the exact string retires it — anything else still owes the guide", () => {
  // Mirrors `auto_analysis_intro_shown`: there is no "unset a setting"
  // command, so a replay would write "" rather than deleting the row.
  for (const value of ["", "false", "1", "shown"]) {
    assert.equal(
      shouldShowZoneGuide({ ...due, shownFlag: value }),
      true,
      `value ${JSON.stringify(value)} should not retire the guide`,
    );
  }
});

test("desktop width never sees it", () => {
  assert.equal(shouldShowZoneGuide({ ...due, narrow: false }), false);
});

test("scrolled mode waits — the guide teaches tap-to-turn", () => {
  assert.equal(shouldShowZoneGuide({ ...due, readingMode: "scrolled" }), false);
});

test("waits for the book to render", () => {
  assert.equal(shouldShowZoneGuide({ ...due, bookReady: false }), false);
});
