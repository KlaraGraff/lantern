import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Highlighter, LayoutPanelTop, MousePointer2, MousePointerClick, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { defaultExplanationMode } from "../../i18n";
import {
  LEARNING_CARD_CONFIG_SETTING_KEY,
  LEARNING_CARD_SOURCE_MANUAL,
  LEARNING_CARD_SOURCE_SETTING_KEY,
  createDefaultCardDesignConfig,
  parseCardDesignConfig,
  serializeCardDesignConfig,
  type CardDesignConfigV1,
  type LearningCardKind,
  type SelectionMenuKind,
  type CustomLearningId,
} from "../learning-card";
import type { CustomImportSource, UnsavedEditorController } from "./CustomActionEditor";
import Toggle from "../ui/Toggle";
import Select from "../ui/Select";
import CardDesignSettings from "./CardDesignSettings";
import DensityHelpDialog from "./DensityHelpDialog";
import SelectionMenuSettings from "./SelectionMenuSettings";
import MarkerStyleSettings from "./MarkerStyleSettings";
import ReaderBindingsSettings from "./ReaderBindingsSettings";
import ConfirmDialog from "./ConfirmDialog";
import type { SettingsProps } from "./types";
import {
  MARKER_STYLE_SETTING_KEY,
  createDefaultMarkerStyleConfig,
  parseMarkerStyleConfig,
  serializeMarkerStyleConfig,
  type MarkerStyleConfig,
} from "../marker-style";
import {
  DEFAULT_MARKER_VISIBILITY,
  MARKER_VISIBILITY_KEYS,
  MARKER_VISIBILITY_SETTING_KEY,
  resolveMarkerVisibility,
  type MarkerVisibility,
} from "../mark-palette";
import { notifyReadingAssistanceSettingsChanged } from "../reading-assistance-events";
import {
  addPendingWrites,
  appliedSnapshot,
  groupsToRehydrate,
  rehydrationKeys,
  removePendingWrites,
  type RehydrationGroup,
} from "./settings-rehydration";
import {
  parseReaderBindings,
  READER_BINDINGS_SETTING_KEY,
  SHOW_MENU_SHORTCUTS_SETTING_KEY,
  type ReaderActionBinding,
} from "../reader-bindings";
import {
  TRIPLE_CLICK_SCOPES,
  parseTripleClickScope,
  type TripleClickScope,
} from "../reader-interaction";

type ToolsView = "interaction" | "cards" | "menu" | "markers";

export interface ToolsPreviewState {
  kind: LearningCardKind;
  config: CardDesignConfigV1;
  explanationLanguage: string;
  targetLanguage: string;
  learnerLevel: string;
  explanationMode: string;
  showMenu: boolean;
  lastTouched: { id: string; nonce: number } | null;
  testText?: string;
  testNonce?: number;
  customActionTest?: { name: string; prompt: string; text: string; nonce: number };
  onDismiss: () => void;
}

interface ToolsSettingsProps extends SettingsProps {
  onPreviewChange?: (preview: ToolsPreviewState | null) => void;
  onNavigationGuardChange?: (guard: ((action: () => void) => void) | null) => void;
}

