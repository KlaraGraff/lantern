import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { computePosition } from "@floating-ui/core";
import type { Platform } from "@floating-ui/core";

import {
  FLIP_GAP,
  POPOVER_PLACEMENT,
  VIEWPORT_PADDING,
  popoverMiddleware,
} from "../src/components/popover-placement.ts";

/**
 * These are the numbers the reader sees: where the lookup popover lands when
 * the tapped word is near an edge of the window. The hand-rolled arithmetic
 * this replaced had two shipped fixes against it (`2a0b907`, `9c5523b`) and no
 * coverage at all, because it only existed inside a DOM event handler.
 *
 * `computePosition` from `@floating-ui/core` takes the platform as an
 * argument — that is what React Native uses — so the whole placement chain
 * runs here with a viewport described as plain numbers, no DOM required.
 */

const VIEWPORT = { width: 1280, height: 800 };

/** A popover of a fixed size, anchored at a point, placed by our middleware. */
async function place(
  anchor: { x: number; y: number },
  popover: { width: number; height: number },
  viewport = VIEWPORT,
) {
  const platform: Platform = {
    getElementRects: ({ reference, floating }) => ({
      reference: reference as unknown as { x: number; y: number; width: number; height: number },
      floating: { x: 0, y: 0, width: floating.width, height: floating.height },
    }),
    getDimensions: (element) => element as { width: number; height: number },
    // Everything is measured against the window, which is what `strategy:
    // "fixed"` on a non-portalled `position: fixed` element gets in the app.
    getClippingRect: () => ({ x: 0, y: 0, width: viewport.width, height: viewport.height }),
  };

  const { x, y, placement } = await computePosition(
    { x: anchor.x, y: anchor.y, width: 0, height: 0 },
    popover,
    { platform, placement: POPOVER_PLACEMENT, middleware: popoverMiddleware() },
  );
  return { left: x, top: y, placement };
}

/** Roughly ExplainPopover: 440 wide, and about as tall as it gets. */
const POPOVER = { width: 440, height: 300 };

describe("popover placement", () => {
  it("opens down and to the right of the click when there is room", async () => {
    const { left, top, placement } = await place({ x: 300, y: 200 }, POPOVER);
    assert.equal(placement, "bottom-start");
    assert.equal(left, 300);
    // Flush against the click point, with no gap — which is how these popovers
    // have always opened downward.
    assert.equal(top, 200);
  });

  it("slides left instead of running off the right edge", async () => {
    const { left, top } = await place({ x: 1200, y: 200 }, POPOVER);
    assert.equal(left, VIEWPORT.width - POPOVER.width - VIEWPORT_PADDING);
    assert.equal(top, 200);
  });

  it("slides right instead of running off the left edge", async () => {
    const { left } = await place({ x: -40, y: 200 }, POPOVER);
    assert.equal(left, VIEWPORT_PADDING);
  });

  it("flips above the click when it would overflow the bottom", async () => {
    const { top, placement } = await place({ x: 300, y: 700 }, POPOVER);
    assert.equal(placement, "top-start");
    // Bottom edge sits FLIP_GAP above the click point.
    assert.equal(top, 700 - POPOVER.height - FLIP_GAP);
  });

  it("keeps the popover on screen when neither side has room", async () => {
    // Taller than the viewport minus its margins: there is no placement that
    // fits, and the failure mode that matters is a negative `top`, which puts
    // the popover's header off the top of the window where it cannot be read
    // or dismissed.
    const tall = { width: 440, height: 900 };
    const { top } = await place({ x: 300, y: 400 }, tall);
    assert.ok(top <= VIEWPORT_PADDING, `expected top <= ${VIEWPORT_PADDING}, got ${top}`);
    assert.ok(top > -tall.height, `expected the popover to overlap the viewport, got ${top}`);
  });

  it("re-places from scratch when streamed content grows the popover", async () => {
    // The bug behind 2a0b907: the position was computed once against a short
    // box, and the box then grew past the edge it had been clamped against.
    // Same anchor, two sizes — the taller one has to move.
    const anchor = { x: 300, y: 560 };
    const short = await place(anchor, { width: 440, height: 120 });
    const grown = await place(anchor, { width: 440, height: 400 });

    assert.equal(short.placement, "bottom-start");
    assert.equal(short.top, 560);

    assert.equal(grown.placement, "top-start");
    assert.equal(grown.top, 560 - 400 - FLIP_GAP);
  });

  it("holds up in the narrow layout, where the popover is wider than the window", async () => {
    const narrow = { width: 500, height: 900 };
    const { left } = await place({ x: 420, y: 100 }, { width: 520, height: 200 }, narrow);
    // 520 does not fit in 500 no matter what, so the only sane answer is to
    // pin the left edge in view rather than let the start of the text vanish.
    assert.equal(left, VIEWPORT_PADDING);
  });
});
