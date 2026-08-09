// Explicit extension: `config.ts` is loaded directly by the node test runner,
// which does not resolve extensionless imports the way Vite does.
import { aiErrorMessageKey, getAiErrorCode, type AiErrorCode } from "../../utils/aiError.ts";
import type {
  BuiltInLearningModuleId,
  BuiltInSelectionMenuActionId,
  CardDesignConfigV1,
  CardKindConfig,
  CardModuleConfig,
  CardWidthMode,
  ContentDensity,
  LearningCardKind,
  LearningModuleDefinition,
  LearningModuleId,
  CustomLearningDefinition,
  CustomLearningId,
  ModuleDensity,
  SelectionMenuActionDefinition,
  SelectionMenuActionId,
  SelectionMenuItemConfig,
  SelectionMenuKind,
} from "./types";

export const LEARNING_CARD_CONFIG_SETTING_KEY = "learning_card_config";
export const MAX_CUSTOM_CARD_MODULES = 8;
export const MAX_CUSTOM_MENU_ACTIONS = 6;
export const MAX_CUSTOM_NAME_LENGTH = 30;
export const MAX_CUSTOM_PROMPT_LENGTH = 2000;

export const CARD_KIND_ORDER: LearningCardKind[] = ["word", "phrase", "passage"];
export const SELECTION_MENU_KIND_ORDER: SelectionMenuKind[] = ["word", "phrase", "passage"];
export const DENSITY_ORDER: ContentDensity[] = ["compact", "standard", "detailed"];

export const CARD_TARGET_WIDTHS: Record<LearningCardKind, Record<ContentDensity, number>> = {
  word: { compact: 380, standard: 480, detailed: 600 },
  phrase: { compact: 420, standard: 520, detailed: 620 },
  passage: { compact: 460, standard: 560, detailed: 680 },
};

const definition = (id: LearningModuleId): LearningModuleDefinition => ({
  id,
  labelKey: `settings.tools.modules.${id}`,
  descriptionKey: `settings.tools.modules.${id}Hint`,
});

export const MODULE_DEFINITIONS: Record<LearningCardKind, LearningModuleDefinition[]> = {
  word: [
    definition("context_meaning"),
    definition("word_info"),
    definition("target_translation"),
    definition("common_senses"),
    definition("collocations"),
    definition("morphology"),
    definition("grammar_role"),
    definition("synonyms"),
    definition("usage"),
    definition("memory_aid"),
    definition("source_excerpt"),
  ],
  phrase: [
    definition("context_meaning"),
    definition("target_translation"),
    definition("common_senses"),
    definition("collocations"),
    definition("grammar_analysis"),
    definition("idioms"),
    definition("usage"),
    definition("source_excerpt"),
  ],
  passage: [
    definition("context_meaning"),
    definition("target_translation"),
    definition("grammar_analysis"),
    definition("key_terms"),
    definition("idioms"),
    definition("references"),
    definition("reusable_patterns"),
    definition("tone"),
    definition("source_excerpt"),
  ],
};

const menuAction = (id: SelectionMenuActionId, labelKey?: string): SelectionMenuActionDefinition => ({
  id,
  labelKey: labelKey ?? `settings.tools.menuActions.${id}`,
});

export const MENU_ACTION_DEFINITIONS: Record<SelectionMenuKind, SelectionMenuActionDefinition[]> = {
  word: [
    menuAction("define", "settings.tools.menuActions.lookup"),
    menuAction("speak"),
    menuAction("ask_ai"),
    menuAction("collect"),
    menuAction("highlight"),
    menuAction("copy"),
    menuAction("translate"),
  ],
  phrase: [
    menuAction("define"),
    menuAction("speak"),
    menuAction("ask_ai"),
    menuAction("collect"),
    menuAction("highlight"),
    menuAction("copy"),
    menuAction("translate"),
  ],
  passage: [
    menuAction("explain"),
    menuAction("speak"),
    menuAction("ask_ai"),
    menuAction("collect"),
    menuAction("highlight"),
    menuAction("copy"),
    menuAction("translate"),
  ],
};

const moduleConfig = (
  id: LearningModuleId,
  enabled: boolean,
  defaultExpanded = true,
  density: ModuleDensity = "inherit",
): CardModuleConfig => ({ id, enabled, defaultExpanded, density });

