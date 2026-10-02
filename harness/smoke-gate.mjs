// Unlike report.ok (errors.length === 0), handled backend errors and warnings
// remain diagnostic. A caught render still broke UI and must fail the build.
const FAILING_KINDS = new Set([
  "error", "unhandledrejection", "click-threw", "resource", "render-boundary",
]);

export function gate(report) {
  const failures = report.errors.filter((error) => FAILING_KINDS.has(error.kind) || error.fatal);
  const warnings = report.errors.filter((error) => !failures.includes(error));
  return { failures, warnings };
}
