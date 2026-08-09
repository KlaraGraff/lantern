export type LearningCardKind = "word" | "phrase" | "passage";
export type ContentDensity = "compact" | "standard" | "detailed";
export type ModuleDensity = "inherit" | ContentDensity;
export type CardWidthMode = "auto" | "compact" | "wide";

export type BuiltInLearningModuleId =
  | "context_meaning"
  | "sentence_gist"
  | "why_this_word"
  | "word_info"
  | "target_translation"
  | "common_senses"
  | "collocations"
  | "morphology"
  | "grammar_role"
  | "grammar_analysis"
  | "synonyms"
  | "usage"
  | "key_terms"
  | "idioms"
  | "references"
  | "reusable_patterns"
  | "tone"
  | "memory_aid"
  | "source_excerpt";
export type CustomLearningId = `custom_${string}`;
export type LearningModuleId = BuiltInLearningModuleId | CustomLearningId;

export type SelectionMenuKind = "word" | "phrase" | "passage";
export type BuiltInSelectionMenuActionId =
  | "define"
  | "explain"
  | "speak"
  | "ask_ai"
  | "collect"
  | "highlight"
  | "translate"
  | "copy";
export type SelectionMenuActionId = BuiltInSelectionMenuActionId | CustomLearningId;

export interface ImportedSourceRef {
  kind: LearningCardKind;
  id: CustomLearningId;
}

export interface CustomLearningDefinition {
  name: string;
  prompt: string;
  sourceRef?: ImportedSourceRef;
  follow?: boolean;
  dirtySinceImport?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CardModuleConfig {
  id: LearningModuleId;
  enabled: boolean;
  defaultExpanded: boolean;
  density: ModuleDensity;
}

export interface CardKindConfig {
  defaultDensity: ContentDensity;
  widthMode: CardWidthMode;
  exampleCount: number;
  keyTermCount: number;
  modules: CardModuleConfig[];
  customModules: Partial<Record<CustomLearningId, CustomLearningDefinition>>;
  /**
   * Built-in modules the user deleted on purpose. Parsing stops topping these
   * back up; "restore defaults" empties the list. Without it, "never configured"
   * and "deleted every one of them" look identical in storage.
   */
  removedModules?: BuiltInLearningModuleId[];
}

export interface SelectionMenuItemConfig {
  id: SelectionMenuActionId;
  enabled: boolean;
  name?: string;
  prompt?: string;
  sourceRef?: ImportedSourceRef;
  follow?: boolean;
  dirtySinceImport?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface CardDesignConfigV1 {
  version: 2;
  cards: Record<LearningCardKind, CardKindConfig>;
  selectionMenus: Record<SelectionMenuKind, SelectionMenuItemConfig[]>;
  /**
   * Same tombstone, per menu kind. `selectionMenus` holds arrays with nowhere to
   * put it, so it lives alongside them instead of inside.
   */
  removedMenuActions?: Record<SelectionMenuKind, BuiltInSelectionMenuActionId[]>;
}

export interface LearningModuleDefinition {
  id: LearningModuleId;
  labelKey: string;
  descriptionKey: string;
  custom?: boolean;
}

export interface SelectionMenuActionDefinition {
  id: SelectionMenuActionId;
  labelKey: string;
}

export interface LearningExample {
  source: string;
  target?: string;
}

export interface LearningContentItem {
  title: string;
  text?: string;
  meta?: string[];
  examples?: LearningExample[];
}

export interface LearningModuleContent {
  heading?: string;
  summary?: string;
  meta?: string[];
  details?: string[];
  items?: LearningContentItem[];
  quote?: string;
}

export interface LearningCardResult {
  version: number;
  kind: LearningCardKind;
  sourceText: string;
  modules: Partial<Record<LearningModuleId, LearningModuleContent>>;
}

export interface LearningCardNote {
  id: string;
  content: string;
  updatedAt?: number;
  scope?: "book" | "global";
}

/**
 * The reader's own record for the looked-up word, as `word_memory_hint`
 * returns it. The card shows it so that a deliberately shorter answer reads as
 * "it remembers me" rather than as the model cutting corners.
 */
export interface WordMemoryHint {
  looked_up_times: number;
  mastery: string | null;
  reviews: number;
  mastery_book_title: string | null;
}

export type LearningCardActionId = "collect" | "ask_ai" | "note" | "copy";

export interface LearningCardActionState {
  collected?: boolean;
  copied?: boolean;
  disabled?: boolean;
}
