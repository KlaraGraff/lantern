import type { InteractionKind } from "./reader-interaction.ts";

export const DEFAULT_PREVIOUS_PAGE_BINDING = "key:ArrowLeft";
export const DEFAULT_NEXT_PAGE_BINDING = "key:ArrowRight";
export const READER_BINDINGS_SETTING_KEY = "reader_bindings";

export type BuiltInReaderActionId = "lookup" | "speak" | "translate" | "collect" | "highlight" | "copy" | "ask_ai" | "explain";
export type ReaderActionId = BuiltInReaderActionId | `custom_${string}`;

/**
 * How the selection menu names its rows.
 *
 * Deliberately not the same names as `ReaderActionId`: the menu names a row by
 * the place it occupies — "primary" is whatever the top row does for this kind
 * of selection — while a binding names what it runs. Both vocabularies are
 * real, so they get a translation rather than one being bent into the other.
 */
export type ReaderMenuAction =
  | "primary" | "speak" | "ask-ai" | "save" | "highlight" | "translate" | "copy"
  | `custom_${string}`;
export interface ReaderActionBinding { actionId: ReaderActionId; trigger: string }
export interface ReaderBindingsConfig { version: 1; bindings: ReaderActionBinding[] }

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
const RESERVED_BINDINGS = new Set([
  "key:Meta+C", "key:Meta+V", "key:Meta+X", "key:Meta+A", "key:Meta+W", "key:Meta+Q",
  "key:Control+C", "key:Control+V", "key:Control+X", "key:Control+A",
]);

function normalizedKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function bindingFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const modifiers = [
    event.metaKey ? "Meta" : null,
    event.ctrlKey ? "Control" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter(Boolean);
  return `key:${[...modifiers, normalizedKey(event.key)].join("+")}`;
}

export function bindingFromMouseEvent(event: MouseEvent): string | null {
  if (event.button === 0) return null;
  return `mouse:${event.button}`;
}

export function keyboardEventMatchesBinding(event: KeyboardEvent, binding: string): boolean {
  return bindingFromKeyboardEvent(event) === binding;
}

export function mouseEventMatchesBinding(event: MouseEvent, binding: string): boolean {
  return bindingFromMouseEvent(event) === binding;
}

export function isReservedReaderBinding(binding: string) {
  return RESERVED_BINDINGS.has(binding);
}

export function formatReaderBinding(binding: string, locale = "en"): string {
  if (binding === "mouse:double") return locale.startsWith("zh") ? "双击" : "Double click";
  if (binding === "mouse:triple") return locale.startsWith("zh") ? "三击" : "Triple click";
  if (binding.startsWith("mouse:")) {
    const button = Number(binding.slice("mouse:".length));
    const labels: Record<number, string> = locale.startsWith("zh")
      ? { 1: "鼠标中键", 2: "鼠标右键", 3: "鼠标后退键", 4: "鼠标前进键" }
      : { 1: "Middle click", 2: "Right click", 3: "Mouse back", 4: "Mouse forward" };
    return labels[button] ?? (locale.startsWith("zh") ? `鼠标键 ${button + 1}` : `Mouse ${button + 1}`);
  }
  const value = binding.startsWith("key:") ? binding.slice("key:".length) : binding;
  return value
    .replace(/Meta/g, "Cmd")
    .replace(/Control/g, "Ctrl")
    .replace(/Alt/g, locale.startsWith("zh") ? "Option" : "Alt")
    .replace(/ArrowLeft/g, "Left")
    .replace(/ArrowRight/g, "Right")
    .replace(/ArrowUp/g, "Up")
    .replace(/ArrowDown/g, "Down")
    .replace(/Space/g, locale.startsWith("zh") ? "空格" : "Space");
}

export const formatPageTurnBinding = formatReaderBinding;

export function parseReaderBindings(value: unknown): ReaderBindingsConfig {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { source = null; }
  }
  const record = source && typeof source === "object" ? source as Partial<ReaderBindingsConfig> : {};
  const seenActions = new Set<string>();
  const seenTriggers = new Set<string>();
  const bindings = Array.isArray(record.bindings) ? record.bindings.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const actionId = (item as ReaderActionBinding).actionId;
    const trigger = (item as ReaderActionBinding).trigger;
    if (typeof actionId !== "string" || typeof trigger !== "string"
      || (!trigger.startsWith("key:") && trigger !== "mouse:double" && trigger !== "mouse:triple")
      || seenActions.has(actionId) || seenTriggers.has(trigger)) return [];
    seenActions.add(actionId);
    seenTriggers.add(trigger);
    return [{ actionId, trigger } as ReaderActionBinding];
  }) : [];
  return { version: 1, bindings };
}

/**
 * The actions a menu row could be running, best match first.
 *
 * Only "primary" has more than one. It is the top row, and what it says there
 * depends on the selection — 查词 on a word, 解读 on a passage — but both run
 * the same card, so a binding on either one is that row's shortcut. Order puts
 * the reading that matches this selection first, so binding both separately
 * still prints the right one.
 */
export function bindingActionsForMenuAction(
  action: ReaderMenuAction,
  kind: InteractionKind,
): ReaderActionId[] {
  switch (action) {
    case "primary": return kind === "passage" ? ["explain", "lookup"] : ["lookup", "explain"];
    case "ask-ai": return ["ask_ai"];
    case "save": return ["collect"];
    case "speak": return ["speak"];
    case "highlight": return ["highlight"];
    case "translate": return ["translate"];
    case "copy": return ["copy"];
    default: return action.startsWith("custom_") ? [action] : [];
  }
}

/**
 * What to print at the right edge of a menu row, or nothing.
 *
 * Keyboard triggers only. A gesture binding is just as real, but printing
 * "三击" beside a row of a menu the reader already has open would be advice
 * they cannot take: the gesture is how you skip the menu, not something you
 * can do from inside it.
 */
export function menuShortcut(
  bindings: ReaderActionBinding[],
  action: ReaderMenuAction,
  kind: InteractionKind,
  locale = "en",
): string | null {
  for (const actionId of bindingActionsForMenuAction(action, kind)) {
    const binding = bindings.find(
      (item) => item.actionId === actionId && item.trigger.startsWith("key:"),
    );
    if (binding) return formatReaderBinding(binding.trigger, locale);
  }
  return null;
}