const defaultCard = (
  kind: LearningCardKind,
  enabled: LearningModuleId[],
  collapsed: LearningModuleId[] = [],
  options: {
    defaultDensity?: ContentDensity;
    densities?: Partial<Record<LearningModuleId, ModuleDensity>>;
  } = {},
): CardKindConfig => {
  const rest = MODULE_DEFINITIONS[kind]
    .map(({ id }) => id)
    .filter((id) => !enabled.includes(id));
  return {
    defaultDensity: options.defaultDensity ?? "standard",
    widthMode: "auto",
    exampleCount: 1,
    keyTermCount: 3,
    modules: [...enabled, ...rest].map((id) =>
      moduleConfig(id, enabled.includes(id), !collapsed.includes(id), options.densities?.[id] ?? "inherit"),
    ),
    customModules: {},
    removedModules: [],
  };
};

export function createDefaultCardDesignConfig(): CardDesignConfigV1 {
  return {
    version: 2,
    cards: {
      word: defaultCard(
        "word",
        ["context_meaning", "word_info", "common_senses", "collocations", "synonyms"],
        [],
        {
          defaultDensity: "compact",
          densities: { context_meaning: "detailed", synonyms: "standard" },
        },
      ),
      phrase: defaultCard(
        "phrase",
        ["context_meaning", "target_translation", "common_senses"],
      ),
      passage: defaultCard(
        "passage",
        ["context_meaning", "target_translation", "idioms"],
      ),
    },
    selectionMenus: {
      word: MENU_ACTION_DEFINITIONS.word.map(({ id }) => ({ id, enabled: id !== "translate" })),
      phrase: MENU_ACTION_DEFINITIONS.phrase.map(({ id }) => ({ id, enabled: id !== "translate" })),
      passage: MENU_ACTION_DEFINITIONS.passage.map(({ id }) => ({ id, enabled: id !== "translate" })),
    },
    removedMenuActions: { word: [], phrase: [], passage: [] },
  };
}

export const DEFAULT_CARD_DESIGN_CONFIG = createDefaultCardDesignConfig();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDensity = (value: unknown): value is ContentDensity =>
  value === "compact" || value === "standard" || value === "detailed";

const isModuleDensity = (value: unknown): value is ModuleDensity =>
  value === "inherit" || isDensity(value);

const isWidthMode = (value: unknown): value is CardWidthMode =>
  value === "auto" || value === "compact" || value === "wide";

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
};

const BUILT_IN_MODULE_IDS: Record<LearningCardKind, Set<BuiltInLearningModuleId>> = {
  word: new Set(MODULE_DEFINITIONS.word.map((item) => item.id as BuiltInLearningModuleId)),
  phrase: new Set(MODULE_DEFINITIONS.phrase.map((item) => item.id as BuiltInLearningModuleId)),
  passage: new Set(MODULE_DEFINITIONS.passage.map((item) => item.id as BuiltInLearningModuleId)),
};

const BUILT_IN_MENU_ACTION_IDS: Record<SelectionMenuKind, Set<BuiltInSelectionMenuActionId>> = {
  word: new Set(MENU_ACTION_DEFINITIONS.word.map((item) => item.id as BuiltInSelectionMenuActionId)),
  phrase: new Set(MENU_ACTION_DEFINITIONS.phrase.map((item) => item.id as BuiltInSelectionMenuActionId)),
  passage: new Set(MENU_ACTION_DEFINITIONS.passage.map((item) => item.id as BuiltInSelectionMenuActionId)),
};

/**
 * A tombstone only ever names built-ins of its own kind. Custom ids are never
 * topped back up, so listing one would grow the list with nothing to clean it.
 */
function parseRemovedIds<T extends string>(value: unknown, allowed: Set<T>): T[] {
  if (!Array.isArray(value)) return [];
  const parsed: T[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item as T) || seen.has(item)) continue;
    seen.add(item);
    parsed.push(item as T);
    if (parsed.length >= allowed.size) break;
  }
  return parsed;
}

