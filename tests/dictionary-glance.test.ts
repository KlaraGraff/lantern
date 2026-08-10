import assert from "node:assert/strict";
import test from "node:test";
import {
  clickSpendsGlance,
  glanceCounts,
  glanceDefinition,
  newGlanceAttempt,
  GLANCE_DWELL_MS,
  type GlanceClickNode,
} from "../src/components/dictionary-glance.ts";

const plain: GlanceClickNode = { isMenuItem: false, glanceSafe: false };
const menuItem: GlanceClickNode = { isMenuItem: true, glanceSafe: false };
const safeItem: GlanceClickNode = { isMenuItem: true, glanceSafe: true };

test("a read entry with nothing else clicked counts", () => {
  const attempt = newGlanceAttempt();
  attempt.dwelt = true;
  assert.equal(glanceCounts(attempt), true);
});

test("closing before the dwell elapses does not count", () => {
  assert.equal(glanceCounts(newGlanceAttempt()), false);
});

test("a menu action spends the glance even after the dwell", () => {
  const attempt = newGlanceAttempt();
  attempt.dwelt = true;
  attempt.spent = true;
  assert.equal(glanceCounts(attempt), false);
});

test("the dwell is long enough to rule out a menu opened and dismissed", () => {
  // Guards the constant itself: the exposure engine's 700ms threshold is for a
  // word merely being on screen, and a demotion may not be that cheap.
  assert.ok(GLANCE_DWELL_MS >= 1500);
});

test("clicking a menu row spends the glance", () => {
  assert.equal(clickSpendsGlance([menuItem]), true);
});

test("clicking the icon inside a row spends it too", () => {
  // The click lands on the <svg>, never on the button itself.
  assert.equal(clickSpendsGlance([plain, menuItem, plain]), true);
});

test("expanding the entry does not spend the glance", () => {
  assert.equal(clickSpendsGlance([safeItem]), false);
});

test("a glance-safe control shields what is inside it", () => {
  assert.equal(clickSpendsGlance([plain, safeItem, plain, menuItem]), false);
});

test("clicking the card's text spends nothing", () => {
  assert.equal(clickSpendsGlance([plain, plain]), false);
});

test("a definition flattens the card's grouped senses", () => {
  assert.equal(
    glanceDefinition({
      groups: [
        { pos: "n.", senses: ["灯", "光"] },
        { pos: "adj.", senses: ["轻的"] },
      ],
      fallbackSummary: null,
    }),
    "n. 灯；光  adj. 轻的",
  );
});

test("the degraded one-line entry is reported verbatim", () => {
  assert.equal(
    glanceDefinition({ groups: [], fallbackSummary: "轻的；点燃" }),
    "轻的；点燃",
  );
});

test("a group with no part of speech keeps its senses", () => {
  assert.equal(
    glanceDefinition({ groups: [{ pos: "", senses: ["灯"] }], fallbackSummary: null }),
    "灯",
  );
});

test("no entry means no definition, not a crash", () => {
  assert.equal(glanceDefinition(null), "");
});
