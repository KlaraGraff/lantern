import assert from "node:assert/strict";
import test from "node:test";

import {
  boundaryDetailText,
  describeBoundaryError,
  initialBoundaryState,
  planBoundaryFallback,
  reconcileBoundaryState,
  retriedBoundaryState,
  type BoundaryContext,
} from "../src/components/error-boundary.ts";

const context = (overrides: Partial<BoundaryContext> = {}): BoundaryContext => ({
  scope: "region",
  attempts: 0,
  isMainWindow: true,
  atHome: false,
  canDismiss: false,
  ...overrides,
});

test("a silent boundary renders nothing at all", () => {
  const plan = planBoundaryFallback(context({ scope: "silent" }));
  assert.equal(plan.visible, false);
  assert.deepEqual(plan.actions, []);
});

test("the root boundary offers reload, never retry", () => {
  // Anything that reached the root escaped every inner boundary, so it came
  // from the shell — remounting the shell re-runs identical code.
  const plan = planBoundaryFallback(context({ scope: "app" }));
  assert.deepEqual(plan.actions, ["reload", "copy"]);
  assert.equal(plan.layout, "fullscreen");
});

test("a page failure in the main window offers a way back to the library", () => {
  const plan = planBoundaryFallback(context({ scope: "page" }));
  assert.deepEqual(plan.actions, ["retry", "home"]);
});

test("a page failure already at the library falls back to reload", () => {
  const plan = planBoundaryFallback(context({ scope: "page", atHome: true }));
  assert.deepEqual(plan.actions, ["retry", "reload"]);
});

test("a reader window has no library to go back to", () => {
  const plan = planBoundaryFallback(context({ scope: "page", isMainWindow: false }));
  assert.deepEqual(plan.actions, ["retry", "reload"]);
});

test("a region failure is inset and only escapes when the host gave it an exit", () => {
  assert.deepEqual(planBoundaryFallback(context()).actions, ["retry"]);
  const plan = planBoundaryFallback(context({ canDismiss: true }));
  assert.equal(plan.layout, "inset");
  assert.deepEqual(plan.actions, ["retry", "dismiss"]);
});

test("a spent retry removes the retry control and changes what the user is told", () => {
  const fresh = planBoundaryFallback(context({ canDismiss: true }));
  const again = planBoundaryFallback(context({ attempts: 1, canDismiss: true }));
  assert.equal(fresh.retryExhausted, false);
  assert.equal(again.retryExhausted, true);
  assert.deepEqual(again.actions, ["dismiss"]);
  assert.notEqual(again.bodyKey, fresh.bodyKey);
  assert.equal(again.bodyKey, "errorBoundary.retryFailed");
});

test("an exhausted page retry still leaves a way out", () => {
  assert.deepEqual(planBoundaryFallback(context({ scope: "page", attempts: 2 })).actions, ["home"]);
});

test("every visible plan names a title and a body key", () => {
  for (const scope of ["app", "page", "region"] as const) {
    const plan = planBoundaryFallback(context({ scope }));
    assert.ok(plan.titleKey.length > 0, scope);
    assert.ok(plan.bodyKey.length > 0, scope);
  }
});

test("describes Errors, strings and junk without throwing", () => {
  const error = new Error("providers.map is not a function");
  assert.equal(describeBoundaryError(error).message, "providers.map is not a function");
  assert.ok(describeBoundaryError(error).stack);
  assert.deepEqual(describeBoundaryError("plain"), { message: "plain", stack: null });
  assert.equal(describeBoundaryError({ code: 7 }).message, '{"code":7}');
  assert.equal(describeBoundaryError(undefined).message, "undefined");
});

test("an Error with no message still yields something to show", () => {
  const error = new Error("");
  assert.equal(describeBoundaryError(error).message, "Error");
});

test("detail text carries the stack plus React's component stack", () => {
  const error = new Error("boom");
  const detail = boundaryDetailText(error, "\n    in OcrSettings\n    in SettingsModal");
  assert.ok(detail);
  assert.ok(detail.includes("boom"));
  assert.ok(detail.includes("in OcrSettings"));
});

test("detail text falls back to the message when there is no stack", () => {
  assert.equal(boundaryDetailText("just a string"), "just a string");
  assert.equal(boundaryDetailText(""), null);
});

test("detail text is truncated so a runaway stack cannot fill the screen", () => {
  const detail = boundaryDetailText("x".repeat(9_000));
  assert.ok(detail);
  assert.ok(detail.length < 2_100);
  assert.ok(detail.endsWith("[truncated]"));
});

test("an unchanged reset key keeps the recorded failure", () => {
  const failed = { error: new Error("boom"), detail: "boom", attempts: 1, resetKey: "general" };
  assert.equal(reconcileBoundaryState(failed, "general"), failed);
});

test("a changed reset key clears the failure and refunds the retry budget", () => {
  const failed = { error: new Error("boom"), detail: "boom", attempts: 1, resetKey: "general" };
  const next = reconcileBoundaryState(failed, "library");
  assert.equal(next.error, null);
  assert.equal(next.detail, null);
  assert.equal(next.attempts, 0);
  assert.equal(next.resetKey, "library");
});

test("an undefined reset key is stable — the root boundary never self-resets", () => {
  const state = { ...initialBoundaryState, error: new Error("boom") };
  assert.equal(reconcileBoundaryState(state, undefined), state);
});

test("retry clears the error and spends one attempt, which is the remount key", () => {
  const failed = { error: new Error("boom"), detail: "boom", attempts: 0, resetKey: "general" };
  const retried = retriedBoundaryState(failed);
  assert.equal(retried.error, null);
  assert.equal(retried.detail, null);
  assert.equal(retried.attempts, 1);
  assert.equal(retried.resetKey, "general");
  // The bumped count is what `planBoundaryFallback` reads on the next catch.
  assert.equal(planBoundaryFallback(context({ attempts: retried.attempts })).retryExhausted, true);
});
