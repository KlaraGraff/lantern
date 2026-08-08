/**
 * The one focus trap, shared by every modal layer in the app.
 *
 * There used to be nine copies of this — `SettingsModal`, `BottomSheet`,
 * `McpApprovalDialog`, `ConfirmDialog`, `OnboardingCard`, `DictionaryContent`,
 * `LearningCardController`, `DensityHelpDialog`, `ReaderExportDialog` — and they
 * had drifted into five different ideas of what counts as focusable. Nothing
 * covered any of them, because the interesting part (which element Tab lands on
 * at the edges of the ring) was buried inside a DOM event handler.
 *
 * So the wrap decision lives in `resolveTabFocus`, which is pure and takes a
 * plain array. That is the part with tests. Everything below it is a thin
 * shell over `querySelectorAll` and `.focus()`.
 */

export const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Focusable descendants of `container`, in tab order.
 *
 * The `getClientRects()` check is the part the selector alone cannot express:
 * a settings panel for an inactive tab is still in the DOM, and without this
 * Tab walks into controls the user cannot see. `SettingsModal` was the only one
 * of the nine that had figured this out; it applies just as well everywhere
 * else, where there is simply nothing hidden for it to filter.
 */
export function getFocusableElements(container: HTMLElement | null | undefined): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.getClientRects().length > 0,
  );
}

/** What the caller should do with a Tab keypress. */
export type TabFocusAction<T> =
  /** Let the browser move focus normally. */
  | { kind: "pass" }
  /** Swallow the event and focus this element. */
  | { kind: "focus"; target: T }
  /** Swallow the event and park focus on the container itself. */
  | { kind: "park" };

export interface ResolveTabFocusOptions {
  /**
   * Whether focus is currently inside the trapped container. Pass
   * `container.contains(document.activeElement)` to have Tab pull focus back in
   * when it has escaped; leave it at the default `true` to only wrap at the
   * ends of the ring, which is what most of the dialogs do.
   */
  focusInside?: boolean;
  /**
   * When the container has nothing focusable, park focus on the container
   * rather than letting Tab leave. Only `SettingsModal` wants this — its modal
   * has `tabIndex={-1}` for exactly this purpose, and it can legitimately be
   * showing a panel with no controls.
   */
  parkWhenEmpty?: boolean;
}

/**
 * The wrap decision, with no DOM in it.
 *
 * `elements` is the ring in tab order, `active` is whatever currently holds
 * focus (or `null`). Generic over the element type so the tests can drive it
 * with plain strings — this file has to run under `node --test`, which has no
 * DOM.
 */
export function resolveTabFocus<T>(
  elements: readonly T[],
  active: T | null,
  shiftKey: boolean,
  options: ResolveTabFocusOptions = {},
): TabFocusAction<T> {
  const { focusInside = true, parkWhenEmpty = false } = options;

  if (elements.length === 0) return parkWhenEmpty ? { kind: "park" } : { kind: "pass" };

  // Focus escaped the container (a click on the scrim, a closed popover, an
  // element that unmounted under it). Tab pulls it back to the near end.
  if (!focusInside) {
    return { kind: "focus", target: shiftKey ? elements[elements.length - 1] : elements[0] };
  }

  if (shiftKey && active === elements[0]) {
    return { kind: "focus", target: elements[elements.length - 1] };
  }
  if (!shiftKey && active === elements[elements.length - 1]) {
    return { kind: "focus", target: elements[0] };
  }
  return { kind: "pass" };
}

export interface TrapTabKeyOptions extends ResolveTabFocusOptions {
  /**
   * Override the ring. `ReaderExportDialog` prepends its `tabIndex={-1}`
   * heading so Shift+Tab off the first button lands on the title rather than
   * escaping the dialog.
   */
  elements?: HTMLElement[];
  /**
   * Also stop the event from reaching ancestor handlers. `ConfirmDialog` needs
   * it: it can open on top of a settings section that runs its own Tab logic.
   */
  stopPropagation?: boolean;
  /**
   * Pull focus back in when it has escaped the container. Computes
   * `focusInside` for you from the live `document.activeElement`.
   */
  recoverOutsideFocus?: boolean;
}

/**
 * Just enough of a keydown to run the trap. Structural rather than
 * `KeyboardEvent`, because `ReaderExportDialog` traps from a React synthetic
 * event and the two types are not assignable to one another.
 */
export interface TrapKeyEvent {
  shiftKey: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

/**
 * Apply the trap to a Tab keydown. Callers check `event.key === "Tab"` first —
 * their handlers deal with Escape and other keys ahead of this, and each one
 * dismisses differently.
 */
export function trapTabKey(
  event: TrapKeyEvent,
  container: HTMLElement | null | undefined,
  options: TrapTabKeyOptions = {},
): void {
  if (!container) return;
  const { elements, stopPropagation, recoverOutsideFocus, ...resolveOptions } = options;
  if (stopPropagation) event.stopPropagation();

  const ring = elements ?? getFocusableElements(container);
  const focusInside = recoverOutsideFocus ? container.contains(document.activeElement) : true;
  const action = resolveTabFocus(ring, document.activeElement as HTMLElement | null, event.shiftKey, {
    ...resolveOptions,
    focusInside,
  });

  if (action.kind === "pass") return;
  event.preventDefault();
  if (action.kind === "park") container.focus();
  else action.target.focus();
}

/** Move focus to the first focusable element inside `container`, if there is one. */
export function focusFirstElement(container: HTMLElement | null | undefined): void {
  getFocusableElements(container)[0]?.focus();
}
