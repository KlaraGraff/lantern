import assert from "node:assert/strict";
import test from "node:test";

import {
  MARK_COLLISION_THRESHOLD,
  SYSTEM_MARKS,
  blendOver,
  colorDistance,
  markBlendMode,
  markCollisions,
  systemMark,
  washBlendMode,
} from "../src/components/mark-palette.ts";
import {
  MARKER_COLOR_PRESETS,
  createDefaultMarkerStyleConfig,
} from "../src/components/marker-style.ts";
import type { MarkerVisualStyle } from "../src/components/marker-style.ts";

const PAPER = "#FAF7F0";
const DARK = "#1b1b1f";
/** Every page a mark has to survive — the same pair `markCollisions` measures against. */
const PAGES = [PAPER, DARK];

function wash(color: string, opacity = 34): MarkerVisualStyle {
  return { color, opacity, background: true, underline: false, bold: false, font: "inherit" };
}

/** A system mark as the book draws it on this page. */
function asDrawn(mark: (typeof SYSTEM_MARKS)[number], page: string) {
  return blendOver(mark.color, mark.opacity, page, markBlendMode(mark, page));
}

test("a wash is measured as the colour it lands on the page as, not the hex behind it", () => {
  // Half of a black wash over white paper is the middle grey you actually see.
  assert.equal(blendOver("#000000", 0.5, "#FFFFFF"), "#808080");
  // Nothing at all is the paper.
  assert.equal(blendOver("#123456", 0, PAPER), PAPER.toUpperCase());
  // Everything is the colour itself.
  assert.equal(blendOver("#123456", 1, PAPER), "#123456");
});

test("multiply darkens where plain alpha does not", () => {
  const plain = blendOver("#7DD3FC", 0.42, PAPER);
  const multiplied = blendOver("#7DD3FC", 0.42, PAPER, "multiply");
  // Same sky, same strength — but multiplied it can only ever subtract light,
  // which is what keeps text legible under the read-aloud wash.
  assert.notEqual(plain, multiplied);
  assert.ok(colorDistance(multiplied, PAPER) > colorDistance(plain, PAPER));
});

test("a wash blends the way the page it lands on can take", () => {
  assert.equal(washBlendMode(PAPER), "multiply");
  assert.equal(washBlendMode(DARK), "screen");
  // Only a wash blends into the page; the underlines are laid flat over it.
  assert.equal(markBlendMode(systemMark.reading, DARK), "screen");
  assert.equal(markBlendMode(systemMark.learning, DARK), "normal");
  // Screen adds light where multiply takes it, so on a dark page the two go
  // opposite ways from the same colour — which is the whole fix.
  assert.ok(
    colorDistance(blendOver("#7DD3FC", 0.42, DARK, "screen"), DARK)
      > colorDistance(blendOver("#7DD3FC", 0.42, DARK, "multiply"), DARK),
  );
});

test("the read-aloud wash is visible on every page, not just the light one", () => {
  for (const page of PAGES) {
    const distance = colorDistance(asDrawn(systemMark.reading, page), page);
    assert.ok(
      distance >= MARK_COLLISION_THRESHOLD,
      `the reading wash lands only ${Math.round(distance)} from ${page}`,
    );
  }
  // What it used to be: multiplied into the dark theme there was no light in
  // the page left to subtract, so the sentence being read aloud was unmarked.
  const wasInvisible = colorDistance(blendOver(
    systemMark.reading.color,
    systemMark.reading.opacity,
    DARK,
    "multiply",
  ), DARK);
  assert.ok(wasInvisible < MARK_COLLISION_THRESHOLD, `multiplied it was ${Math.round(wasInvisible)} away`);
});

test("the reason the check blends first: two colours can pass on hex and fail on the page", () => {
  // The blue that shipped as a preset against the read-aloud sky.
  const raw = colorDistance("#5B8FD9", systemMark.reading.color);
  const onThePage = colorDistance(
    blendOver("#5B8FD9", 0.34, PAPER),
    asDrawn(systemMark.reading, PAPER),
  );
  assert.ok(raw > MARK_COLLISION_THRESHOLD, `raw hex distance was only ${Math.round(raw)}`);
  assert.ok(onThePage < MARK_COLLISION_THRESHOLD, `blended distance was ${Math.round(onThePage)}`);
});

test("shape is checked before colour — a wash and an underline do not compete", () => {
  // Exactly the "learning" teal, but painted across a range instead of under a
  // word. Nothing to confuse: the two never take the same form.
  assert.deepEqual(markCollisions(wash(systemMark.learning.color, 100)), []);
  // Switch the underline on and the same colour is suddenly the same mark.
  assert.deepEqual(
    markCollisions({ ...wash(systemMark.learning.color), background: false, underline: true }),
    ["learning"],
  );
});

test("every preset clears every system mark it could be mistaken for", () => {
  for (const preset of MARKER_COLOR_PRESETS) {
    // Both forms the reader can put a preset in, at the strongest setting each.
    assert.deepEqual(markCollisions(wash(preset, 100)), [], `${preset} as a wash`);
    assert.deepEqual(
      markCollisions({ ...wash(preset), background: false, underline: true }),
      [],
      `${preset} as an underline`,
    );
  }
});

test("the presets that shipped before are the ones this rule was written to reject", () => {
  assert.deepEqual(markCollisions({ ...wash("#4FAE91"), background: false, underline: true }), ["learning"]);
  assert.deepEqual(markCollisions({ ...wash("#8A8F98"), background: false, underline: true }), ["mastered"]);
  assert.deepEqual(markCollisions(wash("#5B8FD9")), ["reading"]);
});

test("the defaults do not warn about themselves", () => {
  const defaults = createDefaultMarkerStyleConfig();
  assert.deepEqual(markCollisions(defaults.manual), []);
  assert.deepEqual(markCollisions(defaults.automatic), []);
});

test("a mark too faint to see is not reported as looking like anything", () => {
  // The read-aloud colour itself, thinned until it barely tints the paper. It is
  // as close to that wash as a colour can get, and still not worth saying so:
  // at 5% there is nothing on the page to confuse.
  const invisible = wash(systemMark.reading.color, 5);
  assert.deepEqual(markCollisions(invisible), []);
  // Turn it up and the same hue is the same mark.
  assert.deepEqual(markCollisions({ ...invisible, opacity: 45 }), ["reading"]);
});

test("no two system marks of the same shape are within the threshold of each other", () => {
  // The rule the reader is held to, applied to the app's own palette, on both
  // pages the reader can be on. If this fails, the presets are not the problem
  // — the marks themselves are.
  for (const page of PAGES) {
    for (const a of SYSTEM_MARKS) {
      for (const b of SYSTEM_MARKS) {
        if (a.id === b.id || a.shape !== b.shape) continue;
        const distance = colorDistance(asDrawn(a, page), asDrawn(b, page));
        assert.ok(
          distance >= MARK_COLLISION_THRESHOLD,
          `${a.id} and ${b.id} are only ${Math.round(distance)} apart on ${page}`,
        );
      }
    }
  }
});
