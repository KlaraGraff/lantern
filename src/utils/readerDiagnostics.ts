import { invoke } from "@tauri-apps/api/core";

// Diagnostics for the "Preparing book…" hang on old WebKit (macOS 12 / Safari
// 15.1). We cannot attach a debugger on the affected machines, so the reader
// records where the open flow stops and which runtime APIs the WebView is
// missing, then lets the user copy or reveal that trail. Everything here must
// stay Safari-15-safe (no Array.prototype.at, Object.hasOwn, structuredClone,
// crypto.randomUUID …) — this module ships in the app-shell bundle that
// `scripts/check-reader-compat.mjs` audits.

const DIAGNOSTIC_EVENT = "lantern-reader-diagnostic";
const TRAIL_LIMIT = 80;
const MESSAGE_LIMIT = 3_500;

interface DiagnosticEntry {
  seq: number;
  atMs: number;
  scope: string;
  message: string;
}

const trail: DiagnosticEntry[] = [];
const context: Record<string, string> = {};
let sequence = 0;
let installed = false;
let bootMs = 0;

function nowMs(): number {
  try {
    return Math.round(performance.now());
  } catch {
    return Date.now();
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack && error.stack.trim() ? error.stack : error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function truncate(value: string): string {
  return value.length > MESSAGE_LIMIT ? `${value.slice(0, MESSAGE_LIMIT)}…[truncated]` : value;
}

/**
 * Record one diagnostic breadcrumb: keep it in the in-memory trail (for the
 * error page's copy/reveal affordances) and forward it to the on-disk app log
 * via the existing warning channel. Never throws.
 */
export function logReaderDiagnostic(scope: string, detail?: unknown): void {
  if (bootMs === 0) bootMs = nowMs();
  const message = truncate(detail === undefined ? "" : errorMessage(detail));
  const entry: DiagnosticEntry = { seq: ++sequence, atMs: nowMs(), scope, message };
  trail.push(entry);
  if (trail.length > TRAIL_LIMIT) trail.shift();

  if (import.meta.env.DEV) {
    console.info(`Lantern diag [${scope}]`, detail ?? "");
  }
  const line = message ? `${scope} | ${message}` : scope;
  void invoke("log_webview_warning", { scope: "reader.diag", message: line }).catch(() => {});
}

/**
 * Set a live, overwrite-per-key context value (e.g. the current PDF variant or
 * chapter-resolve progress). Unlike a trail entry this is not appended to the
 * on-disk log on every update — it is a snapshot the diagnostic panel/report
 * reads, so a hang that never reaches a milestone still shows how far it got.
 */
export function setDiagnosticContext(key: string, value: string): void {
  context[key] = value;
}

/**
 * Probe the runtime APIs whose absence on Safari 15.1 is the suspected cause of
 * the reader hang. Uses `typeof` property reads only — never calls the API —
 * so it is safe on the very engines it is testing.
 */
export function readerEnvironmentSnapshot(): Record<string, boolean | string> {
  const g = globalThis as unknown as Record<string, unknown>;
  const has = (probe: () => boolean): boolean => {
    try {
      return probe();
    } catch {
      return false;
    }
  };
  return {
    userAgent: has(() => typeof navigator !== "undefined") ? String(navigator.userAgent) : "unknown",
    "Array.prototype.at": has(() => typeof (Array.prototype as { at?: unknown }).at === "function"),
    "Array.prototype.findLast": has(
      () => typeof (Array.prototype as { findLast?: unknown }).findLast === "function",
    ),
    "Object.hasOwn": has(() => typeof (Object as { hasOwn?: unknown }).hasOwn === "function"),
    structuredClone: has(() => typeof (g.structuredClone) === "function"),
    "crypto.randomUUID": has(
      () => typeof (g.crypto as { randomUUID?: unknown } | undefined)?.randomUUID === "function",
    ),
    "Promise.withResolvers": has(
      () => typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers === "function",
    ),
    "Promise.try": has(() => typeof (Promise as unknown as { try?: unknown }).try === "function"),
    "Uint8Array.fromBase64": has(
      () => typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64 === "function",
    ),
    "Set.prototype.intersection": has(
      () => typeof (Set.prototype as { intersection?: unknown }).intersection === "function",
    ),
    DecompressionStream: has(() => typeof (g.DecompressionStream) === "function"),
  };
}

/** Build a copy-pasteable report of the environment snapshot + recent trail. */
export function getReaderDiagnosticReport(): string {
  const lines: string[] = [];
  lines.push(`Lantern reader diagnostics — ${new Date().toISOString()}`);
  const snapshot = readerEnvironmentSnapshot();
  lines.push("");
  lines.push("[environment]");
  for (const key of Object.keys(snapshot)) {
    lines.push(`  ${key}: ${String(snapshot[key])}`);
  }
  const contextKeys = Object.keys(context);
  if (contextKeys.length > 0) {
    lines.push("");
    lines.push("[context]");
    for (const key of contextKeys) lines.push(`  ${key}: ${context[key]}`);
  }
  lines.push("");
  lines.push(`[trail] (${trail.length} of last ${TRAIL_LIMIT})`);
  if (trail.length === 0) {
    lines.push("  (empty)");
  } else {
    for (const entry of trail) {
      const at = `+${(entry.atMs - trail[0].atMs).toString()}ms`;
      lines.push(`  #${entry.seq} ${at} ${entry.scope}${entry.message ? ` | ${entry.message}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** True once a diagnostic has been recorded this session (for UI gating). */
export function hasReaderDiagnostics(): boolean {
  return trail.length > 0;
}

/**
 * Install global fault sinks. Top-level module failures, unhandled rejections
 * and forwarded Worker errors (dispatched by foliate's pdf.js as a
 * `lantern-reader-diagnostic` CustomEvent) otherwise leave no on-disk trace on
 * the affected machines. Idempotent.
 */
export function installReaderDiagnostics(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  bootMs = nowMs();

  window.addEventListener("error", (event: ErrorEvent) => {
    const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : "";
    logReaderDiagnostic("window.error", `${event.message}${where}${event.error ? `\n${errorMessage(event.error)}` : ""}`);
  });

  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    logReaderDiagnostic("window.unhandledrejection", event.reason);
  });

  window.addEventListener(DIAGNOSTIC_EVENT, ((event: Event) => {
    const detail = (event as CustomEvent).detail as { scope?: string; message?: string } | undefined;
    if (!detail) return;
    logReaderDiagnostic(detail.scope || "worker.error", detail.message);
  }) as EventListener);
}
