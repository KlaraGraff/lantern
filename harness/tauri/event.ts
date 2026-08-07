/**
 * Mock of `@tauri-apps/api/event` — a real in-page event bus, not a no-op.
 *
 * AI streaming, settings-changed broadcasts, reader navigation acks and the
 * font-changed fan-out all depend on `emit` actually reaching `listen`. A
 * stubbed-out event API would make half the app look like it works while
 * silently swallowing every message, which is exactly the failure mode this
 * harness exists to avoid.
 *
 * `emitTo(label, ...)` delivers to listeners registered on that label's window
 * *and* to the current window when the label matches it — the single-window
 * harness treats every label as reachable, since `WebviewWindow` never really
 * opens one.
 */
export type UnlistenFn = () => void;

export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

export interface Options {
  target?: string | { kind: string; label?: string };
}

interface Registration {
  id: number;
  event: string;
  /** `null` = listening on every target. */
  target: string | null;
  handler: EventCallback<unknown>;
  once: boolean;
}

const registrations = new Set<Registration>();
let nextId = 1;

function targetLabel(options?: Options): string | null {
  const target = options?.target;
  if (!target) return null;
  if (typeof target === "string") return target;
  return target.label ?? null;
}

export function register<T>(
  event: string,
  handler: EventCallback<T>,
  target: string | null,
  once: boolean,
): Promise<UnlistenFn> {
  const registration: Registration = {
    id: nextId++,
    event,
    target,
    handler: handler as EventCallback<unknown>,
    once,
  };
  registrations.add(registration);
  return Promise.resolve(() => {
    registrations.delete(registration);
  });
}

export function listen<T>(
  event: string,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  return register(event, handler, targetLabel(options), false);
}

export function once<T>(
  event: string,
  handler: EventCallback<T>,
  options?: Options,
): Promise<UnlistenFn> {
  return register(event, handler, targetLabel(options), true);
}

function deliver(event: string, payload: unknown, target: string | null): void {
  for (const registration of [...registrations]) {
    if (registration.event !== event) continue;
    // A listener bound to a label only hears events aimed at that label or at
    // everyone; an unbound listener hears everything.
    if (registration.target !== null && target !== null && registration.target !== target) continue;
    if (registration.once) registrations.delete(registration);
    try {
      registration.handler({ event, id: registration.id, payload });
    } catch (error) {
      // Rethrow asynchronously: a throwing listener is an app bug the sweep's
      // window.onerror collector must see, but it must not break the fan-out.
      setTimeout(() => {
        throw error;
      }, 0);
    }
  }
}

export function emit(event: string, payload?: unknown): Promise<void> {
  deliver(event, payload, null);
  return Promise.resolve();
}

export function emitTo(
  target: string | { kind: string; label?: string },
  event: string,
  payload?: unknown,
): Promise<void> {
  const label = typeof target === "string" ? target : (target.label ?? null);
  deliver(event, payload, label);
  return Promise.resolve();
}

export const TauriEvent = {
  WINDOW_RESIZED: "tauri://resize",
  WINDOW_MOVED: "tauri://move",
  WINDOW_CLOSE_REQUESTED: "tauri://close-requested",
  WINDOW_DESTROYED: "tauri://destroyed",
  WINDOW_FOCUS: "tauri://focus",
  WINDOW_BLUR: "tauri://blur",
  WINDOW_SCALE_FACTOR_CHANGED: "tauri://scale-change",
  WINDOW_THEME_CHANGED: "tauri://theme-changed",
  DRAG_ENTER: "tauri://drag-enter",
  DRAG_OVER: "tauri://drag-over",
  DRAG_DROP: "tauri://drag-drop",
  DRAG_LEAVE: "tauri://drag-leave",
} as const;

/** Exposed for the sweep runner and for poking at streaming by hand. */
export function harnessListenerCount(): number {
  return registrations.size;
}