function parseModules(
  kind: LearningCardKind,
  value: unknown,
  defaults: CardModuleConfig[],
  customModules: CardKindConfig["customModules"],
  removed: BuiltInLearningModuleId[],
): CardModuleConfig[] {
  if (!Array.isArray(value)) return defaults.map((item) => ({ ...item }));
  const allowed = new Map(MODULE_DEFINITIONS[kind].map((item) => [item.id, item]));
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const seen = new Set<LearningModuleId>();
  const parsed: CardModuleConfig[] = [];

  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    const id = item.id as LearningModuleId;
    const moduleDefinition = allowed.get(id);
    const fallback = defaultById.get(id);
    const custom = id.startsWith("custom_") && customModules[id as CustomLearningId];
    if ((!moduleDefinition || !fallback) && !custom) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    parsed.push({
      id,
      enabled: typeof item.enabled === "boolean" ? item.enabled : fallback?.enabled ?? true,
      defaultExpanded: typeof item.defaultExpanded === "boolean"
        ? item.defaultExpanded
        : fallback?.defaultExpanded ?? true,
      density: isModuleDensity(item.density) ? item.density : fallback?.density ?? "inherit",
    });
  }

  // Built-ins added by a later version must still reach someone whose config
  // predates them — unless they deleted that one themselves.
  const tombstoned = new Set<LearningModuleId>(removed);
  for (const fallback of defaults) {
    if (!seen.has(fallback.id) && !tombstoned.has(fallback.id)) parsed.push({ ...fallback });
  }
  return parsed;
}

function isCustomId(value: unknown): value is CustomLearningId {
  return typeof value === "string" && /^custom_[a-zA-Z0-9_-]+$/.test(value);
}

function parseSourceRef(value: unknown) {
  if (!isObject(value) || !CARD_KIND_ORDER.includes(value.kind as LearningCardKind) || !isCustomId(value.id)) {
    return undefined;
  }
  return { kind: value.kind as LearningCardKind, id: value.id };
}

function parseCustomDefinition(value: unknown): CustomLearningDefinition | null {
  if (!isObject(value)) return null;
  const name = typeof value.name === "string"
    ? Array.from(value.name.trim()).slice(0, MAX_CUSTOM_NAME_LENGTH).join("")
    : "";
  const prompt = typeof value.prompt === "string"
    ? Array.from(value.prompt.trim()).slice(0, MAX_CUSTOM_PROMPT_LENGTH).join("")
    : "";
  if (!name || !prompt) return null;
  const createdAt = typeof value.createdAt === "number" ? value.createdAt : Date.now();
  return {
    name,
    prompt,
    sourceRef: parseSourceRef(value.sourceRef),
    follow: value.follow === true,
    dirtySinceImport: value.dirtySinceImport === true,
    createdAt,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : createdAt,
  };
}

function parseCustomModules(value: unknown): CardKindConfig["customModules"] {
  if (!isObject(value)) return {};
  const entries = Object.entries(value).slice(0, MAX_CUSTOM_CARD_MODULES);
  const parsed: CardKindConfig["customModules"] = {};
  for (const [id, definition] of entries) {
    if (!isCustomId(id)) continue;
    const custom = parseCustomDefinition(definition);
    if (custom) parsed[id] = custom;
  }
  return parsed;
}

function parseCard(
  kind: LearningCardKind,
  value: unknown,
  fallback: CardKindConfig,
): CardKindConfig {
  if (!isObject(value)) {
    return {
      ...fallback,
      modules: fallback.modules.map((item) => ({ ...item })),
      customModules: {},
      removedModules: [],
    };
  }
  const customModules = parseCustomModules(value.customModules);
  const removedModules = parseRemovedIds(value.removedModules, BUILT_IN_MODULE_IDS[kind]);
  return {
    defaultDensity: isDensity(value.defaultDensity) ? value.defaultDensity : fallback.defaultDensity,
    widthMode: isWidthMode(value.widthMode) ? value.widthMode : fallback.widthMode,
    exampleCount: clampInteger(value.exampleCount, fallback.exampleCount, 0, 3),
    keyTermCount: clampInteger(value.keyTermCount, fallback.keyTermCount, 1, 8),
    modules: parseModules(kind, value.modules, fallback.modules, customModules, removedModules),
    customModules,
    removedModules,
  };
}

