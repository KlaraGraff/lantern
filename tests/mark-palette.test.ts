import assert from "node:assert/strict";
import test from "node:test";

import {
  MARK_BACKDROPS,
  MARK_COLLISION_THRESHOLD,
  MARK_CUED_COLLISION_THRESHOLD,
  MARK_LEGIBILITY_THRESHOLD,
  SYSTEM_MARKS,
  blendOver,
  colorDistance,
  markBlendMode,
  markCollisions,
  markInvisibleOn,
  systemMark,
  washBlendMode,
} from "../src/components/mark-palette.ts";
import {
  MARKER_COLOR_PRESETS,
  createDefaultMarkerStyleConfig,
} from "../src/components/marker-style.ts";
import { getThemeStyles } from "../src/components/reader-settings.ts";
import type { MarkerVisualStyle } from "../src/components/marker-style.ts";

const PAPER = "#FAF7F0";
const DARK = "#1b1b1f";
/** Every page a mark has to survive — read off the same list `markCollisions` measures against. */
const PAGES = MARK_BACKDROPS.map((theme) => getThemeStyles(theme).body);

const defaults = createDefaultMarkerStyleConfig();
/** The opacities a mark is actually worn at. Validating at 100% proves nothing. */
const MANUAL_OPACITY = defaults.manual.opacity;
const AUTOMATIC_OPACITY = defaults.automatic.opacity;

function wash(color: string, opacity = MANUAL_OPACITY): MarkerVisualStyle {
  return { color, opacity, background: true, underline: false, bold: false, font: "inherit" };
}

function underline(color: string): MarkerVisualStyle {
  return { ...wash(color), background: false, underline: true };
}

/** A system mark as the book draws it on this page. */
function asDrawn(mark: (typeof SYSTEM_MARKS)[number], page: string) {
  return blendOver(mark.color, mark.opacity, page, markBlendMode(mark, page));
}

test("the page list is the one the app ships, not a copy of it", () => {
  // Every reader theme with a colour of its own belongs here. When one is added
  // and this list is not, the checks below quietly stop covering it — which is
  // how the Gray theme went unmeasured while four of five presets faded into it.
  assert.ok(PAGES.length >= 4, `only ${PAGES.length} pages checked`);
  assert.ok(PAGES.includes(getThemeStyles("quiet").body), "the mid-grey theme is not being checked");
});

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
  assert.ok(wasInvisible < MARK_LEGIBILITY_THRESHOLD, `multiplied it was ${Math.round(wasInvisible)} away`);
});

