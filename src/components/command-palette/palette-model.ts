/**
 * The command palette's pure half: matching, ranking, the command list, and
 * keyboard selection. No React, no Tauri — `tests/command-palette.test.ts`
 * drives it directly.
 */

export type PaletteGroup = "books" | "words" | "notes" | "commands";

/** Order the groups appear in with a query typed. Empty, only books and commands show. */
export const GROUP_ORDER: readonly PaletteGroup[] = ["words", "books", "notes", "commands"];

/** Per-group cap: the palette is a jump list, not a results page. */
export const GROUP_LIMIT = 5;

/**
 * How well `text` answers `query`, lower is better; `-1` is no match.
 *
 * 0 exact · 1 prefix · 2 a later word starts with it · 3 anywhere inside.
 * Case-insensitive and trimmed; an empty query matches everything equally.
 */
export function matchRank(text: string, query: string): number {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return 0;
  const t = text.toLocaleLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  const at = t.indexOf(q);
  if (at < 0) return -1;
  return /[\s\-_'’·.,:;/(]/.test(t[at - 1] ?? "") ? 2 : 3;
}

/**
 * Keep the items that match, best first, at most `limit`. Ties keep their
 * incoming order, so a caller that passes words newest-first gets newest-first
 * within each rank.
 */
export function rankByMatch<T>(items: readonly T[], query: string, textOf: (item: T) => string, limit = GROUP_LIMIT): T[] {
  return items
    .map((item, index) => ({ item, index, rank: matchRank(textOf(item), query) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/** `text` cut around the first case-insensitive occurrence of `query`, for highlighting. */
export function splitMatch(text: string, query: string): [string, string, string] {
  const q = query.trim();
  if (!q) return [text, "", ""];
  const at = text.toLocaleLowerCase().indexOf(q.toLocaleLowerCase());
  if (at < 0) return [text, "", ""];
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}

/** Arrow-key movement through `count` rows, wrapping at both ends. */
export function wrapIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Workspaces the library window can switch to — the rail's five, by filter id. */
export const WORKSPACE_FILTERS = ["all", "vocab", "notes", "qa", "stats"] as const;
export type WorkspaceFilter = (typeof WORKSPACE_FILTERS)[number];

export type CommandSpec =
  | { id: string; kind: "workspace"; filter: WorkspaceFilter }
  | { id: string; kind: "import" }
  | { id: string; kind: "review" }
  | { id: string; kind: "theme"; to: "light" | "dark" }
  | { id: string; kind: "settings"; section: string };

/**
 * Every command, in display order. `settingsSections` is the settings nav order;
 * the MCP section is dropped where the platform has no MCP integration, the
 * same rule the settings modal applies to its own nav.
 */
export function buildCommandSpecs(options: {
  isDark: boolean;
  hasMcp: boolean;
  settingsSections: readonly string[];
}): CommandSpec[] {
  return [
    { id: "cmd:import", kind: "import" },
    { id: "cmd:review", kind: "review" },
    ...WORKSPACE_FILTERS.map((filter): CommandSpec => ({ id: `cmd:go:${filter}`, kind: "workspace", filter })),
    { id: "cmd:theme", kind: "theme", to: options.isDark ? "light" : "dark" },
    ...options.settingsSections
      .filter((section) => section !== "mcp" || options.hasMcp)
      .map((section): CommandSpec => ({ id: `cmd:settings:${section}`, kind: "settings", section })),
  ];
}