function parseMenu(
  kind: SelectionMenuKind,
  value: unknown,
  defaults: SelectionMenuItemConfig[],
  removed: BuiltInSelectionMenuActionId[],
): SelectionMenuItemConfig[] {
  if (!Array.isArray(value)) return defaults.map((item) => ({ ...item }));
  const allowed = new Set(MENU_ACTION_DEFINITIONS[kind].map((item) => item.id));
  const defaultById = new Map(defaults.map((item) => [item.id, item]));
  const seen = new Set<SelectionMenuActionId>();
  const parsed: SelectionMenuItemConfig[] = [];

  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string") continue;
    const id = item.id as SelectionMenuActionId;
    const fallback = defaultById.get(id);
    const custom = isCustomId(id) ? parseCustomDefinition(item) : null;
    if (custom && parsed.filter((entry) => isCustomId(entry.id)).length >= MAX_CUSTOM_MENU_ACTIONS) continue;
    if ((!allowed.has(id) || !fallback) && !custom) continue;
    seen.add(id);
    parsed.push({
      id,
      enabled: typeof item.enabled === "boolean" ? item.enabled : fallback?.enabled ?? true,
      ...(custom ?? {}),
    });
  }
  const tombstoned = new Set<SelectionMenuActionId>(removed);
  for (const fallback of defaults) {
    if (!seen.has(fallback.id) && !tombstoned.has(fallback.id)) parsed.push({ ...fallback });
  }
  return parsed;
}

export function parseCardDesignConfig(value: unknown): CardDesignConfigV1 {
  const defaults = createDefaultCardDesignConfig();
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return defaults;
    }
  }
  if (!isObject(candidate) || (candidate.version !== 1 && candidate.version !== 2)) return defaults;
  const cards = isObject(candidate.cards) ? candidate.cards : {};
  const selectionMenus = isObject(candidate.selectionMenus) ? candidate.selectionMenus : {};
  const removedMenus = isObject(candidate.removedMenuActions) ? candidate.removedMenuActions : {};
  // Kept per kind: one shared list would make deleting the word menu's "copy"
  // take the phrase menu's with it.
  const removedMenuActions: Record<SelectionMenuKind, BuiltInSelectionMenuActionId[]> = {
    word: parseRemovedIds(removedMenus.word, BUILT_IN_MENU_ACTION_IDS.word),
    phrase: parseRemovedIds(removedMenus.phrase, BUILT_IN_MENU_ACTION_IDS.phrase),
    passage: parseRemovedIds(removedMenus.passage, BUILT_IN_MENU_ACTION_IDS.passage),
  };
  return {
    version: 2,
    cards: {
      word: parseCard("word", cards.word, defaults.cards.word),
      phrase: parseCard("phrase", cards.phrase, defaults.cards.phrase),
      passage: parseCard("passage", cards.passage, defaults.cards.passage),
    },
    selectionMenus: {
      word: parseMenu("word", selectionMenus.word, defaults.selectionMenus.word, removedMenuActions.word),
      phrase: parseMenu("phrase", selectionMenus.phrase, defaults.selectionMenus.phrase, removedMenuActions.phrase),
      passage: parseMenu("passage", selectionMenus.passage, defaults.selectionMenus.passage, removedMenuActions.passage),
    },
    removedMenuActions,
  };
}

export function serializeCardDesignConfig(config: CardDesignConfigV1): string {
  return JSON.stringify(parseCardDesignConfig(config));
}

/**
 * Deleting a built-in leaves a tombstone so parsing stops handing it back;
 * deleting a custom one takes its definition with it, since nothing would ever
 * hand that back.
 */
export function removeCardModule(card: CardKindConfig, id: LearningModuleId): CardKindConfig {
  const modules = card.modules.filter((module) => module.id !== id);
  if (isCustomId(id)) {
    const customModules = { ...card.customModules };
    delete customModules[id];
    return { ...card, modules, customModules };
  }
  const removedModules = card.removedModules ?? [];
  return {
    ...card,
    modules,
    removedModules: removedModules.includes(id) ? removedModules : [...removedModules, id],
  };
}

/**
 * Built-ins come back exactly as they shipped — order, enabled, expanded,
 * density — and the tombstone empties. Anything the user wrote is not a
 * "default", so it survives, appended after them in its own order.
 */
