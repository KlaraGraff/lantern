/**
 * Things other surfaces ask the library page to do, in this window.
 *
 * The page owns its section, its import flow and its word-list search; the
 * command palette and the rail only say what they want. A DOM event rather
 * than a context because the palette is mounted above the router and the
 * library page below it — same reasoning as `settings-open.ts`.
 */
/** The shelf's own filters — everything the rail's 书库 workspace owns. */
export const isShelfFilter = (filter: string) =>
  filter === "all" || filter === "reading" || filter === "finished" || filter.startsWith("collection:");

/** Which rail workspace a filter belongs to; the key for the switch animation. */
export const workspaceOf = (filter: string) => (isShelfFilter(filter) ? "all" : filter);

export type LibraryAction =
  | { type: "filter"; filter: string }
  | { type: "word"; word: string }
  | { type: "import" }
  | { type: "review" };

export const LIBRARY_ACTION_EVENT = "lantern:library-action";

export function requestLibraryAction(action: LibraryAction) {
  window.dispatchEvent(new CustomEvent<LibraryAction>(LIBRARY_ACTION_EVENT, { detail: action }));
}

export function listenForLibraryActions(handler: (action: LibraryAction) => void): () => void {
  const onEvent = (event: Event) => handler((event as CustomEvent<LibraryAction>).detail);
  window.addEventListener(LIBRARY_ACTION_EVENT, onEvent);
  return () => window.removeEventListener(LIBRARY_ACTION_EVENT, onEvent);
}

export const OPEN_PALETTE_EVENT = "lantern:open-palette";

export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
}
