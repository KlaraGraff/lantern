/**
 * Shared harness bookkeeping. Imported by the Tauri mocks and by the sweep
 * runner; deliberately dependency-free so it can be loaded first.
 *
 * Everything lands on `window.__HARNESS__` so the sweep runner (and a human in
 * the devtools console) can read it without importing anything.
 */

export interface HarnessInvokeRecord {
  command: string;
  args: unknown;
  at: number;
}

export interface HarnessState {
  /** Commands answered by the default stub rather than a hand-written fixture. */
  unstubbed: Set<string>;
  /** Commands a fixture deliberately rejected (never counted as an app bug). */
  rejected: Set<string>;
  /** Every invoke, newest last. Capped so a long sweep can't eat memory. */
  calls: HarnessInvokeRecord[];
  /** `new WebviewWindow(...)` requests, recorded instead of performed. */
  windowsOpened: Array<{ label: string; url?: string }>;
  /** Native surfaces the mocks short-circuited (dialogs, openers, relaunch). */
  nativeCalls: string[];
  /**
   * Commands the default stub answered since the sweep last cleared this.
   * The sweep attaches it to any error it records, so a crash caused by a
   * shape-guessed `{}` is legible as a harness gap rather than an app bug.
   */
  stubsSinceMark: string[];
}

const MAX_CALLS = 4000;

function create(): HarnessState {
  return {
    unstubbed: new Set<string>(),
    rejected: new Set<string>(),
    calls: [],
    windowsOpened: [],
    nativeCalls: [],
    stubsSinceMark: [],
  };
}

declare global {
  interface Window {
    __HARNESS__?: HarnessState;
  }
}

export const harness: HarnessState = (() => {
  const existing = typeof window !== "undefined" ? window.__HARNESS__ : undefined;
  if (existing) return existing;
  const fresh = create();
  if (typeof window !== "undefined") window.__HARNESS__ = fresh;
  return fresh;
})();

export function recordCall(command: string, args: unknown): void {
  harness.calls.push({ command, args, at: Date.now() });
  if (harness.calls.length > MAX_CALLS) harness.calls.splice(0, harness.calls.length - MAX_CALLS);
}

export function recordNative(what: string): void {
  harness.nativeCalls.push(what);
}