export function restoreDefaultCardModules(
  kind: LearningCardKind,
  card: CardKindConfig,
): CardKindConfig {
  const factory = createDefaultCardDesignConfig().cards[kind].modules;
  const custom = card.modules.filter((module) => isCustomId(module.id));
  return {
    ...card,
    modules: [...factory, ...custom].map((module) => ({ ...module })),
    removedModules: [],
  };
}

export function removeMenuAction(
  items: SelectionMenuItemConfig[],
  removed: BuiltInSelectionMenuActionId[],
  id: SelectionMenuActionId,
): { items: SelectionMenuItemConfig[]; removed: BuiltInSelectionMenuActionId[] } {
  const nextItems = items.filter((item) => item.id !== id);
  if (isCustomId(id)) return { items: nextItems, removed };
  return {
    items: nextItems,
    removed: removed.includes(id) ? removed : [...removed, id],
  };
}

export function restoreDefaultMenuActions(
  kind: SelectionMenuKind,
  items: SelectionMenuItemConfig[],
): { items: SelectionMenuItemConfig[]; removed: BuiltInSelectionMenuActionId[] } {
  const factory = createDefaultCardDesignConfig().selectionMenus[kind];
  const custom = items.filter((item) => isCustomId(item.id));
  return {
    items: [...factory, ...custom].map((item) => ({ ...item })),
    removed: [],
  };
}

export function getEffectiveDensity(
  module: CardModuleConfig,
  card: CardKindConfig,
): ContentDensity {
  return module.density === "inherit" ? card.defaultDensity : module.density;
}

export function getCardLayoutDensity(card: CardKindConfig): ContentDensity {
  let index = DENSITY_ORDER.indexOf(card.defaultDensity);
  for (const module of card.modules) {
    if (!module.enabled) continue;
    index = Math.max(index, DENSITY_ORDER.indexOf(getEffectiveDensity(module, card)));
  }
  return DENSITY_ORDER[Math.max(0, index)];
}

/**
 * The i18n key that explains a backend error, or null to print it verbatim.
 *
 * The backend refuses a card with no modules by name rather than by sentence, so
 * without this the reader is shown a bare `LEARNING_CARD_ALL_MODULES_DISABLED`.
 * It is the same situation the reader already guards before calling out, just
 * arriving from the other side.
 */
export function learningCardErrorKey(message: string): string | null {
  if (message.includes("LEARNING_CARD_ALL_MODULES_DISABLED")) {
    return "learningCard.allModulesDisabled";
  }
  // The card asks for a JSON protocol the reader never sees, so naming that
  // protocol tells the reader nothing they can act on. What they can act on is
  // the model: retry it, or route the card somewhere else.
  if (message.includes("LEARNING_CARD_PROTOCOL_EMPTY")) {
    return "learningCard.modelSaidNothing";
  }
  if (message.includes("LEARNING_CARD_PROTOCOL_")) {
    return "learningCard.modelOffFormat";
  }
  return null;
}

/**
 * What to show, and what the reader can do about it, for a failed card.
 *
 * The AI route is asked first on purpose. A card that never reached a model
 * fails on the route, and telling that reader the model answered off-format
 * would send them looking in the wrong place — the card protocol only has an
 * opinion once a model actually replied.
 */
export function learningCardFailure(message: string): {
  key: string | null;
  aiCode: AiErrorCode | null;
} {
  const aiCode = getAiErrorCode(message);
  if (aiCode) return { key: aiErrorMessageKey(aiCode), aiCode };
  return { key: learningCardErrorKey(message), aiCode: null };
}

export function getLearningCardTargetWidth(
  kind: LearningCardKind,
  card: CardKindConfig,
): number {
  if (card.widthMode === "compact") return CARD_TARGET_WIDTHS[kind].compact;
  if (card.widthMode === "wide") return CARD_TARGET_WIDTHS[kind].detailed;
  return CARD_TARGET_WIDTHS[kind][getCardLayoutDensity(card)];
}

export function getResponsiveLearningCardWidth(
  kind: LearningCardKind,
  card: CardKindConfig,
  availableWidth: number,
  viewportMargin = 12,
): number {
  const safeAvailableWidth = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;
  return Math.max(0, Math.min(
    getLearningCardTargetWidth(kind, card),
    safeAvailableWidth - viewportMargin * 2,
  ));
}

export function reorderArray<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length || to < 0 || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
