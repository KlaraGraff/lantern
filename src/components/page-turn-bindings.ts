export const DEFAULT_PREVIOUS_PAGE_BINDING = "key:ArrowLeft";
export const DEFAULT_NEXT_PAGE_BINDING = "key:ArrowRight";

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

function normalizedKey(key: string): string {
  return key === " " ? "Space" : key;
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
  // Primary click remains reserved for text selection and reader controls.
  if (event.button === 0) return null;
  return `mouse:${event.button}`;
}

export function keyboardEventMatchesBinding(event: KeyboardEvent, binding: string): boolean {
  return bindingFromKeyboardEvent(event) === binding;
}

export function mouseEventMatchesBinding(event: MouseEvent, binding: string): boolean {
  return bindingFromMouseEvent(event) === binding;
}

export function formatPageTurnBinding(binding: string, locale = "en"): string {
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
    .replace(/Shift/g, "Shift")
    .replace(/ArrowLeft/g, "Left")
    .replace(/ArrowRight/g, "Right")
    .replace(/ArrowUp/g, "Up")
    .replace(/ArrowDown/g, "Down")
    .replace(/Space/g, locale.startsWith("zh") ? "空格" : "Space");
}
