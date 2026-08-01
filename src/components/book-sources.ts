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
/** Set once the defaults have been written, so a deleted one stays deleted. */
export const BOOK_SOURCES_SEEDED_KEY = "book_sources_seeded";

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
