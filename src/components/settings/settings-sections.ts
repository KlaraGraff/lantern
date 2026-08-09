import {
  Globe,
  BookOpen,
  Bot,
  GraduationCap,
  Highlighter,
  Library,
  Info,
  Terminal,
  Sparkles,
  Volume2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { SettingsSection, SettingsView } from "../settings-destination";

/**
 * The single declarative source for every settings section: what it's called,
 * which icon and group it carries, and how it shows up in the two navigation
 * surfaces that read from it — the desktop sidebar (`SettingsModal`, one row
 * per section) and the narrow root list (`groupSettingsRootRows` below, one
 * row per section except 服务配置, which splits into two).
 *
 * Adding a section means adding one entry to `SETTINGS_SECTIONS` and one id to
 * `SETTINGS_SECTION_ORDER` — `Record<SettingsSection, …>` makes the entry
 * mandatory at compile time, and `SettingsModal`'s own `Record<SettingsSection,
 * () => ReactNode>` render map makes wiring the component mandatory the same
 * way. Availability per platform stays a separate concern
 * (`isSectionAvailable` in `SettingsModal`), not part of this data.
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

/**
 * One row this section contributes to the narrow root list. Most sections
 * contribute exactly one; 服务配置 contributes two (one per view), because its
 * two tabs don't survive as a single phone screen.
 */
export interface SettingsSectionRootRow {
  readonly id: string;
  /** Which view inside the section the row addresses, where the section has several. */
  readonly view?: SettingsView;
  /** Row-specific icon, where it differs from the section's own (服务配置's two rows). */
  readonly icon?: LucideIcon;
  /** Only where the row is not simply named after its section. */
  readonly labelKey?: string;
  /** Width of this row's loading bar, so the skeleton reads as a list of words. */
  readonly skeletonWidth: number;
}

export interface SettingsSectionMeta {
  readonly group: SettingsRootGroup;
  /** Desktop sidebar icon, and the default for this section's own root row(s). */
  readonly icon: LucideIcon;
  readonly labelKey: string;
  /**
   * Static for every section but 服务配置, whose copy names OCR only where the
   * platform can run it — a function keeps that one exception from forcing a
   * platform-flags parameter onto every other section.
   */
  readonly subtitleKey: string | ((flags: { hasOcr: boolean }) => string);
  /** Desktop pane header only; falls back to `subtitleKey` where absent. */
  readonly paneSubtitleKey?: string;
  readonly rootRows: readonly SettingsSectionRootRow[];
}

/** Desktop nav order, and (via `rootRows`) narrow root list order. One place for both. */
export const SETTINGS_SECTION_ORDER: readonly SettingsSection[] = [
  "general",
  "personal",
  "reading",
  "learning",
  "tools",
  "services",
  "autoAnalysis",
  "library",
  "mcp",
  "about",
];

export const SETTINGS_SECTIONS: Record<SettingsSection, SettingsSectionMeta> = {
  general: {
    group: "core",
    icon: Globe,
    labelKey: "settings.general.title",
    subtitleKey: "settings.general.subtitle",
    // 主题 used to be its own one-row section raised as a sheet. It is now a
    // normal row inside 通用 (`Select` already auto-sheets on a touch device),
    // so it no longer has a root row of its own.
    rootRows: [{ id: "general", skeletonWidth: 52 }],
  },
  personal: {
    group: "core",
    icon: UserRound,
    labelKey: "settings.personal.title",
    subtitleKey: "settings.personal.subtitle",
    // 用户画像 moved here from its own sidebar row (docs/impls/home-ia-consolidation.md
    // step 1); renders the existing `ProfileContent` unchanged for now.
    rootRows: [{ id: "personal", skeletonWidth: 38 }],
  },
  reading: {
    group: "core",
    icon: BookOpen,
    labelKey: "settings.reading.title",
    subtitleKey: "settings.reading.subtitle",
    rootRows: [{ id: "reading", skeletonWidth: 74 }],
  },
  learning: {
    group: "core",
    icon: GraduationCap,
    labelKey: "settings.learning.title",
    subtitleKey: "settings.learning.subtitle",
    rootRows: [{ id: "learning", skeletonWidth: 60 }],
  },
  tools: {
    group: "core",
    icon: Highlighter,
    labelKey: "settings.tools.title",
    subtitleKey: "settings.tools.subtitle",
    paneSubtitleKey: "settings.tools.paneSubtitle",
    rootRows: [{ id: "tools", skeletonWidth: 74 }],
  },
  services: {
    group: "ai",
    icon: Bot,
    labelKey: "settings.services.shortTitle",
    // The subtitle lists what the tab holds, and OCR is not in it where the
    // platform cannot run OCR — the tab would be advertising a missing view.
    subtitleKey: ({ hasOcr }) =>
      hasOcr ? "settings.services.shortSubtitle" : "settings.services.shortSubtitleNoOcr",
    // 服务配置 does not survive as a layer on a phone: its four tabs are down to
    // two, and two root rows read better than one row opening a two-tab bar.
    rootRows: [
      {
        id: "models",
        view: "models",
        icon: Bot,
        labelKey: "settings.services.views.models",
        skeletonWidth: 66,
      },
      {
        id: "speech",
        view: "speech",
        icon: Volume2,
        labelKey: "settings.services.views.speech",
        skeletonWidth: 40,
      },
    ],
  },
  autoAnalysis: {
    group: "ai",
    icon: Sparkles,
    labelKey: "settings.autoAnalysis.title",
    subtitleKey: "settings.autoAnalysis.subtitle",
    // Directly under AI 配置 rather than beside the other AI features: the
    // question this tab answers is "what runs without me", which is about
    // the account that gets billed, not about the features themselves.
    rootRows: [{ id: "autoAnalysis", skeletonWidth: 66 }],
  },
  library: {
    group: "library",
    icon: Library,
    labelKey: "settings.library.title",
    subtitleKey: "settings.library.subtitle",
    // 书籍来源 + 书库同步 merged into one section, so the phone gets one root
    // row for it instead of two.
    rootRows: [{ id: "library", skeletonWidth: 66 }],
  },
  mcp: {
    group: "misc",
    icon: Terminal,
    labelKey: "settings.mcp.title",
    subtitleKey: "settings.mcp.subtitle",
    // Absent on a phone (`hasMcpIntegration`), so on a phone the last group is
    // 关于 by itself and needs no heading to separate it from anything.
    rootRows: [{ id: "mcp", skeletonWidth: 38 }],
  },
  about: {
    group: "misc",
    icon: Info,
    labelKey: "settings.about.title",
    subtitleKey: "settings.about.subtitle",
    rootRows: [{ id: "about", skeletonWidth: 38 }],
  },
};

/**
 * The mobile root list: which rows, in which order, under which headings.
 *
 * This is *not* a second answer to "which sections exist" — that stays with
 * `isSectionAvailable` in `SettingsModal`, and every row here is dropped when
 * its section is unavailable. It is the flattened, ordered view of
 * `SETTINGS_SECTIONS[*].rootRows`, one section at a time in
 * `SETTINGS_SECTION_ORDER`.
 */
export interface SettingsRootRow {
  readonly id: string;
  readonly section: SettingsSection;
  /** Which view inside the section the row addresses, where the section has several. */
  readonly view?: SettingsView;
  /**
   * `push` opens the section on its own full-screen level; `sheet` raises the
   * section's one control in place. The rule: a section holding exactly one
   * control does not deserve a level of its own. A right chevron means push, a
   * down chevron means sheet. No section currently uses `sheet` — 主题's old
   * bottom sheet folded into 通用 once `Select` learned to auto-sheet itself —
   * but the distinction stays real should a one-control section reappear.
   */
  readonly kind: "push" | "sheet";
  readonly group: SettingsRootGroup;
  readonly icon: LucideIcon;
  /** Only where the row is not named after its section. */
  readonly labelKey?: string;
  /** Width of this row's loading bar, so the skeleton reads as a list of words. */
  readonly skeletonWidth: number;
}

export const SETTINGS_ROOT_ROWS: readonly SettingsRootRow[] = SETTINGS_SECTION_ORDER.flatMap(
  (section) => {
    const meta = SETTINGS_SECTIONS[section];
    return meta.rootRows.map((row) => ({
      id: row.id,
      section,
      view: row.view,
      kind: "push" as const,
      group: meta.group,
      icon: row.icon ?? meta.icon,
      labelKey: row.labelKey,
      skeletonWidth: row.skeletonWidth,
    }));
  },
);

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
