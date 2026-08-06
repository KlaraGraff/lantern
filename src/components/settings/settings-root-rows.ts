import type { SettingsSection, SettingsView } from "../settings-destination";

/**
 * The mobile root list: which rows, in which order, under which headings.
 *
 * This is *not* a second answer to "which sections exist" — that stays with
 * `isSectionAvailable` in `SettingsModal`, and every row here is dropped when
 * its section is unavailable. What it adds is the three things the desktop nav
 * rail has no opinion about: an order, a grouping, and the two places where a
 * row is not simply named after its section.
 *
 * Deliberately data in a `.ts` file rather than JSX: the shape of the list is
 * the part worth asserting in a test, and a test cannot mount a component.
 */

export type SettingsRootGroup = "core" | "ai" | "library" | "misc";

/** Group order, and the heading each group carries. Two carry none. */
export const SETTINGS_ROOT_GROUPS: readonly {
  readonly id: SettingsRootGroup;
  readonly headingKey?: string;
}[] = [
  { id: "core" },
  { id: "ai", headingKey: "settings.groups.ai" },
  { id: "library", headingKey: "settings.groups.library" },
  { id: "misc" },
];

export interface SettingsRootRow {
  readonly id: string;
  readonly section: SettingsSection;
  /** Which view inside the section the row addresses, where the section has several. */
  readonly view?: SettingsView;
  /**
   * `push` opens the section on its own full-screen level; `sheet` raises the
   * section's one control in place. The rule: a section holding exactly one
   * control does not deserve a level of its own. A right chevron means push, a
   * down chevron means sheet.
   */
  readonly kind: "push" | "sheet";
  readonly group: SettingsRootGroup;
  /** Only where the row is not named after its section. */
  readonly labelKey?: string;
  /** Width of this row's loading bar, so the skeleton reads as a list of words. */
  readonly skeletonWidth: number;
}

export const SETTINGS_ROOT_ROWS: readonly SettingsRootRow[] = [
  { id: "general", section: "general", kind: "push", group: "core", skeletonWidth: 52 },
  // 外观 holds nothing but 主题, so the row is named after the control and
  // opens it where it stands.
  {
    id: "theme",
    section: "appearance",
    kind: "sheet",
    group: "core",
    labelKey: "settings.appearance.theme",
    skeletonWidth: 44,
  },
  { id: "reading", section: "reading", kind: "push", group: "core", skeletonWidth: 74 },
  { id: "tools", section: "tools", kind: "push", group: "core", skeletonWidth: 74 },
  // 服务配置 does not survive as a layer on a phone: its four tabs are down to
  // two, and two root rows read better than one row opening a two-tab bar.
  {
    id: "models",
    section: "services",
    view: "models",
    kind: "push",
    group: "ai",
    labelKey: "settings.services.views.models",
    skeletonWidth: 66,
  },
  {
    id: "speech",
    section: "services",
    view: "speech",
    kind: "push",
    group: "ai",
    labelKey: "settings.services.views.speech",
    skeletonWidth: 40,
  },
  { id: "autoAnalysis", section: "autoAnalysis", kind: "push", group: "ai", skeletonWidth: 66 },
  { id: "librarySync", section: "librarySync", kind: "push", group: "library", skeletonWidth: 66 },
  { id: "bookSources", section: "bookSources", kind: "push", group: "library", skeletonWidth: 66 },
  // Absent on a phone (`hasMcpIntegration`), so on a phone the last group is
  // 关于 by itself and needs no heading to separate it from anything.
  { id: "mcp", section: "mcp", kind: "push", group: "misc", skeletonWidth: 38 },
  { id: "about", section: "about", kind: "push", group: "misc", skeletonWidth: 38 },
];

export interface SettingsRootGroupedRows {
  readonly id: SettingsRootGroup;
  readonly headingKey?: string;
  readonly rows: readonly SettingsRootRow[];
}

/**
 * The rows this platform can show, bucketed into their groups. A group whose
 * rows all fell away disappears with them, heading included.
 */
export function groupSettingsRootRows(
  isAvailable: (row: SettingsRootRow) => boolean,
): SettingsRootGroupedRows[] {
  return SETTINGS_ROOT_GROUPS.map((group) => ({
    id: group.id,
    headingKey: group.headingKey,
    rows: SETTINGS_ROOT_ROWS.filter((row) => row.group === group.id && isAvailable(row)),
  })).filter((group) => group.rows.length > 0);
}
