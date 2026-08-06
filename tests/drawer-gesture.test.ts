import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DRAWER_EDGE_ZONE_PX,
  DRAWER_SETTLE_MS,
  DrawerGestureController,
  type DrawerGestureState,
} from "../src/hooks/useDrawerGesture.ts";

const WIDTH = 300;
const POINTER = 7;

/** A controller on a fake clock: every step says how long it took. */
function drawer(initialOpen = false) {
  let clock = 0;
  const frames: DrawerGestureState[] = [];
  let settledCount = 0;

  const controller = new DrawerGestureController({
    width: () => WIDTH,
    now: () => clock,
    initialOpen,
  });
  controller.subscribe((state) => frames.push(state));
  controller.subscribeSettled(() => {
    settledCount += 1;
  });

  const at = (x: number, y: number) => ({ pointerId: POINTER, clientX: x, clientY: y });

  return {
    controller,
    frames,
    get settledCount() {
      return settledCount;
    },
    get fraction() {
      return controller.fractionRef.current;
    },
    get open() {
      return controller.isOpen();
    },
    get dragging() {
      return controller.getState().dragging;
    },
    down: (x: number, y = 400) => controller.pointerDown(at(x, y)),
    move: (x: number, y = 400, ms = 16) => {
      clock += ms;
      controller.pointerMove(at(x, y));
    },
    up: (x: number, y = 400, ms = 16) => {
      clock += ms;
      controller.pointerUp(at(x, y));
    },
    cancel: (x: number, y = 400) => controller.pointerCancel(at(x, y)),
  };
}

describe("where a drag may start", () => {
  it("ignores a drag that starts outside the left edge zone", () => {
    const d = drawer();
    assert.equal(d.down(60), false);
    d.move(260);
    d.up(260);
    assert.equal(d.fraction, 0);
    assert.equal(d.open, false);
    assert.equal(d.frames.length, 0);
  });

  it("opens from inside the edge zone", () => {
    const d = drawer();
    assert.equal(d.down(5), true);
    d.move(105, 400, 200);
    assert.ok(d.fraction > 0, "drawer should follow the finger");
    assert.equal(d.dragging, true);
    d.move(205, 400, 200);
    d.up(205, 400, 200);
    assert.equal(d.open, true);
    assert.equal(d.fraction, 1);
    assert.equal(d.dragging, false);
  });

  it("treats the far side of the edge zone as outside it", () => {
    assert.equal(drawer().down(DRAWER_EDGE_ZONE_PX), false);
    assert.equal(drawer().down(DRAWER_EDGE_ZONE_PX - 1), true);
  });

  it("accepts any start point once the drawer is open", () => {
    const d = drawer(true);
    assert.equal(d.down(240), true);
    d.move(140, 400, 200);
    assert.ok(d.fraction < 1);
  });
});

describe("direction lock", () => {
  it("kills the gesture for good once vertical movement passes the lock", () => {
    const d = drawer();
    d.down(5);
    d.move(7, 380, 16); // 20px up — past the 8px lock
    assert.equal(d.fraction, 0);
    d.move(205, 380, 16); // finger turns sideways: too late, this is a scroll
    d.move(280, 380, 16);
    assert.equal(d.fraction, 0);
    assert.equal(d.dragging, false);
    d.up(280, 380, 16);
    assert.equal(d.open, false);
    assert.equal(d.settledCount, 0);
  });

  it("does not move the drawer until horizontal beats vertical by the dominance ratio", () => {
    const d = drawer();
    d.down(5);
    d.move(13, 406, 16); // dx 8, dy 6 — inside the lock but only 1.33x
    assert.equal(d.fraction, 0);
    assert.equal(d.dragging, false);
    d.move(17, 406, 16); // dx 12 against dy 6 — now 2x
    assert.ok(d.fraction > 0);
  });

  it("does not move the drawer on movement below the horizontal slop", () => {
    const d = drawer();
    d.down(5);
    d.move(9, 400, 16);
    assert.equal(d.fraction, 0);
    assert.equal(d.dragging, false);
  });
});

describe("settling by position", () => {
  it("snaps open past the halfway threshold", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 200);
    d.move(190, 400, 200); // 61% out
    d.up(190, 400, 200);
    assert.equal(d.open, true);
    assert.equal(d.fraction, 1);
    assert.equal(d.settledCount, 1);
  });

  it("snaps closed below it", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 200); // 33% out
    d.up(105, 400, 200);
    assert.equal(d.open, false);
    assert.equal(d.fraction, 0);
    assert.equal(d.settledCount, 0);
  });
});

