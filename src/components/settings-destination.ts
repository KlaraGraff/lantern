export type SettingsSection =
  | "general"
  | "appearance"
  | "reading"
  | "services"
  | "tools"
  | "librarySync"
  | "bookSources"
  | "mcp"
  | "about";

/** Tabs inside the services section that other surfaces can deep-link to. */
export type SettingsView = "models" | "embedding" | "speech" | "ocr";

export type SettingsDestination =
  | SettingsSection
  | { section: SettingsSection; view: SettingsView };

const SECTIONS = new Set<SettingsSection>([
  "general",
  "appearance",
  "reading",
  "services",
  "tools",
  "librarySync",
  "bookSources",
  "mcp",
  "about",
]);

const SERVICES_VIEWS = new Set<SettingsView>(["models", "embedding", "speech", "ocr"]);

/** Names that addressed a section before it was renamed. */
const SECTION_ALIASES: Record<string, SettingsSection> = {
  lookup: "tools",
  translation: "tools",
  ai: "services",
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
    if (section) return section;
  }
  return "general";
}

export function settingsDestinationSection(destination: SettingsDestination): SettingsSection {
  return typeof destination === "string" ? destination : destination.section;
}

export function settingsDestinationView(destination: SettingsDestination): SettingsView | undefined {
  return typeof destination === "string" ? undefined : destination.view;
}
