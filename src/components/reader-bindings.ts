import type { InteractionKind } from "./reader-interaction.ts";

export const DEFAULT_PREVIOUS_PAGE_BINDING = "key:ArrowLeft";
export const DEFAULT_NEXT_PAGE_BINDING = "key:ArrowRight";
export const READER_BINDINGS_SETTING_KEY = "reader_bindings";
export const SHOW_MENU_SHORTCUTS_SETTING_KEY = "show_menu_shortcuts";

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

/**
 * Whether to print ⌘⇧S rather than Ctrl+Shift+S.
 *
 * Split out so it can be forced in a test, where there is no `navigator` with a
 * platform to read. `navigator.platform` is deprecated but it is the only thing
 * a webview reliably answers, and being wrong here costs a wrong glyph, not a
 * wrong binding.
 */
export function isApplePlatform(): boolean {
  const platform = typeof navigator === "undefined" ? "" : (navigator.platform ?? "");
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

// ⌃⌥⇧⌘ is the order macOS prints them in, and Ctrl+Alt+Shift the order
// everywhere else. Not the order `bindingFromKeyboardEvent` records them in,
// which only has to be stable.
const MODIFIER_SYMBOLS: Record<string, { apple: string; other: string }> = {
  Control: { apple: "⌃", other: "Ctrl" },
  Alt: { apple: "⌥", other: "Alt" },
  Shift: { apple: "⇧", other: "Shift" },
  Meta: { apple: "⌘", other: "Win" },
};
const APPLE_MODIFIER_ORDER = ["Control", "Alt", "Shift", "Meta"];
const OTHER_MODIFIER_ORDER = ["Meta", "Control", "Alt", "Shift"];

// Arrows read the same on every keyboard. The rest are Apple's glyphs, so
// elsewhere they stay words — ⎋ on a PC keyboard is a symbol nobody was taught.
const UNIVERSAL_KEY_SYMBOLS: Record<string, string> = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
};
const APPLE_KEY_SYMBOLS: Record<string, string> = {
  Enter: "↩", Escape: "⎋", Tab: "⇥", Backspace: "⌫", Delete: "⌦",
  PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘",
};

function formatKeyName(key: string, locale: string, apple: boolean): string {
  if (key === "Space") return locale.startsWith("zh") ? "空格" : "Space";
  return UNIVERSAL_KEY_SYMBOLS[key]
    ?? (apple ? APPLE_KEY_SYMBOLS[key] : undefined)
    ?? (key === "Escape" ? "Esc" : key);
}

/**
 * How a trigger is printed anywhere it is shown to a reader.
 *
 * One rendering, not one per surface: a binding recorded in settings and the
 * same binding printed in the selection menu have to be recognisable as the same
 * thing, and a reader should not have to translate "Option+空格" into "⌥空格".
 *
 * Gestures stay words. There is no symbol for a triple click, and the places a
 * gesture is shown have room for the phrase.
 */
export function formatReaderBinding(
  binding: string,
  locale = "en",
  apple = isApplePlatform(),
): string {
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
  const parts = value.split("+");
  const key = parts[parts.length - 1];
  const held = new Set(parts.slice(0, -1));
  const order = apple ? APPLE_MODIFIER_ORDER : OTHER_MODIFIER_ORDER;
  const modifiers = order
    .filter((name) => held.has(name))
    .map((name) => MODIFIER_SYMBOLS[name][apple ? "apple" : "other"]);
  const printed = [...modifiers, formatKeyName(key, locale, apple)];
  // Apple runs them together; a "+" between glyphs would be the widest thing on
  // the row, which is the whole reason the glyphs are there.
  return printed.join(apple ? "" : "+");
}

/**
 * What the copy row prints when nothing is bound to it.
 *
 * Copy is the one action the reader never had to bind — the platform gave it
 * one, and `RESERVED_BINDINGS` keeps it from being claimed by anything else.
 */
export function reservedCopyShortcut(locale = "en", apple = isApplePlatform()): string {
  return formatReaderBinding(apple ? "key:Meta+C" : "key:Control+C", locale, apple);
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
  apple = isApplePlatform(),
): string | null {
  for (const actionId of bindingActionsForMenuAction(action, kind)) {
    const binding = bindings.find(
      (item) => item.actionId === actionId && item.trigger.startsWith("key:"),
    );
    if (binding) return formatReaderBinding(binding.trigger, locale, apple);
  }
  return null;
}