function SettingsRow({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[52px] w-full items-center justify-between gap-4 px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-primary">{title}</p>
        <p className="break-words text-[11px] leading-[17px] text-text-placeholder">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

function setWordTranslationModule(config: CardDesignConfigV1, enabled: boolean): CardDesignConfigV1 {
  return {
    ...config,
    cards: {
      ...config.cards,
      word: {
        ...config.cards.word,
        modules: config.cards.word.modules.map((module) =>
          module.id === "target_translation" ? { ...module, enabled } : module,
        ),
      },
    },
  };
}

function wordTranslationEnabled(config: CardDesignConfigV1) {
  // A deleted module is not a missing setting: `?? true` here would answer
  // "yes, show translations" for the user who just removed that very row.
  const module = config.cards.word.modules.find((item) => item.id === "target_translation");
  return module ? module.enabled : false;
}

/**
 * The card design as the settings map has it. `show_translation` is only a
 * fallback for the reader that predates the card config, so it is read here and
 * watched below — a pane that ignored it would never notice the legacy row move.
 */
function hydratedCardConfig(settings: Record<string, string>): CardDesignConfigV1 {
  const parsed = parseCardDesignConfig(settings[LEARNING_CARD_CONFIG_SETTING_KEY]);
  return !settings[LEARNING_CARD_CONFIG_SETTING_KEY] && settings.show_translation !== undefined
    ? setWordTranslationModule(parsed, settings.show_translation === "true")
    : parsed;
}

/**
 * Each block of local state below, with the settings keys it is built from.
 * A change to any of them re-reads that block and nothing else — see
 * `settings-rehydration.ts` for why it is grouped and what holds it back.
 */
const REHYDRATION_GROUPS: readonly RehydrationGroup[] = [
  { id: "cards", keys: [LEARNING_CARD_CONFIG_SETTING_KEY, "show_translation"] },
  { id: "autoHighlight", keys: ["auto_highlight_lookup_words"] },
  { id: "markerStyle", keys: [MARKER_STYLE_SETTING_KEY] },
  { id: "markerVisibility", keys: MARKER_VISIBILITY_KEYS.map((key) => MARKER_VISIBILITY_SETTING_KEY[key]) },
  { id: "lookupFade", keys: ["lookup_markers_never_fade"] },
  {
    id: "interaction",
    keys: [
      "double_click_quick_lookup",
      "triple_click_quick_select",
      "triple_click_scope",
      "dictionary_lookup_enabled",
    ],
  },
  { id: "menuShortcuts", keys: [SHOW_MENU_SHORTCUTS_SETTING_KEY] },
  { id: "bindings", keys: [READER_BINDINGS_SETTING_KEY] },
];

const REHYDRATION_KEYS = REHYDRATION_GROUPS.flatMap((group) => [...group.keys]);

function resolveFollowingSources(config: CardDesignConfigV1): CardDesignConfigV1 {
  const cards = { ...config.cards };
  for (const kind of ["word", "phrase", "passage"] as LearningCardKind[]) {
    const card = cards[kind];
    const customModules = { ...card.customModules };
    for (const [id, definition] of Object.entries(customModules)) {
      if (!definition?.sourceRef || !definition.follow) continue;
      const source = config.cards[definition.sourceRef.kind].customModules[definition.sourceRef.id];
      customModules[id as CustomLearningId] = source && !source.sourceRef
        ? { ...definition, name: source.name, prompt: source.prompt, dirtySinceImport: false, updatedAt: source.updatedAt }
        : { ...definition, follow: false };
    }
    cards[kind] = { ...card, customModules };
  }
  const selectionMenus = { ...config.selectionMenus };
  for (const kind of ["word", "phrase", "passage"] as LearningCardKind[]) {
    selectionMenus[kind] = selectionMenus[kind].map((item) => {
      if (!item.sourceRef || !item.follow) return item;
      const source = config.selectionMenus[item.sourceRef.kind]
        .find((candidate) => candidate.id === item.sourceRef?.id && !candidate.sourceRef);
      return source?.name && source.prompt
        ? { ...item, name: source.name, prompt: source.prompt, dirtySinceImport: false, updatedAt: source.updatedAt }
        : { ...item, follow: false };
    });
  }
  return { ...config, cards, selectionMenus };
}

export default function ToolsSettings({
  settings,
  loading,
  save,
  saveBulk,
  showSavedToast,
  onPreviewChange,
  onNavigationGuardChange,
}: ToolsSettingsProps) {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<ToolsView>("interaction");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [cardKind, setCardKind] = useState<LearningCardKind>("word");
  const [menuKind, setMenuKind] = useState<SelectionMenuKind>("word");
  const [densityHelpOpen, setDensityHelpOpen] = useState(false);
  const [config, setConfig] = useState<CardDesignConfigV1>(createDefaultCardDesignConfig);
  const [autoHighlightLookupWords, setAutoHighlightLookupWords] = useState(true);
  const [markerStyle, setMarkerStyle] = useState<MarkerStyleConfig>(createDefaultMarkerStyleConfig);
  const [markerVisibility, setMarkerVisibility] = useState<MarkerVisibility>(DEFAULT_MARKER_VISIBILITY);
  // Off unless the row says otherwise — the opposite default from the marker
  // visibility switches above, so it reads `=== "true"` rather than `!== "false"`.
  const [lookupMarkersNeverFade, setLookupMarkersNeverFade] = useState(false);
  const [doubleClickQuickLookup, setDoubleClickQuickLookup] = useState(true);
  const [dictionaryLookupEnabled, setDictionaryLookupEnabled] = useState(true);
  const [tripleClickQuickSelect, setTripleClickQuickSelect] = useState(true);
  const [tripleClickScope, setTripleClickScope] = useState<TripleClickScope>("sentence");
  const [showMenuShortcuts, setShowMenuShortcuts] = useState(true);
  const [readerBindings, setReaderBindings] = useState<ReaderActionBinding[]>([]);
  const [lastTouched, setLastTouched] = useState<{ id: string; nonce: number } | null>(null);
  const [testPreview, setTestPreview] = useState<{ config: CardDesignConfigV1; text: string; id: string; nonce: number } | null>(null);
  const [customActionTest, setCustomActionTest] = useState<ToolsPreviewState["customActionTest"]>();
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const hydratedRef = useRef(false);
  // What the rows on screen were built from, and which keys this pane is
  // writing right now. Together they tell an outside change apart from the
  // pane's own — only the first may replace a control the user can see.
  const appliedRef = useRef<Record<string, string | undefined>>({});
  const pendingWritesRef = useRef(new Map<string, number>());
  const editorControllerRef = useRef<UnsavedEditorController | null>(null);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const [editorController, setEditorController] = useState<UnsavedEditorController | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const touch = (id: string) => {
    setLastTouched((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
  };
  const handleEditorGuardChange = useCallback((controller: UnsavedEditorController | null) => {
    editorControllerRef.current = controller;
    setEditorController(controller);
  }, []);
  const requestNavigation = useCallback((action: () => void) => {
    const controller = editorControllerRef.current;
    if (!controller?.dirty) {
      action();
      return;
    }
    pendingNavigationRef.current = action;
    setGuardOpen(true);
  }, []);
  const finishPendingNavigation = () => {
    const action = pendingNavigationRef.current;
    pendingNavigationRef.current = null;
    setGuardOpen(false);
    action?.();
  };
  const continueEditing = () => {
    pendingNavigationRef.current = null;
    setGuardOpen(false);
  };

  useEffect(() => {
    onNavigationGuardChange?.(requestNavigation);
    return () => onNavigationGuardChange?.(null);
  }, [onNavigationGuardChange, requestNavigation]);

  useEffect(() => {
    if (loading || hydratedRef.current) return;
    setConfig(hydratedCardConfig(settings));
    setAutoHighlightLookupWords(settings.auto_highlight_lookup_words !== "false");
    setMarkerStyle(parseMarkerStyleConfig(settings[MARKER_STYLE_SETTING_KEY]));
    setMarkerVisibility(resolveMarkerVisibility(settings));
    setLookupMarkersNeverFade(settings.lookup_markers_never_fade === "true");
    setDoubleClickQuickLookup(settings.double_click_quick_lookup !== "false");
    setDictionaryLookupEnabled(settings.dictionary_lookup_enabled !== "false");
    setTripleClickQuickSelect(settings.triple_click_quick_select !== "false");
    setTripleClickScope(parseTripleClickScope(settings.triple_click_scope));
    setShowMenuShortcuts(settings[SHOW_MENU_SHORTCUTS_SETTING_KEY] !== "false");
    setReaderBindings(parseReaderBindings(settings[READER_BINDINGS_SETTING_KEY]).bindings);
    appliedRef.current = appliedSnapshot(REHYDRATION_KEYS, settings);
    hydratedRef.current = true;
  }, [settings, loading]);

  // Reading on from there: the modal outlives the values it is showing. The
  // reader's 「设为全局默认」, another window, another pane — anything that writes
  // one of these keys while this pane is mounted has to reach the rows too, or
  // they go on displaying what was true when the pane opened.
  useEffect(() => {
    if (loading || !hydratedRef.current) return;
    const stale = groupsToRehydrate({
      groups: REHYDRATION_GROUPS,
      stored: settings,
      applied: appliedRef.current,
      pending: pendingWritesRef.current.keys(),
      // A custom action mid-edit is the one block that cannot be re-read: its
      // editor mirrors the config it was opened with, so replacing the config
      // throws away the text the user has typed but not saved. The dependency
      // list picks the change back up once the editor is clean or gone.
      blocked: editorController?.dirty ? ["cards"] : [],
    });
    if (stale.length === 0) return;
    for (const group of stale) {
      switch (group) {
        case "cards":
          setConfig(hydratedCardConfig(settings));
          setTestPreview(null);
          setCustomActionTest(undefined);
          break;
        case "autoHighlight":
          setAutoHighlightLookupWords(settings.auto_highlight_lookup_words !== "false");
          break;
        case "markerStyle":
          setMarkerStyle(parseMarkerStyleConfig(settings[MARKER_STYLE_SETTING_KEY]));
          break;
        case "markerVisibility":
          setMarkerVisibility(resolveMarkerVisibility(settings));
          break;
        case "lookupFade":
          setLookupMarkersNeverFade(settings.lookup_markers_never_fade === "true");
          break;
        case "interaction":
          setDoubleClickQuickLookup(settings.double_click_quick_lookup !== "false");
          setDictionaryLookupEnabled(settings.dictionary_lookup_enabled !== "false");
          setTripleClickQuickSelect(settings.triple_click_quick_select !== "false");
          setTripleClickScope(parseTripleClickScope(settings.triple_click_scope));
          break;
        case "menuShortcuts":
          setShowMenuShortcuts(settings[SHOW_MENU_SHORTCUTS_SETTING_KEY] !== "false");
          break;
        case "bindings":
          setReaderBindings(parseReaderBindings(settings[READER_BINDINGS_SETTING_KEY]).bindings);
          break;
      }
    }
    appliedRef.current = {
      ...appliedRef.current,
      ...appliedSnapshot(rehydrationKeys(REHYDRATION_GROUPS, stale), settings),
    };
  }, [editorController, loading, settings]);

  const previewExplanationMode = settings.explanation_mode || defaultExplanationMode(i18n.language);
  const resolvedExplanationLanguage = previewExplanationMode === "chinese"
    || (previewExplanationMode === "adaptive_bilingual" && ["A1", "A2", "B1"].includes(settings.cefr_level || "B1"))
    ? "zh"
    : "en";
  const targetLanguage = settings.translation_language || "zh";

  useEffect(() => {
    if (loading || !previewOpen || (view !== "cards" && view !== "menu")) {
      onPreviewChange?.(null);
      return;
    }

    const isMenuPreview = view === "menu";
    const kind = isMenuPreview ? menuKind : cardKind;
    onPreviewChange?.({
      kind,
      config: testPreview?.config ?? config,
      explanationLanguage: resolvedExplanationLanguage,
      targetLanguage,
      learnerLevel: settings.cefr_level || "B1",
      explanationMode: previewExplanationMode,
      showMenu: isMenuPreview,
      lastTouched: testPreview
        ? { id: testPreview.id, nonce: testPreview.nonce }
        : lastTouched,
      testText: testPreview?.text,
      testNonce: testPreview?.nonce,
      customActionTest,
      onDismiss: () => setPreviewOpen(false),
    });
  }, [
    cardKind,
    config,
    customActionTest,
    lastTouched,
    loading,
    menuKind,
    onPreviewChange,
    previewOpen,
    previewExplanationMode,
    resolvedExplanationLanguage,
    settings.cefr_level,
    settings.explanation_mode,
    settings.translation_language,
    targetLanguage,
    testPreview,
    view,
  ]);

  useEffect(() => () => onPreviewChange?.(null), [onPreviewChange]);

  if (loading) return null;

  const queueSave = (entries: Record<string, string>, toastMessage?: string) => {
    const keys = Object.keys(entries);
    // Claimed before the write starts, released only once it has settled: the
    // pane's own change comes back to it as a settings change like any other,
    // and while one is out the rows it touches answer to the control, not to
    // the store. A failed write leaves the claim behind but not the value —
    // the next change re-reads the row from what was actually stored.
    addPendingWrites(pendingWritesRef.current, keys);
    appliedRef.current = { ...appliedRef.current, ...entries };
    saveQueue.current = saveQueue.current
      .catch(() => {})
      .then(() => saveBulk(entries))
      .then(() => notifyReadingAssistanceSettingsChanged(keys))
      .then(() => showSavedToast(toastMessage))
      .catch((error) => console.error("Failed to save learning tool settings:", error))
      .finally(() => removePendingWrites(pendingWritesRef.current, keys));
  };
  const persistConfig = (next: CardDesignConfigV1) => {
    const normalized = parseCardDesignConfig(resolveFollowingSources(next));
    const translationEnabled = wordTranslationEnabled(normalized);
    setConfig(normalized);
    setTestPreview(null);
    setCustomActionTest(undefined);
    queueSave({
      [LEARNING_CARD_CONFIG_SETTING_KEY]: serializeCardDesignConfig(normalized),
      show_translation: String(translationEnabled),
      // 一旦读者自己动过卡片，等级就不再改写它。跟讲解语言那档同一条规矩：
      // 已经表过态的选择不该被等级重新覆盖一遍。
      [LEARNING_CARD_SOURCE_SETTING_KEY]: LEARNING_CARD_SOURCE_MANUAL,
    });
  };
  const persistLegacy = (key: string, value: string) => {
    addPendingWrites(pendingWritesRef.current, [key]);
    appliedRef.current = { ...appliedRef.current, [key]: value };
    save(key, value)
      .then(() => {
        showSavedToast();
        return notifyReadingAssistanceSettingsChanged([key]);
      })
      .catch((error) => {
        console.error(`Failed to save ${key}:`, error);
      })
      .finally(() => removePendingWrites(pendingWritesRef.current, [key]));
  };
  const persistMarkerStyle = (next: MarkerStyleConfig) => {
    const normalized = parseMarkerStyleConfig(next);
    setMarkerStyle(normalized);
    const serialized = serializeMarkerStyleConfig(normalized);
    queueSave({ [MARKER_STYLE_SETTING_KEY]: serialized });
  };
  // Only the switch that moved is written. Writing all four would create rows
  // for three settings the user never touched, and an existing row is not the
  // same thing as a default: it is what `promote_book_settings_to_global` puts
  // back on undo, and what a future change to the defaults would no longer reach.
  const persistMarkerVisibility = (next: MarkerVisibility) => {
    const changed: Record<string, string> = {};
    for (const key of MARKER_VISIBILITY_KEYS) {
      if (next[key] !== markerVisibility[key]) changed[MARKER_VISIBILITY_SETTING_KEY[key]] = String(next[key]);
    }
    setMarkerVisibility(next);
    if (Object.keys(changed).length > 0) queueSave(changed);
  };
  const updateCard = (kind: LearningCardKind, card: CardDesignConfigV1["cards"][LearningCardKind]) => {
    persistConfig({ ...config, cards: { ...config.cards, [kind]: card } });
  };
  const importSources = (targetKind: LearningCardKind): CustomImportSource[] => (
    (Object.keys(config.cards) as LearningCardKind[])
      .filter((kind) => kind !== targetKind)
      .flatMap((kind) => Object.entries(config.cards[kind].customModules)
        .filter(([, definition]) => definition && !definition.sourceRef)
        .map(([id, definition]) => ({
          kind,
          id: id as CustomLearningId,
          name: definition!.name,
          prompt: definition!.prompt,
        })))
  );
  const menuImportSources = (targetKind: LearningCardKind): CustomImportSource[] => (
    (Object.keys(config.selectionMenus) as LearningCardKind[])
      .filter((kind) => kind !== targetKind)
      .flatMap((kind) => config.selectionMenus[kind]
        .filter((item) => item.id.startsWith("custom_") && item.name && item.prompt && !item.sourceRef)
        .map((item) => ({
          kind,
          id: item.id as CustomLearningId,
          name: item.name!,
          prompt: item.prompt!,
        })))
  );
  const views: { id: ToolsView; icon: typeof Highlighter; label: string }[] = [
    { id: "interaction", icon: MousePointerClick, label: t("settings.tools.views.interaction") },
    { id: "cards", icon: LayoutPanelTop, label: t("settings.tools.views.cards") },
    { id: "menu", icon: MousePointer2, label: t("settings.tools.views.menu") },
    {
      id: "markers",
      icon: Highlighter,
      label: t("settings.tools.views.markers", { defaultValue: "正文标记" }),
    },
  ];

  return (
    <div className="w-full min-w-0 pb-10">
      <div role="tablist" className="mb-4 flex min-w-0 gap-1 border-b border-border-light">
        {views.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => requestNavigation(() => {
                setView(item.id);
                setPreviewOpen(item.id === "cards" || item.id === "menu");
              })}
              className={`flex h-10 min-w-0 items-center gap-1.5 border-b-2 px-3 text-[12px] font-medium ${view === item.id ? "border-accent text-accent-text" : "border-transparent text-text-muted hover:text-text-primary"}`}
            >
              <Icon size={14} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      {view === "interaction" && (
        <div className="mx-auto w-full max-w-[620px]">
          <SettingsRow
            title={t("dictionary.privacyToggleLabel")}
            subtitle={t("dictionary.privacyToggleHint")}
          >
            <Toggle
              label={t("dictionary.privacyToggleLabel")}
              checked={dictionaryLookupEnabled}
              onChange={(enabled) => {
                setDictionaryLookupEnabled(enabled);
                persistLegacy("dictionary_lookup_enabled", String(enabled));
              }}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.tools.interaction.doubleClick")}
            subtitle={t("settings.tools.interaction.doubleClickHint")}
          >
            <Toggle
              label={t("settings.tools.interaction.doubleClick")}
              checked={doubleClickQuickLookup}
              onChange={(enabled) => {
                if (enabled && readerBindings.some((binding) => binding.trigger === "mouse:double")) {
                  showSavedToast(t("settings.tools.bindings.doubleClickConflictReverse"));
                  return;
                }
                setDoubleClickQuickLookup(enabled);
                persistLegacy("double_click_quick_lookup", String(enabled));
              }}
            />
          </SettingsRow>
          <SettingsRow
            title={t("settings.tools.interaction.tripleClick")}
            subtitle={t("settings.tools.interaction.tripleClickHint")}
          >
            <div className="flex items-center gap-3">
              {tripleClickQuickSelect && (
                <Select
                  className="w-[104px]"
                  value={tripleClickScope}
                  onChange={(scope) => {
                    setTripleClickScope(parseTripleClickScope(scope));
                    persistLegacy("triple_click_scope", scope);
                  }}
                  options={TRIPLE_CLICK_SCOPES.map((scope) => ({
                    value: scope,
                    label: t(`settings.tools.interaction.tripleClickScope.${scope}`),
                  }))}
                />
              )}
              <Toggle
                label={t("settings.tools.interaction.tripleClick")}
                checked={tripleClickQuickSelect}
                onChange={(enabled) => {
                  if (enabled && readerBindings.some((binding) => binding.trigger === "mouse:triple")) {
                    showSavedToast(t("settings.tools.bindings.tripleClickConflictReverse"));
                    return;
                  }
                  setTripleClickQuickSelect(enabled);
                  persistLegacy("triple_click_quick_select", String(enabled));
                }}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings.tools.interaction.menuShortcuts")}
            subtitle={t("settings.tools.interaction.menuShortcutsHint")}
          >
            <Toggle
              label={t("settings.tools.interaction.menuShortcuts")}
              checked={showMenuShortcuts}
              onChange={(enabled) => {
                setShowMenuShortcuts(enabled);
                persistLegacy(SHOW_MENU_SHORTCUTS_SETTING_KEY, String(enabled));
              }}
            />
          </SettingsRow>
          <ReaderBindingsSettings
            value={readerBindings}
            config={config}
            doubleClickEnabled={doubleClickQuickLookup}
            tripleClickEnabled={tripleClickQuickSelect}
            previousPageBinding={settings.previous_page_binding || "key:ArrowLeft"}
            nextPageBinding={settings.next_page_binding || "key:ArrowRight"}
            onChange={(bindings) => {
              setReaderBindings(bindings);
              queueSave(
                { [READER_BINDINGS_SETTING_KEY]: JSON.stringify({ version: 1, bindings }) },
                t("settings.tools.bindings.savedToast"),
              );
            }}
          />
        </div>
      )}

      {view === "cards" && (
        <div>
          <div className="mb-4 flex items-center justify-between gap-2 border-b border-border-light">
            <div className="flex gap-1" role="tablist">
              {(["word", "phrase", "passage"] as LearningCardKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={cardKind === kind}
                  onClick={() => requestNavigation(() => setCardKind(kind))}
                  className={`h-9 border-b-2 px-3 text-[12px] font-medium ${cardKind === kind ? "border-accent text-accent-text" : "border-transparent text-text-muted"}`}
                >
                  {t(`settings.tools.cardKind.${kind}`)}
                </button>
              ))}
            </div>
            {!previewOpen && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                title={t("settings.tools.showPreview")}
                aria-label={t("settings.tools.showPreview")}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-text-primary"
              >
                <PanelRightOpen size={15} />
              </button>
            )}
          </div>
          <div className="mx-auto w-full max-w-[620px]">
            <CardDesignSettings
              key={cardKind}
              kind={cardKind}
              value={config.cards[cardKind]}
              onChange={(card) => updateCard(cardKind, card)}
              onOpenDensityHelp={() => setDensityHelpOpen(true)}
              onTouched={touch}
              importSources={importSources(cardKind)}
              requestNavigation={requestNavigation}
              onEditorGuardChange={handleEditorGuardChange}
              onTest={(text, customId, draft, card) => {
                const testCard = {
                  ...card,
                  customModules: { ...card.customModules, [customId]: draft },
                };
                setTestPreview({
                  text,
                  id: customId,
                  nonce: Date.now(),
                  config: { ...config, cards: { ...config.cards, [cardKind]: testCard } },
                });
                setPreviewOpen(true);
              }}
            />
          </div>
        </div>
      )}

      {view === "menu" && (
        <div>
          <div className="mb-4 flex items-center justify-between gap-2 border-b border-border-light">
            <div className="flex gap-1" role="tablist">
              {(["word", "phrase", "passage"] as SelectionMenuKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  aria-selected={menuKind === kind}
                  onClick={() => requestNavigation(() => setMenuKind(kind))}
                  className={`h-9 border-b-2 px-3 text-[12px] font-medium ${menuKind === kind ? "border-accent text-accent-text" : "border-transparent text-text-muted"}`}
                >
                  {t(`settings.tools.cardKind.${kind}`)}
                </button>
              ))}
            </div>
            {!previewOpen && (
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                title={t("settings.tools.showPreview")}
                aria-label={t("settings.tools.showPreview")}
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-text-primary"
              >
                <PanelRightOpen size={15} />
              </button>
            )}
          </div>
          <div className="mx-auto w-full max-w-[620px]">
            <SelectionMenuSettings
              key={menuKind}
              kind={menuKind}
              value={config.selectionMenus[menuKind]}
              removed={config.removedMenuActions?.[menuKind] ?? []}
              onChange={(menu, removed) => persistConfig({
                ...config,
                selectionMenus: { ...config.selectionMenus, [menuKind]: menu },
                ...(removed ? {
                  removedMenuActions: {
                    ...(config.removedMenuActions ?? { word: [], phrase: [], passage: [] }),
                    [menuKind]: removed,
                  },
                } : {}),
              })}
              onTouched={touch}
              importSources={menuImportSources(menuKind)}
              requestNavigation={requestNavigation}
              onEditorGuardChange={handleEditorGuardChange}
              onTest={(text, draft) => {
                setCustomActionTest({ name: draft.name, prompt: draft.prompt, text, nonce: Date.now() });
                setPreviewOpen(true);
              }}
            />
          </div>
        </div>
      )}

      {view === "markers" && (
        <div>
          <MarkerStyleSettings
            value={markerStyle}
            onChange={persistMarkerStyle}
            visibility={markerVisibility}
            onVisibilityChange={persistMarkerVisibility}
            lookupNeverFade={lookupMarkersNeverFade}
            onLookupNeverFadeChange={(enabled) => {
              setLookupMarkersNeverFade(enabled);
              persistLegacy("lookup_markers_never_fade", String(enabled));
            }}
            lookupRow={(
              <SettingsRow
                title={t("settings.tools.autoHighlightLookupWords", { defaultValue: "查词后自动标记" })}
                subtitle={t("settings.tools.autoHighlightLookupWordsHint", {
                  defaultValue: "查词成功后创建单词标记；手动标记始终保持独立。",
                })}
              >
                <Toggle
                  label={t("settings.tools.autoHighlightLookupWords", { defaultValue: "查词后自动标记" })}
                  checked={autoHighlightLookupWords}
                  onChange={(enabled) => {
                    setAutoHighlightLookupWords(enabled);
                    persistLegacy("auto_highlight_lookup_words", String(enabled));
                  }}
                />
              </SettingsRow>
            )}
          />
        </div>
      )}

      {densityHelpOpen && <DensityHelpDialog initialKind={cardKind} onClose={() => setDensityHelpOpen(false)} />}
      {guardOpen && editorController && (
        <ConfirmDialog
          title={t("settings.tools.custom.unsavedTitle", {
            name: editorController.name || t("settings.tools.custom.untitled"),
          })}
          description={t("settings.tools.custom.unsavedDescription")}
          primaryLabel={t("common.save")}
          primaryDisabled={!editorController.canSave}
          onPrimary={() => {
            if (editorControllerRef.current?.save()) finishPendingNavigation();
          }}
          secondaryLabel={t("settings.tools.custom.discard")}
          onSecondary={() => {
            editorControllerRef.current?.discard();
            finishPendingNavigation();
          }}
          tertiaryLabel={t("settings.tools.custom.continueEditing")}
          onTertiary={continueEditing}
        />
      )}
    </div>
  );
}
