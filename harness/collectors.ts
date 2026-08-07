/**
 * Global fault collectors. Installed by `harness/entry.ts` before `main.tsx`
 * runs, which is the whole reason the entry is injected ahead of it: an error
 * thrown at module top-level or during the first render happens before any
 * listener the sweep could add later.
 *
 * Four sources:
 *  - `error` events (capture phase, so nothing can stop them first). React 19
 *    routes uncaught render errors through `reportError()`, which lands here —
 *    the app has no error boundary of its own, so this is the only React signal
 *    there is, and that fact is recorded in the report as `errorBoundary: null`.
 *  - `unhandledrejection`.
 *  - `console.error` / `console.warn` wrappers.
 *  - resource load failures (a 404 on a chunk or a font), which arrive as
 *    `error` events with a non-window target.
 *
 * `addEventListener` rather than assigning `window.onerror`, because the app's
 * own `installReaderDiagnostics()` installs handlers too and last-writer-wins
 * would silently disable one of us.
 */

export type FaultKind =
  | "error"
  | "unhandledrejection"
  | "console.error"
  | "console.warn"
  | "resource";

export interface Fault {
  kind: FaultKind;
  message: string;
  stack: string | null;
  /** Filled in by the sweep: the route that was on screen. */
  route: string | null;
  /** Filled in by the sweep: a description of the element acted on. */
  action: string | null;
  /**
   * Commands that were answered by the shape-guessed default stub while this
   * fault happened. Non-empty means "suspect the harness before the app" — a
   * `{}` where the real backend returns a populated struct is a harness gap,
   * not a bug in the component that dereferenced it.
   */
  stubsInFlight: string[];
  at: number;
}

const faults: Fault[] = [];
let installed = false;

/**
 * The sweep sets these so a fault can be attributed to what caused it.
 * `probeStubs` is installed by the sweep; collectors stay dependency-free.
 */
export const context: {
  route: string | null;
  action: string | null;
  probeStubs: (() => string[]) | null;
} = {
  route: null,
  action: null,
  probeStubs: null,
};

/**
 * Noise the harness produces itself, or that is a known consequence of running
 * without a Rust backend. Kept deliberately short and specific — a broad filter
 * here would hide the bugs this exists to find.
 */
const IGNORED = [
  /^\[harness\]/,
  // React's own dev-mode notices about the harness router/StrictMode, not app bugs.
  /Download the React DevTools/i,
];

function isIgnored(message: string): boolean {
  return IGNORED.some((pattern) => pattern.test(message));
}

function stringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stackOf(value: unknown): string | null {
  if (value instanceof Error && value.stack) return value.stack;
  return null;
}

export function record(kind: FaultKind, message: string, stack: string | null): void {
  if (isIgnored(message)) return;
  faults.push({
    kind,
    message: message.length > 2000 ? `${message.slice(0, 2000)}…` : message,
    stack,
    route: context.route,
    action: context.action,
    stubsInFlight: context.probeStubs ? context.probeStubs() : [],
    at: Date.now(),
  });
}

export function getFaults(): Fault[] {
  return faults;
}

export function faultCount(): number {
  return faults.length;
}

export function installCollectors(): void {
  if (installed) return;
  installed = true;

  window.addEventListener(
    "error",
    (event) => {
      const target = event.target;
      if (target && target !== window && (target as HTMLElement).tagName) {
        const element = target as HTMLElement & { src?: string; href?: string };
        record(
          "resource",
          `failed to load ${element.tagName.toLowerCase()}: ${element.src ?? element.href ?? "?"}`,
          null,
        );
        return;
      }
      record(
        "error",
        event.message || stringify(event.error),
        stackOf(event.error) ?? `${event.filename ?? "?"}:${event.lineno}:${event.colno}`,
      );
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    record("unhandledrejection", stringify(event.reason), stackOf(event.reason));
  });

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const message = args.map(stringify).join(" ");
      const stack = args.map(stackOf).find(Boolean) ?? null;
      record(`console.${level}` as FaultKind, message, stack);
      original(...args);
    };
  }
}
