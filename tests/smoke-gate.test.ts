import assert from "node:assert/strict";
import test from "node:test";
import { collectBoundaryDiagnostic, getFaults, record } from "../harness/collectors.ts";
// @ts-expect-error — plain .mjs driver helper, no type declarations
import { gate } from "../harness/smoke-gate.mjs";

test("a caught region render crash fails the smoke gate while the root survives", () => {
  const before = getFaults().length;
  collectBoundaryDiagnostic("log_webview_warning", {
    scope: "reader.diag",
    message: "ui.boundary.region | TypeError: missing profile label",
  });
  const errors = getFaults().slice(before).map((fault) => ({ ...fault, fatal: false }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "render-boundary");
  assert.equal(gate({ errors }).failures.length, 1);
});

test("each app boundary scope is gated, including silent fallbacks", () => {
  const before = getFaults().length;
  for (const scope of ["app", "page", "region", "silent"]) {
    collectBoundaryDiagnostic("log_webview_warning", {
      scope: "reader.diag", message: `ui.boundary.${scope} | render failed`,
    });
  }
  assert.equal(gate({ errors: getFaults().slice(before) }).failures.length, 4);
});

test("warnings and handled deliberate backend rejections remain non-failing", () => {
  const before = getFaults().length;
  record("console.warn", "ordinary warning", null);
  record("console.error", "Failed to test profile: harness: no AI backend", null);
  collectBoundaryDiagnostic("log_webview_warning", {
    scope: "reader.diag", message: "reader.open | handled failure",
  });
  collectBoundaryDiagnostic("another_command", {
    scope: "reader.diag", message: "ui.boundary.region | unrelated payload",
  });
  const result = gate({ errors: getFaults().slice(before) });
  assert.equal(result.failures.length, 0);
  assert.equal(result.warnings.length, 2);
});

test("uncaught faults and fatal renders still fail the gate", () => {
  const errors = ["error", "unhandledrejection", "click-threw", "resource"].map((kind) => ({ kind, fatal: false }));
  errors.push({ kind: "console.error", fatal: true });
  assert.equal(gate({ errors }).failures.length, 5);
});

test("foreground reader proof fails the gate even if empty chrome throws no error", () => {
  const result = gate({ errors: [], mode: "reader-visible", readerRendered: false });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].kind, "reader-not-rendered");
  assert.equal(gate({ errors: [], mode: "reader-visible", readerRendered: true }).failures.length, 0);
});
