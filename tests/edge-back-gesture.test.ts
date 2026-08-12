import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EDGE_BACK_ZONE_PX,
  EDGE_BACK_SETTLE_MS,
  EdgeBackGestureController,
  type EdgeBackGestureState,
  type EdgeBackOutcome,
} from "../src/hooks/edge-back-gesture.ts";

const WIDTH = 300;
const POINTER = 7;

/** A controller on a fake clock: every step says how long it took. */
function edge() {
  let clock = 0;
  const frames: EdgeBackGestureState[] = [];
  const outcomes: EdgeBackOutcome[] = [];

  const controller = new EdgeBackGestureController({
    width: () => WIDTH,
    now: () => clock,
  });
  controller.subscribe((state) => frames.push(state));
  controller.subscribeSettled((outcome) => outcomes.push(outcome));

  const at = (x: number, y: number) => ({ pointerId: POINTER, clientX: x, clientY: y });

  return {
    controller,
    frames,
    outcomes,
    get fraction() {
      return controller.fractionRef.current;
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
    const e = edge();
    assert.equal(e.down(60), false);
    e.move(260);
    e.up(260);
    assert.equal(e.fraction, 0);
    assert.equal(e.frames.length, 0);
    assert.deepEqual(e.outcomes, []);
  });

  it("starts tracking from inside the edge zone", () => {
    const e = edge();
    assert.equal(e.down(5), true);
    e.move(105, 400, 200);
    assert.ok(e.fraction > 0, "the page should follow the finger");
    assert.equal(e.dragging, true);
  });

  it("treats the far side of the edge zone as outside it", () => {
    assert.equal(edge().down(EDGE_BACK_ZONE_PX), false);
    assert.equal(edge().down(EDGE_BACK_ZONE_PX - 1), true);
  });

  it("ignores a second pointer while one is already tracked", () => {
    const e = edge();
    e.down(5);
    assert.equal(e.controller.pointerDown({ pointerId: POINTER + 1, clientX: 5, clientY: 400 }), false);
  });
});

describe("direction lock", () => {
  it("kills the gesture for good once vertical movement passes the lock", () => {
    const e = edge();
    e.down(5);
    e.move(7, 380, 16); // 20px up — past the 8px lock
    assert.equal(e.fraction, 0);
    e.move(205, 380, 16); // finger turns sideways: too late, this is a scroll
    e.move(280, 380, 16);
    assert.equal(e.fraction, 0);
    assert.equal(e.dragging, false);
    e.up(280, 380, 16);
    assert.deepEqual(e.outcomes, []);
  });

  it("does not move the page until horizontal beats vertical by the dominance ratio", () => {
    const e = edge();
    e.down(5);
    e.move(13, 406, 16); // dx 8, dy 6 — inside the lock but only 1.33x
    assert.equal(e.fraction, 0);
    assert.equal(e.dragging, false);
    e.move(17, 406, 16); // dx 12 against dy 6 — now 2x
    assert.ok(e.fraction > 0);
  });

  it("does not move the page on movement below the horizontal slop", () => {
    const e = edge();
    e.down(5);
    e.move(9, 400, 16);
    assert.equal(e.fraction, 0);
    assert.equal(e.dragging, false);
  });

  it("never claims a drag that moves left from the edge, even if it later reverses right", () => {
    const e = edge();
    e.down(10);
    e.move(-10, 400, 16); // dx -20, clears the slop leftward
    assert.equal(e.fraction, 0);
    assert.equal(e.dragging, false);
    e.move(200, 400, 16); // reversing now must not retroactively claim it
    assert.equal(e.fraction, 0);
    assert.equal(e.dragging, false);
    e.up(200, 400, 16);
    assert.deepEqual(e.outcomes, []);
  });
});

describe("settling by position", () => {
  it("reports \"back\" past the halfway threshold", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 200);
    e.move(190, 400, 200); // 61% out
    e.up(190, 400, 200);
    assert.equal(e.fraction, 1);
    assert.equal(e.dragging, false);
    assert.deepEqual(e.outcomes, ["back"]);
  });

  it("reports \"cancelled\" below it", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 200); // 33% out
    e.up(105, 400, 200);
    assert.equal(e.fraction, 0);
    assert.deepEqual(e.outcomes, ["cancelled"]);
  });
});

