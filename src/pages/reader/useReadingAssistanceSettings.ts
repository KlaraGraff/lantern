import { useCallback, useEffect, useRef, useState } from "react";
import { getAllSettings } from "../../hooks/useSettings";
import {
  PASSIVE_VOCAB_DEFAULT_LIMIT,
  parsePassiveVocabSettings,
  type PassiveVocabSettings,
} from "../../components/passive-vocab";
import { parseTripleClickScope, type TripleClickScope } from "../../components/reader-interaction";
import {
  MARKER_STYLE_SETTING_KEY,
  createDefaultMarkerStyleConfig,
  parseMarkerStyleConfig,
  type MarkerStyleConfig,
} from "../../components/marker-style";
import {
  parseReaderBindings,
  SHOW_MENU_SHORTCUTS_SETTING_KEY,
  menuShortcutsVisible,
  type ReaderActionBinding,
} from "../../components/reader-bindings";
import {
  DEFAULT_CARD_DESIGN_CONFIG,
  parseCardDesignConfig,
  type CardDesignConfigV1,
} from "../../components/learning-card";
import {
  listenForReadingAssistanceSettingsChanged,
  readingAssistanceSettingsChanged,
} from "../../components/reading-assistance-events";

/**
 * Every global reading-assistance preference the reader reads, kept in step
 * with the settings window.
 *
 * Each value is exposed twice on purpose. The refs are for the interaction
 * handlers, which live outside React (inside foliate's chapter iframes) and
 * want the newest value without being torn down and re-installed every time a
 * preference changes; the state copies are for the things that render them.
 *
 * Two subscriptions, because neither alone covers both cases: the event fires
 * when settings change while the reader is open, and the focus check catches a
 * change made in a window that never emitted one.
 */
export function useReadingAssistanceSettings() {
  const autoHighlightLookupsRef = useRef(true);
  const [markerStyle, setMarkerStyle] = useState<MarkerStyleConfig>(createDefaultMarkerStyleConfig);
  const markerStyleRef = useRef(markerStyle);
  const markMatchingWordsRef = useRef(markerStyle.wordMatchScope !== "current");
  const doubleClickQuickLookupRef = useRef(true);
  const [doubleClickQuickLookup, setDoubleClickQuickLookup] = useState(true);
  const tripleClickQuickSelectRef = useRef(true);
  const tripleClickScopeRef = useRef<TripleClickScope>("sentence");
  const readerBindingsRef = useRef<ReaderActionBinding[]>([]);
  // The ref is for the interaction handlers, which live outside React and want
  // the newest value without re-subscribing. The menu prints them while
  // rendering, which a ref cannot drive — so the same list is also state.
  const [readerBindings, setReaderBindings] = useState<ReaderActionBinding[]>([]);
  const [showMenuShortcuts, setShowMenuShortcuts] = useState(true);
  const [learningCardConfig, setLearningCardConfig] = useState<CardDesignConfigV1>(DEFAULT_CARD_DESIGN_CONFIG);
  const [passiveVocab, setPassiveVocab] = useState<PassiveVocabSettings>({
    enabled: false,
    style: "ruby",
    limit: PASSIVE_VOCAB_DEFAULT_LIMIT,
  });

  const applyReadingAssistanceSettings = useCallback((settings: Record<string, string>) => {
    const doubleClick = settings.double_click_quick_lookup !== "false";
    const nextMarkerStyle = parseMarkerStyleConfig(settings[MARKER_STYLE_SETTING_KEY]);
    doubleClickQuickLookupRef.current = doubleClick;
    tripleClickQuickSelectRef.current = settings.triple_click_quick_select !== "false";
    tripleClickScopeRef.current = parseTripleClickScope(settings.triple_click_scope);
    autoHighlightLookupsRef.current = settings.auto_highlight_lookup_words !== "false";
    markerStyleRef.current = nextMarkerStyle;
    markMatchingWordsRef.current = nextMarkerStyle.wordMatchScope !== "current";
    setDoubleClickQuickLookup(doubleClick);
    const nextBindings = parseReaderBindings(settings.reader_bindings).bindings;
    readerBindingsRef.current = nextBindings;
    setReaderBindings(nextBindings);
    setShowMenuShortcuts(menuShortcutsVisible(settings[SHOW_MENU_SHORTCUTS_SETTING_KEY]));
    setMarkerStyle(nextMarkerStyle);
    setLearningCardConfig(parseCardDesignConfig(settings.learning_card_config));
    setPassiveVocab(parsePassiveVocabSettings(settings));
  }, []);

  const readingAssistanceSettingsRef = useRef<Record<string, string>>({});

  /** For the book load, which has already fetched the whole settings blob. */
  const adoptReadingAssistanceSettings = useCallback((settings: Record<string, string>) => {
    readingAssistanceSettingsRef.current = settings;
    applyReadingAssistanceSettings(settings);
  }, [applyReadingAssistanceSettings]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const settings = await getAllSettings().catch(() => null);
      if (!disposed && settings) {
        readingAssistanceSettingsRef.current = settings;
        applyReadingAssistanceSettings(settings);
      }
    };
    listenForReadingAssistanceSettingsChanged(refresh).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyReadingAssistanceSettings]);

  useEffect(() => {
    const refreshOnFocus = async () => {
      const settings = await getAllSettings().catch(() => null);
      if (!settings || !readingAssistanceSettingsChanged(
        settings,
        readingAssistanceSettingsRef.current,
      )) return;
      readingAssistanceSettingsRef.current = settings;
      applyReadingAssistanceSettings(settings);
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [applyReadingAssistanceSettings]);

  useEffect(() => {
    markerStyleRef.current = markerStyle;
    markMatchingWordsRef.current = markerStyle.wordMatchScope !== "current";
  }, [markerStyle]);

  return {
    adoptReadingAssistanceSettings,
    autoHighlightLookupsRef,
    doubleClickQuickLookup,
    doubleClickQuickLookupRef,
    learningCardConfig,
    markMatchingWordsRef,
    markerStyle,
    markerStyleRef,
    passiveVocab,
    readerBindings,
    readerBindingsRef,
    setMarkerStyle,
    setPassiveVocab,
    showMenuShortcuts,
    tripleClickQuickSelectRef,
    tripleClickScopeRef,
  };
}
