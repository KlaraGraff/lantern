export type SettingsSection =
  | "general"
  | "reading"
  | "learning"
  | "services"
  | "autoAnalysis"
  | "tools"
  | "library"
  | "mcp"
  | "about";

/** Views inside a section that other surfaces can deep-link to. */
export type SettingsView = "models" | "embedding" | "speech" | "ocr" | "passiveVocab";

/**
 * "No particular section" — open settings wherever it opens by default.
 *
 * Deliberately not spelled `"general"`, which three surfaces deep-link to on
 * purpose (the reading-stats level row, the library hint banner, Cmd+`,`). On a
 * phone the two answers differ: a bare `openSettings()` has to land on the root
 * section list, while a deep link to 通用 still has to land inside 通用.
 * Desktop resolves `"root"` back to 通用, because that is where its two-pane
 * dialog has always opened.
 */
export type SettingsRoot = "root";

export type SettingsDestination =
  | SettingsRoot
  | SettingsSection
  | { section: SettingsSection; view: SettingsView };

const SECTIONS = new Set<SettingsSection>([
  "general",
  "reading",
  "learning",
  "services",
  "autoAnalysis",
  "tools",
  "library",
  "mcp",
  "about",
]);

const SERVICES_VIEWS = new Set<SettingsView>(["models", "embedding", "speech", "ocr"]);
const READING_VIEWS = new Set<SettingsView>(["passiveVocab"]);

/**
 * Names that addressed a section before it was renamed, merged, or split off
 * into its own section. `appearance` (1 row: theme) folded into `general`;
 * `librarySync` and `bookSources` merged into `library`.
 */
const SECTION_ALIASES: Record<string, SettingsSection> = {
  lookup: "tools",
  translation: "tools",
  ai: "services",
  appearance: "general",
  librarySync: "library",
  bookSources: "library",
};

function resolveSection(value: unknown): SettingsSection | undefined {
  if (typeof value !== "string") return undefined;
  if (SECTIONS.has(value as SettingsSection)) return value as SettingsSection;
  return SECTION_ALIASES[value];
}

export function normalizeSettingsDestination(value: unknown): SettingsDestination {
  const direct = resolveSection(value);
  if (direct) return direct;

  if (value && typeof value === "object") {
    const candidate = value as { section?: unknown; view?: unknown };
    // Scanned-PDF OCR moved out of 阅读辅助 into the services section.
    if (candidate.section === "tools" && candidate.view === "ocr") {
      return { section: "services", view: "ocr" };
    }
    const section = resolveSection(candidate.section);
    if (section === "services" && SERVICES_VIEWS.has(candidate.view as SettingsView)) {
      return { section: "services", view: candidate.view as SettingsView };
    }
    if (section === "reading" && READING_VIEWS.has(candidate.view as SettingsView)) {
      return { section: "reading", view: candidate.view as SettingsView };
    }
    if (section) return section;
  }
  return "root";
}

/** `undefined` for `"root"`: no section was asked for. */
export function settingsDestinationSection(destination: SettingsDestination): SettingsSection | undefined {
  if (destination === "root") return undefined;
  return typeof destination === "string" ? destination : destination.section;
}

export function settingsDestinationView(destination: SettingsDestination): SettingsView | undefined {
  return typeof destination === "string" ? undefined : destination.view;
}