describe("settling by velocity", () => {
  it("lets a fast rightward flick trigger back from under the halfway mark", () => {
    const e = edge();
    e.down(5);
    e.move(35, 400, 300); // crawling
    e.move(75, 400, 10); // 4 px/ms — a flick
    e.up(75, 400, 0);
    assert.deepEqual(e.outcomes, ["back"]);
  });

  it("does not let a fast retreat toward the edge trigger back from under halfway", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 300); // out to a third
    e.move(65, 400, 10); // 4 px/ms back toward the edge
    e.up(65, 400, 0);
    assert.deepEqual(e.outcomes, ["cancelled"]);
    assert.equal(e.fraction, 0);
  });

  it("reads a slow drag that ends in a flick as a flick", () => {
    const e = edge();
    e.down(5);
    // 1.2s of crawling: first-to-last velocity is about 0.05 px/ms, well
    // under the flick threshold, and the page is only a third out.
    for (let x = 25; x <= 65; x += 20) e.move(x, 400, 400);
    e.move(105, 400, 20); // 2 px/ms over the last 20ms
    e.up(105, 400, 0);
    assert.deepEqual(e.outcomes, ["back"], "the tail of the gesture should decide");
  });

  it("keeps position in charge when the release is slow", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 400);
    e.move(190, 400, 400); // 0.21 px/ms — not a flick, but past halfway
    e.up(190, 400, 400);
    assert.deepEqual(e.outcomes, ["back"]);
  });
});

describe("interrupted gestures", () => {
  it("settles on pointercancel by position, not sticking mid-drag", () => {
    const e = edge();
    e.down(5);
    e.move(190, 400, 200);
    e.cancel(190);
    assert.deepEqual(e.outcomes, ["back"]);
    assert.equal(e.fraction, 1);
    assert.equal(e.dragging, false);
  });

  it("settles a cancelled short drag back to cancelled", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 200);
    e.cancel(105);
    assert.deepEqual(e.outcomes, ["cancelled"]);
    assert.equal(e.fraction, 0);
  });

  it("ignores a flick when the system takes the gesture away", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 10); // fast, but cancelled rather than released
    e.cancel(105);
    assert.deepEqual(e.outcomes, ["cancelled"]);
  });

  it("is ready for the next gesture after a cancel", () => {
    const e = edge();
    e.down(5);
    e.move(190, 400, 200);
    e.cancel(190);
    assert.equal(e.down(10), true, "a fresh pointer should be accepted");
  });

  it("ignores events from a pointer it is not tracking", () => {
    const e = edge();
    e.down(5);
    e.controller.pointerMove({ pointerId: POINTER + 1, clientX: 205, clientY: 400 });
    assert.equal(e.fraction, 0);
    e.controller.pointerUp({ pointerId: POINTER + 1, clientX: 205, clientY: 400 });
    assert.deepEqual(e.outcomes, []);
  });
});

describe("the fraction stays inside [0, 1]", () => {
  it("clamps over-drag past fully dismissed", () => {
    const e = edge();
    e.down(5);
    e.move(405, 400, 200); // 400px of travel across a 300px page
    assert.equal(e.fraction, 1);
    for (const frame of e.frames) assert.ok(frame.fraction <= 1);
  });

  it("clamps a drag that reverses back past the start", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 200);
    e.move(-50, 400, 200); // finger crosses back past its own start point
    assert.equal(e.fraction, 0);
    for (const frame of e.frames) assert.ok(frame.fraction >= 0);
  });
});

describe("what the component subscribes to", () => {
  it("reports every frame without an outcome until release", () => {
    const e = edge();
    e.down(5);
    e.move(105, 400, 200);
    e.move(150, 400, 200);
    e.move(190, 400, 200);
    assert.ok(e.frames.length >= 3);
    assert.deepEqual(e.outcomes, []);
    assert.ok(e.frames.every((frame) => frame.dragging));
    e.up(190, 400, 200);
    assert.equal(e.outcomes.length, 1);
    assert.equal(e.frames[e.frames.length - 1].dragging, false);
  });

  it("never reports an outcome for a tap that never clears the direction lock", () => {
    const e = edge();
    e.down(5);
    e.up(5);
    assert.deepEqual(e.outcomes, []);
    assert.equal(e.frames.length, 0);
  });

  it("keeps the settle duration in one place for both the CSS transition and the navigate delay", () => {
    assert.equal(EDGE_BACK_SETTLE_MS, 200);
  });
});

describe("cancel() — the wiring's external abort", () => {
  it("rewinds a mid-flight drag to rest without settling an outcome", () => {
    const e = edge();
    e.down(5);
    e.move(155, 400, 200);
    assert.equal(e.dragging, true);
    e.controller.cancel();
    assert.equal(e.fraction, 0, "a re-enable painting getState() must find the page at rest");
    assert.equal(e.dragging, false);
    assert.deepEqual(e.outcomes, [], "an aborted gesture must never navigate");
  });

  it("frees the pointer so the next gesture starts clean", () => {
    const e = edge();
    e.down(5);
    e.move(155, 400, 200);
    e.controller.cancel();
    assert.equal(e.down(10), true, "a fresh pointer should be accepted after the abort");
    e.move(180, 400, 200);
    e.up(180);
    assert.deepEqual(e.outcomes, ["back"]);
  });

  it("is a no-op at rest", () => {
    const e = edge();
    e.controller.cancel();
    assert.equal(e.fraction, 0);
    assert.deepEqual(e.frames, [], "no frame may reach subscribers a cleanup is dropping");
  });
});
