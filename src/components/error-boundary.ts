/**
 * Decision logic for the React error boundaries — kept out of the class
 * component so it can be tested without a renderer.
 *
 * The boundaries exist because one component dereferencing a field an IPC
 * payload did not carry used to empty `#root` and take the window with it.
 * There is no single "error screen": what a caught error should look like, and
 * what the user can usefully do about it, depends entirely on how much of the
 * app the boundary was standing in front of.
 */

/** How much of the app sits inside the boundary. */
export type BoundaryScope =
  /** The whole window. Nothing below it survived. */
  | "app"
  /** One route. The window shell and its overlays are still alive. */
  | "page"
  /** One panel inside a live surface — a settings section, say. */
  | "region"
  /** A passive notice. Its failure should remove it, not announce itself. */
  | "silent";

export type BoundaryAction = "retry" | "home" | "reload" | "dismiss" | "copy";

export interface BoundaryContext {
  scope: BoundaryScope;
  /** Remounts the user has already asked for at this reset key. */
  attempts: number;
  /** Only the window that owns the library can offer "back to library". */
  isMainWindow: boolean;
  /** Already on the route "back to library" would navigate to. */
  atHome: boolean;
  /** The host supplied an escape hatch (close the modal, dismiss the panel). */
  canDismiss: boolean;
}

export interface BoundaryPlan {
  /** `false` means render nothing at all — the silent scope. */
  visible: boolean;
  /** Full-window takeover vs. an inset card inside surviving chrome. */
  layout: "fullscreen" | "inset";
  titleKey: string;
  bodyKey: string;
  /**
   * True once a remount has been tried and the subtree threw again. Retry is
   * dropped from the actions and the body says so — an identical re-render
   * against identical data fails identically, and a button that cannot work
   * is worse than no button.
   */
  retryExhausted: boolean;
  actions: BoundaryAction[];
}

const TITLE_KEYS: Record<BoundaryScope, string> = {
  app: "errorBoundary.app.title",
  page: "errorBoundary.page.title",
  region: "errorBoundary.region.title",
  silent: "",
};

const BODY_KEYS: Record<BoundaryScope, string> = {
  app: "errorBoundary.app.body",
  page: "errorBoundary.page.body",
  region: "errorBoundary.region.body",
  silent: "",
};

/**
 * What to show, and which controls to offer.
 *
 * Retry is deliberately absent at `app` scope: an error that reached the root
 * escaped every inner boundary, so it came from the shell itself — the router,
 * the providers, `App`'s own effects. Remounting that shell re-runs the same
 * code against the same module state. Reloading the window is the only action
 * that actually changes the inputs, so it is the only one offered.
 */
export function planBoundaryFallback(context: BoundaryContext): BoundaryPlan {
  const { scope, attempts, isMainWindow, atHome, canDismiss } = context;

  if (scope === "silent") {
    return {
      visible: false,
      layout: "inset",
      titleKey: "",
      bodyKey: "",
      retryExhausted: false,
      actions: [],
    };
  }

  const retryExhausted = attempts > 0;
  const canRetry = scope !== "app" && !retryExhausted;
  const actions: BoundaryAction[] = [];

  if (canRetry) actions.push("retry");

  if (scope === "page") {
    // A reader window has no library to go back to, and neither does a page
    // that is already the library. Both fall through to a reload.
    if (isMainWindow && !atHome) actions.push("home");
    else actions.push("reload");
  } else if (scope === "region") {
    if (canDismiss) actions.push("dismiss");
  } else {
    actions.push("reload", "copy");
  }

  return {
    visible: true,
    layout: scope === "region" ? "inset" : "fullscreen",
    titleKey: TITLE_KEYS[scope],
    bodyKey: retryExhausted ? "errorBoundary.retryFailed" : BODY_KEYS[scope],
    retryExhausted,
    actions,
  };
}

const DETAIL_LIMIT = 2_000;

/** Message and stack, pulled off whatever was actually thrown. */
export function describeBoundaryError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: error.stack && error.stack.trim() ? error.stack : null,
    };
  }
  if (typeof error === "string") return { message: error, stack: null };
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: null };
  } catch {
    return { message: String(error), stack: null };
  }
}

/**
 * The text behind the "technical details" disclosure — never the headline.
 * React's component stack is appended when it exists, because "which component"
 * is the one thing a JS stack of minified frames usually cannot say.
 */
export function boundaryDetailText(error: unknown, componentStack?: string | null): string | null {
  const { message, stack } = describeBoundaryError(error);
  const parts: string[] = [stack ?? message];
  if (componentStack && componentStack.trim()) parts.push(componentStack.trim());
  const text = parts.join("\n").trim();
  if (!text) return null;
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…[truncated]` : text;
}

export interface BoundaryState {
  error: unknown;
  detail: string | null;
  attempts: number;
  /** The reset key the current state belongs to. */
  resetKey: unknown;
}

export const initialBoundaryState: BoundaryState = {
  error: null,
  detail: null,
  attempts: 0,
  resetKey: undefined,
};

/**
 * Fold a new reset key into the state. A changed key means the host swapped in
 * different content — a different route, a different settings section — so the
 * failure on record no longer describes what is being rendered, and the retry
 * budget starts over.
 */
export function reconcileBoundaryState(state: BoundaryState, resetKey: unknown): BoundaryState {
  if (Object.is(state.resetKey, resetKey)) return state;
  return { ...initialBoundaryState, resetKey };
}

/**
 * The state a manual retry produces: forget the error, remount (the caller uses
 * `attempts` as a React `key`), and remember that a remount was spent. If the
 * subtree throws again the next catch lands with `attempts > 0`, which is what
 * `planBoundaryFallback` reads as "retry did not help".
 */
export function retriedBoundaryState(state: BoundaryState): BoundaryState {
  return { ...state, error: null, detail: null, attempts: state.attempts + 1 };
}
