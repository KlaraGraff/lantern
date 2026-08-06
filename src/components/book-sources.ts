/**
 * Places to find books, shown in settings and beside the import area.
 *
 * The list ships with defaults but is fully editable: the sites worth keeping
 * are personal, and waiting for a release to add one would make the feature
 * useless to anyone whose favourite site is not here. Built-in entries keep a
 * stable id so "restore defaults" can tell them from anything the user added.
 */

/**
 * `library` sites distribute works that are public domain or licensed for it.
 * `thirdParty` sites host copyrighted books without the rights holder's
 * permission; whether using one is lawful depends on where the reader lives,
 * so they are labelled rather than mixed in.
 */
export type BookSourceKind = "library" | "thirdParty";

export interface BookSource {
  id: string;
  name: string;
  url: string;
  kind: BookSourceKind;
}

export const BOOK_SOURCES_KEY = "book_sources";

export const BUILT_IN_BOOK_SOURCES: readonly BookSource[] = [
  {
    id: "builtin:gutenberg",
    name: "Project Gutenberg",
    url: "https://www.gutenberg.org/",
    kind: "library",
  },
  {
    id: "builtin:standard-ebooks",
    name: "Standard Ebooks",
    url: "https://standardebooks.org/",
    kind: "library",
  },
  {
    id: "builtin:open-library",
    name: "Open Library",
    url: "https://openlibrary.org/",
    kind: "library",
  },
  {
    id: "builtin:internet-archive",
    name: "Internet Archive",
    url: "https://archive.org/details/texts",
    kind: "library",
  },
  {
    id: "builtin:ctext",
    name: "中国哲学书电子化计划",
    url: "https://ctext.org/zhs",
    kind: "library",
  },
  {
    id: "builtin:zlibrary",
    name: "Z-Library",
    url: "https://zh.z-lib.fm/",
    kind: "thirdParty",
  },
  {
    id: "builtin:annas-archive",
    name: "Anna's Archive",
    url: "https://annas-archive.org/",
    kind: "thirdParty",
  },
];

export function isBuiltInBookSource(id: string): boolean {
  return id.startsWith("builtin:");
}

/**
 * Which deletion rule a source falls under. Deleting a built-in is reversible —
 * "restore defaults" hands it back — but `restoreBuiltInBookSources` can only
 * keep user entries that are *still in the list*, so a URL the user typed is
 * gone for good once removed. That difference is the whole reason the confirm
 * dialog exists, and reading it off the id is the only way to get it right.
 */
export function bookSourceDeleteKind(id: string): "builtin" | "custom" {
  return isBuiltInBookSource(id) ? "builtin" : "custom";
}

function isBookSource(value: unknown): value is BookSource {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Partial<BookSource>;
  return (
    typeof source.id === "string"
    && typeof source.name === "string"
    && typeof source.url === "string"
    && (source.kind === "library" || source.kind === "thirdParty")
  );
}

export function parseBookSources(raw: string | undefined): BookSource[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isBookSource) : [];
  } catch {
    return [];
  }
}

export function serializeBookSources(sources: BookSource[]): string {
  return JSON.stringify(sources);
}

/**
 * The list to show for a `book_sources` row that may not exist yet.
 *
 * An absent row means "nobody has told this device anything", and the answer to
 * that is the built-in catalog — computed on read, never written. A row that
 * *does* exist is authoritative even when it is empty: `[]` is a user who
 * deleted every site, and handing the defaults back would undo that. Presence,
 * not contents, is the signal. That is what makes "a site the user deleted does
 * not reappear after the next launch" hold without a separate flag.
 *
 * This replaced a `book_sources_seeded` flag, and the replacement is what makes
 * `book_sources` safe to sync (it is on the whitelist in
 * `src-tauri/src/sync/events.rs`). Under the old scheme the settings pane wrote
 * the built-in list into `book_sources` the first time it mounted on a device
 * that had no flag — and a second device is exactly that device. That seed is a
 * real write to the synced key, stamped with *now*, which is necessarily later
 * than the timestamp on the list the first device curated yesterday. Settings
 * merge last-write-wins on `(updated_at, updated_by_device)`, so the defaults
 * would win, and because the writer publishes every whitelisted key, the fresh
 * device would then go on to overwrite the curated list on the *first* device
 * too. A user's curation destroyed by a machine they just signed in on.
 *
 * Syncing `book_sources_seeded` alongside it — the obvious-looking fix — does
 * not close that. The flag travels in the same sync as the list, so it arrives
 * after the pane has already mounted, already seeded and already won; it can
 * only prevent a *second* seed that was never the problem. Making the seed lose
 * on purpose would work — a write stamped `(0, "")` that emits no event, the
 * sentinel the writer already uses for local-only rows — but that needs a
 * dedicated Tauri command and a special case in the writer, to perform a write
 * whose entire job is to be beaten by everything.
 *
 * A device that writes nothing cannot lose the race. Whichever order the two
 * events happen in — pane first then sync, or sync first then pane — there is
 * no local row to beat the incoming list, and nothing published to beat the
 * peer's. The first real mutation persists the whole resolved list, which is
 * also the moment the user has actually expressed an opinion worth syncing.
 */
export function resolveBookSources(raw: string | undefined): BookSource[] {
  return raw === undefined ? [...BUILT_IN_BOOK_SOURCES] : parseBookSources(raw);
}

/**
 * Puts the built-ins back the way they shipped — missing ones return, edited
 * ones revert — while leaving anything the user added exactly where it is.
 */
export function restoreBuiltInBookSources(sources: BookSource[]): BookSource[] {
  const userAdded = sources.filter((source) => !isBuiltInBookSource(source.id));
  return [...BUILT_IN_BOOK_SOURCES, ...userAdded];
}

/** Rejects anything the system browser should not be asked to open. */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