describe("settling by velocity", () => {
  it("lets a fast flick open the drawer from under the halfway mark", () => {
    const d = drawer();
    d.down(5);
    d.move(35, 400, 300); // crawling
    d.move(75, 400, 10); // 4 px/ms — a flick
    d.up(75, 400, 0);
    assert.equal(d.open, true);
  });

  it("lets a fast flick close the drawer from over the halfway mark", () => {
    const d = drawer(true);
    d.down(240);
    d.move(230, 400, 300);
    d.move(190, 400, 10); // 4 px/ms leftwards
    d.up(190, 400, 0);
    assert.equal(d.open, false);
    assert.equal(d.fraction, 0);
  });

  it("reads a slow drag that ends in a flick as a flick", () => {
    const d = drawer();
    d.down(5);
    // 1.2s of crawling: first-to-last velocity is about 0.05 px/ms, well under
    // the flick threshold, and the drawer is only a third out.
    for (let x = 25; x <= 65; x += 20) d.move(x, 400, 400);
    d.move(105, 400, 20); // 2 px/ms over the last 20ms
    d.up(105, 400, 0);
    assert.ok(d.fraction === 1 && d.open, "the tail of the gesture should decide");
  });

  it("keeps position in charge when the release is slow", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 400);
    d.move(190, 400, 400); // 0.21 px/ms — not a flick
    d.up(190, 400, 400);
    assert.equal(d.open, true);
  });
});

describe("interrupted gestures", () => {
  it("settles on pointercancel instead of sticking mid-drag", () => {
    const d = drawer();
    d.down(5);
    d.move(190, 400, 200);
    d.cancel(190);
    assert.equal(d.open, true);
    assert.equal(d.fraction, 1);
    assert.equal(d.dragging, false);
  });

  it("settles a cancelled short drag back to closed", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 200);
    d.cancel(105);
    assert.equal(d.open, false);
    assert.equal(d.fraction, 0);
  });

  it("ignores a flick when the system takes the gesture away", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 10); // fast, but cancelled rather than released
    d.cancel(105);
    assert.equal(d.open, false);
  });

  it("is ready for the next gesture after a cancel", () => {
    const d = drawer();
    d.down(5);
    d.move(190, 400, 200);
    d.cancel(190);
    assert.equal(d.down(240), true, "the reopened drawer should accept a new pointer");
  });

  it("ignores events from a pointer it is not tracking", () => {
    const d = drawer();
    d.down(5);
    d.controller.pointerMove({ pointerId: POINTER + 1, clientX: 205, clientY: 400 });
    assert.equal(d.fraction, 0);
    d.controller.pointerUp({ pointerId: POINTER + 1, clientX: 205, clientY: 400 });
    assert.equal(d.open, false);
  });
});

describe("the fraction stays inside [0, 1]", () => {
  it("clamps over-drag past fully open", () => {
    const d = drawer();
    d.down(5);
    d.move(405, 400, 200); // 400px of travel across a 300px drawer
    assert.equal(d.fraction, 1);
    for (const frame of d.frames) assert.ok(frame.fraction <= 1);
  });

  it("clamps a drag that pushes past fully closed", () => {
    const d = drawer(true);
    d.down(240);
    d.move(-300, 400, 200);
    assert.equal(d.fraction, 0);
    for (const frame of d.frames) assert.ok(frame.fraction >= 0);
  });
});

describe("what the component subscribes to", () => {
  it("reports every frame without changing the settled state until release", () => {
    const d = drawer();
    d.down(5);
    d.move(105, 400, 200);
    d.move(150, 400, 200);
    d.move(190, 400, 200);
    assert.ok(d.frames.length >= 3);
    assert.equal(d.settledCount, 0);
    assert.ok(d.frames.every((frame) => frame.dragging));
    d.up(190, 400, 200);
    assert.equal(d.settledCount, 1);
    assert.equal(d.frames[d.frames.length - 1].dragging, false);
  });

  it("opens and closes without a pointer for the hamburger, the scrim and Esc", () => {
    const d = drawer();
    d.controller.setOpen(true);
    assert.equal(d.open, true);
    assert.equal(d.fraction, 1);
    assert.equal(d.settledCount, 1);
    d.controller.setOpen(false);
    assert.equal(d.fraction, 0);
    assert.equal(d.settledCount, 2);
  });

  it("keeps the settle duration next to the gesture constants", () => {
    assert.equal(DRAWER_SETTLE_MS, 200);
  });
});