test("the reason the check blends first: two colours can pass on hex and fail on the page", () => {
  // The blue that shipped as a preset against the read-aloud sky.
  const raw = colorDistance("#5B8FD9", systemMark.reading.color);
  const onThePage = colorDistance(
    blendOver("#5B8FD9", MANUAL_OPACITY / 100, PAPER),
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
  assert.deepEqual(markCollisions(underline(systemMark.learning.color)), ["learning"]);
});

test("a treatment the system mark lacks lowers the bar without removing it", () => {
  // The read-aloud sky, worn as a wash: the same mark, and reported as one.
  const sky = wash(systemMark.reading.color, 45);
  assert.deepEqual(markCollisions(sky), ["reading"]);
  // Underline it and the pair carries a second channel the wash does not. Still
  // the same hue, so still reported — the cue lowers the threshold, it does not
  // hand out an exemption.
  assert.deepEqual(markCollisions({ ...sky, underline: true }), ["reading"]);
  // A colour that sits between the two bars on every page: near enough the
  // read-aloud wash to be worth a word on its own, far enough that an underline
  // settles it. Without the cue it warns; with it, it does not.
  const nearby = wash("#96F0C3", 45);
  const gaps = PAGES.map((page) => colorDistance(
    blendOver(nearby.color, nearby.opacity / 100, page),
    asDrawn(systemMark.reading, page),
  ));
  assert.ok(
    Math.min(...gaps) > MARK_CUED_COLLISION_THRESHOLD && Math.max(...gaps) < MARK_COLLISION_THRESHOLD,
    `the sample colour sits at ${gaps.map(Math.round).join("/")}, outside the band this test needs`,
  );
  assert.deepEqual(markCollisions(nearby), ["reading"]);
  assert.deepEqual(markCollisions({ ...nearby, underline: true }), []);
});

test("every preset clears every system mark, at the opacity it is worn at, on every page", () => {
  for (const preset of MARKER_COLOR_PRESETS) {
    // Both forms the reader can put a preset in. The wash is measured at the
    // manual default, not at 100%: a mark is never seen at full strength, and
    // checking it there is how two presets shipped that collide once thinned.
    assert.deepEqual(markCollisions(wash(preset)), [], `${preset} as a wash`);
    assert.deepEqual(markCollisions(underline(preset)), [], `${preset} as an underline`);
  }
});

test("every preset is still visible on every page", () => {
  for (const preset of MARKER_COLOR_PRESETS) {
    assert.deepEqual(markInvisibleOn(wash(preset)), [], `${preset} disappears on some page`);
  }
});

test("the swatch row reads as five colours, not three", () => {
  // Presets are compared to each other in one place only — the row of swatches,
  // where they sit side by side at full strength. On the page they never meet:
  // there is one manual colour at a time.
  for (let i = 0; i < MARKER_COLOR_PRESETS.length; i += 1) {
    for (let j = i + 1; j < MARKER_COLOR_PRESETS.length; j += 1) {
      const distance = colorDistance(MARKER_COLOR_PRESETS[i], MARKER_COLOR_PRESETS[j]);
      assert.ok(
        distance >= MARK_COLLISION_THRESHOLD,
        `${MARKER_COLOR_PRESETS[i]} and ${MARKER_COLOR_PRESETS[j]} are only ${Math.round(distance)} apart in the row`,
      );
    }
  }
});

test("the automatic mark can be told from whichever preset the reader marks with", () => {
  // The two styles the reader sees at once: a manual wash at 34% and the
  // automatic one at 16%, on the same page. The automatic carries an underline
  // the manual default does not, so the cued bar is the one that applies —
  // nothing clears the full one here. Over every theme the best any colour
  // manages against these five is 55, and it is a sky that then collides with
  // the read-aloud wash.
  for (const page of PAGES) {
    const automatic = blendOver(defaults.automatic.color, AUTOMATIC_OPACITY / 100, page);
    for (const preset of MARKER_COLOR_PRESETS) {
      const distance = colorDistance(automatic, blendOver(preset, MANUAL_OPACITY / 100, page));
      assert.ok(
        distance >= MARK_CUED_COLLISION_THRESHOLD,
        `the automatic mark is ${Math.round(distance)} from ${preset} on ${page}`,
      );
    }
  }
  assert.ok(defaults.automatic.underline, "the cue the bar above depends on is switched off");
  assert.ok(!defaults.manual.underline, "the manual default carries the same cue, so there is none");
});

test("the presets that shipped before are the ones this rule was written to reject", () => {
  assert.deepEqual(markCollisions(underline("#4FAE91")), ["learning"]);
  assert.deepEqual(markCollisions(underline("#8A8F98")), ["mastered"]);
  assert.deepEqual(markCollisions(wash("#5B8FD9")), ["reading"]);
});

test("the defaults do not warn about themselves", () => {
  assert.deepEqual(markCollisions(defaults.manual), []);
  assert.deepEqual(markCollisions(defaults.automatic), []);
  assert.deepEqual(markInvisibleOn(defaults.manual), []);
  assert.deepEqual(markInvisibleOn(defaults.automatic), []);
});

test("the automatic colour that shipped before is the one the legibility rule was written to reject", () => {
  // It cleared the paper and the dark theme and landed 10 from the Gray one —
  // a mark the app drew that the reader could not see it had.
  const faded = { ...defaults.automatic, color: "#8D7C65", underline: false };
  assert.deepEqual(markInvisibleOn(faded), ["quiet"]);
  const distance = colorDistance(
    blendOver("#8D7C65", AUTOMATIC_OPACITY / 100, getThemeStyles("quiet").body),
    getThemeStyles("quiet").body,
  );
  assert.ok(distance < MARK_LEGIBILITY_THRESHOLD, `it was ${Math.round(distance)} from the page`);
});

test("legibility follows the strongest treatment, not the opacity slider", () => {
  const faint = wash("#8D7C65", 5);
  assert.ok(markInvisibleOn(faint).length > 0, "a 5% wash should not be counted as visible");
  // An underline is drawn at full colour whatever the slider says, so the same
  // settings with the underline on are legible everywhere.
  assert.deepEqual(markInvisibleOn({ ...faint, underline: true }), []);
  // Weight is not a colour: a bold word carries on any page.
  assert.deepEqual(markInvisibleOn({ ...faint, bold: true }), []);
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
  // The rule the reader is held to, applied to the app's own palette, on every
  // page the reader can be on. If this fails, the presets are not the problem
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

test("every system mark is visible on every page", () => {
  for (const page of PAGES) {
    for (const mark of SYSTEM_MARKS) {
      const distance = colorDistance(asDrawn(mark, page), page);
      assert.ok(
        distance >= MARK_LEGIBILITY_THRESHOLD,
        `${mark.id} lands only ${Math.round(distance)} from ${page}`,
      );
    }
  }
});
