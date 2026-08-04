import type { ReaderMenuAction } from "../../components/reader-bindings";

const readerMenuActionMap: Record<string, ReaderMenuAction> = {
  define: "primary",
  explain: "primary",
  speak: "speak",
  ask_ai: "ask-ai",
  collect: "save",
  highlight: "highlight",
  translate: "translate",
  copy: "copy",
};

/**
 * The stored menu-item id a reader configured, mapped to the row the menu
 * draws. Anything unmapped is a user-defined action, which carries its own
 * `custom_` id all the way through.
 */
export function readerMenuAction(id: string): ReaderMenuAction {
  return readerMenuActionMap[id] ?? id as `custom_${string}`;
}
