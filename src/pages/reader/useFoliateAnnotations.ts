import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ReaderSettingsState } from "../../components/ReaderSettings";
import {
  applyWordMarks,
} from "../../components/reader-interaction";
import { fontBoxHeight, glyphInset } from "../../components/glyph-metrics";
import type { Highlight } from "../../hooks/useBookmarks";
import {
  MARKER_STYLE_SETTING_KEY,
  effectiveAutomaticMarkerStyle,
  markerOverlayStyle,
  parseMarkerStyleConfig,
  wordMarkerCss,
  type MarkerStyleConfig,
  type MarkerVisualStyle,
} from "../../components/marker-style";
import {
  READING_HIGHLIGHT_COLOR,
  READING_HIGHLIGHT_OPACITY,
  SAVED_HIGHLIGHT_OPACITY,
  savedHighlightColor,
  washBlendMode,
  wordMarkerColor,
  wordMarkerStyle,
} from "../../components/mark-palette";
import {
  installCustomFontFacesInDocument,
  type CustomFontRecord,
} from "../../components/custom-fonts";
import { getFontFamily } from "../../components/reader-settings";
import { getReaderCSS } from "./reader-theme";
import { expandWordForms } from "../../components/word-forms";
import type { AnnotationStyleKind, FoliateView } from "./foliate-types";

export interface VocabMarker {
  cfi: string | null;
  mastery: string;
}

export interface WordMarkRule {
  normalized_word: string;
  enabled: boolean;
}

export interface WordMarkException {
  normalized_word: string;
  location: string;
  excluded: boolean;
}

export interface LookupOccurrenceMark {
  location: string;
  enabled: boolean;
}

type MarkerKind = "lookup" | "vocab";
export type FoliateMarker = { color: string; kind: MarkerKind };
type AppliedAnnotation = { color: string; styleKind: AnnotationStyleKind };

function drawMarkerRects(
  rects: DOMRectList,
  style: MarkerVisualStyle,
  isPdf: boolean,
  boxHeight: number | null,
) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("fill", style.color);
  // Text split by a word marker or an inline tag reports one rect per fragment.
  // Grouping the fills under a single opacity keeps their rounded edges from
  // overlapping into a darker seam.
  const fills = document.createElementNS("http://www.w3.org/2000/svg", "g");
  fills.setAttribute("opacity", String(style.opacity / 100));
  const lines = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.append(fills, lines);
  for (const { left, top, height, width } of rects) {
    // getClientRects reports the line box, so a wide line height would paint a
    // slab around the word. Sit the marker on the glyphs instead.
    const inset = glyphInset(height, boxHeight);
    const markHeight = height - inset * 2;
    const markTop = top + inset;
    if (style.background) {
      const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const pad = isPdf ? 1 : 0;
      background.setAttribute("x", String(Math.floor(left)));
      background.setAttribute("y", String(markTop - pad));
      background.setAttribute("height", String(markHeight + pad * 2));
      background.setAttribute("width", String(Math.ceil(width)));
      background.setAttribute("rx", isPdf ? "1" : "0");
      fills.append(background);
    }
    if (style.underline) {
      const underline = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      underline.setAttribute("x", String(left));
      underline.setAttribute("y", String(markTop + markHeight - 1.5));
      underline.setAttribute("height", "1.5");
      underline.setAttribute("width", String(width));
      underline.setAttribute("rx", "0.75");
      lines.append(underline);
    }
  }
  return group;
}

interface DrawAnnotationDetail {
  draw(renderer: (rects: DOMRectList) => SVGGElement): void;
  annotation: { color: string; styleKind?: AnnotationStyleKind };
  range?: Range;
}

export function drawFoliateAnnotation(
  { draw, annotation, range }: DrawAnnotationDetail,
  markerStyle: MarkerStyleConfig,
  isPdf: boolean,
  // Asked for rather than passed: foliate keeps this callback and re-runs it on
  // every relayout, including the one a theme change causes. A backdrop read
  // here would be the one the mark was first drawn against, and a highlight
  // would keep blending for the old page until the reader turned to the next.
  pageBackdrop: () => string,
) {
  const boxHeight = fontBoxHeight(range?.startContainer ?? null);
  if (annotation.styleKind === "manual" || annotation.styleKind === "automatic") {
    const style = annotation.styleKind === "manual"
      ? markerStyle.manual
      : effectiveAutomaticMarkerStyle(markerStyle);
    draw((rects) => drawMarkerRects(rects, markerOverlayStyle(style), isPdf, boxHeight));
    return;
  }
  const marker = wordMarkerStyle[annotation.color];
  if (marker) {
    draw((rects) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("fill", marker.color);
      group.setAttribute("opacity", String(marker.opacity));
      for (const { left, top, height, width } of rects) {
        const baseline = top + height - glyphInset(height, boxHeight);
        if (marker.dashed) {
          // A rect cannot dash, and emitting one rect per dash would round its
          // corners into dots. A stroked line at zero height can, and sits in
          // the same 1.5px band once it is centred rather than topped.
          const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
          line.setAttribute("x1", String(left));
          line.setAttribute("x2", String(left + width));
          line.setAttribute("y1", String(baseline - 0.75));
          line.setAttribute("y2", String(baseline - 0.75));
          line.setAttribute("stroke", marker.color);
          line.setAttribute("stroke-width", "1.5");
          line.setAttribute("stroke-dasharray", "3 2.5");
          group.append(line);
          continue;
        }
        const line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        line.setAttribute("x", String(left));
        line.setAttribute("y", String(baseline - 1.5));
        line.setAttribute("height", "1.5");
        line.setAttribute("width", String(width));
        line.setAttribute("rx", "0.75");
        group.append(line);
      }
      return group;
    });
    return;
  }
  // Saved highlights name their colour ("yellow"); the reading highlight passes
  // a hex value. Falling back to yellow for anything unnamed had been quietly
  // repainting it, so a constant chosen to be unmistakable never once reached
  // the screen — the sentence being read aloud looked like a yellow highlight.
  const reading = annotation.color === READING_HIGHLIGHT_COLOR;
  const color = savedHighlightColor[annotation.color]
    ?? (/^#[0-9a-f]{6}$/i.test(annotation.color) ? annotation.color : savedHighlightColor.yellow);
  draw((rects) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("fill", color);
    group.setAttribute("opacity", String(reading ? READING_HIGHLIGHT_OPACITY : SAVED_HIGHLIGHT_OPACITY));
    // Blended into the page so the words keep their contrast under it — but
    // which way depends on the page. Multiplying into the dark theme was
    // subtracting light that was not there, and the read-aloud wash vanished.
    group.style.mixBlendMode = washBlendMode(pageBackdrop());
    for (const { left, top, height, width } of rects) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const pad = isPdf ? 1 : 0;
      const inset = glyphInset(height, boxHeight);
      rect.setAttribute("x", String(Math.floor(left)));
      rect.setAttribute("y", String(top + inset - pad));
      rect.setAttribute("height", String(height - inset * 2 + pad * 2));
      rect.setAttribute("width", String(Math.ceil(width)));
      rect.setAttribute("rx", isPdf ? "1" : "0");
      group.append(rect);
    }
    return group;
  });
}

interface UseFoliateAnnotationsOptions {
  bookId?: string;
  bookReady: boolean;
  isTextBook: boolean;
  supportsManualAnnotations: boolean;
  supportsWordMarkers: boolean;
  supportsCfiNavigation: boolean;
  supportsReflowSettings: boolean;
  readerSettings: ReaderSettingsState;
  readerSettingsRef: MutableRefObject<ReaderSettingsState>;
  viewRef: MutableRefObject<FoliateView | null>;
  markerStyle: MarkerStyleConfig;
  markerStyleRef: MutableRefObject<MarkerStyleConfig>;
  markMatchingWordsRef: MutableRefObject<boolean>;
  setMarkerStyle: Dispatch<SetStateAction<MarkerStyleConfig>>;
  setReaderSettings: Dispatch<SetStateAction<ReaderSettingsState>>;
  textReaderNavigateRef: MutableRefObject<((location: string, flash?: boolean) => void) | null>;
}

export function useFoliateAnnotations({
  bookId,
  bookReady,
  isTextBook,
  supportsManualAnnotations,
  supportsWordMarkers,
  supportsCfiNavigation,
  supportsReflowSettings,
  readerSettings,
  readerSettingsRef,
  viewRef,
  markerStyle,
  markerStyleRef,
  markMatchingWordsRef,
  setMarkerStyle,
  setReaderSettings,
  textReaderNavigateRef,
}: UseFoliateAnnotationsOptions) {
  const autoMarkersRef = useRef(new Map<string, FoliateMarker>());
  const appliedAnnotationsRef = useRef(new Map<string, AppliedAnnotation>());
  const navigationFlashRef = useRef(new Map<string, number>());
  const markerSnapshotRef = useRef<{
    highlights: Highlight[];
    vocab: VocabMarker[];
    lookupOccurrences: LookupOccurrenceMark[];
  } | null>(null);
  const wordMarkWordsRef = useRef<string[]>([]);
  const wordMarkExceptionsRef = useRef(new Set<string>());

  const applyAnnotations = useCallback(async (reapplyVisible = false) => {
    const view = viewRef.current;
    if (!view || !supportsManualAnnotations) return;
    const snapshot = markerSnapshotRef.current;
    if (!snapshot) return;
    const { highlights, vocab, lookupOccurrences } = snapshot;
    const manual = new Set(highlights.map((highlight) => highlight.cfi_range));
    const settings = readerSettingsRef.current;
    const next = new Map<string, FoliateMarker>();
    if (settings.showLookupMarkers) {
      for (const mark of lookupOccurrences) {
        if (mark.enabled && mark.location && !manual.has(mark.location)) {
          next.set(mark.location, { color: wordMarkerColor.lookup, kind: "lookup" });
        }
      }
    }
    if (supportsWordMarkers) {
      for (const word of vocab) {
        if (!word.cfi || manual.has(word.cfi)) continue;
        if (word.mastery === "mastered" && settings.showMasteredMarkers) {
          next.set(word.cfi, { color: wordMarkerColor.mastered, kind: "vocab" });
        } else if (word.mastery === "learning" && settings.showLearningMarkers) {
          next.set(word.cfi, { color: wordMarkerColor.learning, kind: "vocab" });
        } else if (word.mastery !== "mastered" && word.mastery !== "learning" && settings.showNewVocabMarkers) {
          next.set(word.cfi, { color: wordMarkerColor.vocabNew, kind: "vocab" });
        }
      }
    }
    autoMarkersRef.current = next;
    const desired = new Map<string, AppliedAnnotation>([...next.entries()].map(([cfi, marker]) => [
      cfi,
      { color: marker.color, styleKind: marker.kind === "lookup" ? "automatic" : "vocab" },
    ]));
    for (const highlight of highlights) {
      desired.set(highlight.cfi_range, { color: highlight.color, styleKind: "manual" });
    }
    const previous = appliedAnnotationsRef.current;
    const cfis = new Set([...previous.keys(), ...desired.keys()]);
    await Promise.all([...cfis].map(async (cfi) => {
      const oldAnnotation = previous.get(cfi);
      const newAnnotation = desired.get(cfi);
      if (!reapplyVisible
        && oldAnnotation?.color === newAnnotation?.color
        && oldAnnotation?.styleKind === newAnnotation?.styleKind) return;
      if (oldAnnotation !== undefined) await view.deleteAnnotation({ value: cfi }).catch(() => {});
      if (newAnnotation !== undefined) {
        await view.addAnnotation({
          value: cfi,
          color: newAnnotation.color,
          styleKind: newAnnotation.styleKind,
        }).catch(() => {});
      }
    }));
    appliedAnnotationsRef.current = desired;
  }, [readerSettingsRef, supportsManualAnnotations, supportsWordMarkers, viewRef]);

  const applyFoliateMarkerStyles = useCallback(() => {
    const view = viewRef.current;
    if (!view || !supportsReflowSettings) return;
    const markerStyle = markerStyleRef.current;
    const automaticStyle = effectiveAutomaticMarkerStyle(markerStyle);
    const css = wordMarkerCss(
      markerStyle,
      automaticStyle,
      getFontFamily(readerSettingsRef.current.font),
    );
    for (const { doc, index } of view.renderer?.getContents?.() ?? []) {
      if (!doc || typeof index !== "number") continue;
      installCustomFontFacesInDocument(doc);
      applyWordMarks(
        doc,
        readerSettingsRef.current.showLookupMarkers ? wordMarkWordsRef.current : [],
        "quill-word-marks",
        undefined,
        (word, range) => {
          const location = view.getCFI(index, range);
          return !wordMarkExceptionsRef.current.has(`${word}\0${location}`);
        },
        css,
      );
    }
  }, [markerStyleRef, readerSettingsRef, supportsReflowSettings, viewRef]);

  const refreshAnnotations = useCallback(async (reapplyVisible = false) => {
    if (isTextBook || !bookId || !viewRef.current || !supportsManualAnnotations) return;
    const [highlights, vocab, lookupOccurrences] = await Promise.all([
      invoke<Highlight[]>("list_highlights", { bookId }),
      supportsWordMarkers
        ? invoke<VocabMarker[]>("list_vocab_words", { bookId })
        : Promise.resolve([]),
      invoke<LookupOccurrenceMark[]>("list_lookup_occurrence_marks", { bookId }),
    ]);
    markerSnapshotRef.current = { highlights, vocab, lookupOccurrences };
    await applyAnnotations(reapplyVisible);
    applyFoliateMarkerStyles();
  }, [
    applyAnnotations,
    applyFoliateMarkerStyles,
    bookId,
    isTextBook,
    supportsManualAnnotations,
    supportsWordMarkers,
    viewRef,
  ]);

  const flashNavigationTarget = useCallback(async (cfi: string) => {
    if (isTextBook) {
      textReaderNavigateRef.current?.(cfi, true);
      return;
    }
    const view = viewRef.current;
    if (!view || !supportsCfiNavigation) return;
    await view.goTo(cfi);
    await view.addAnnotation({ value: cfi, color: "#c27aff" }).catch(() => {});
    const token = Date.now() + Math.random();
    navigationFlashRef.current.set(cfi, token);
    window.setTimeout(async () => {
      if (navigationFlashRef.current.get(cfi) !== token || viewRef.current !== view) return;
      navigationFlashRef.current.delete(cfi);
      await view.deleteAnnotation({ value: cfi }).catch(() => {});
      const annotation = appliedAnnotationsRef.current.get(cfi);
      if (annotation) await view.addAnnotation({ value: cfi, ...annotation }).catch(() => {});
    }, 3000);
  }, [isTextBook, supportsCfiNavigation, textReaderNavigateRef, viewRef]);

  /**
   * The sentence being read aloud. Temporary, but drawn with the same mechanism
   * as a saved highlight, so removing it has to put back whatever it covered —
   * the sequence `flashNavigationTarget` already performs, minus the timer,
   * because this one ends when the audio does.
   */
  const readingHighlightRef = useRef<string | null>(null);

  const clearReadingHighlight = useCallback(async () => {
    const cfi = readingHighlightRef.current;
    if (!cfi) return;
    // Cleared before awaiting anything, so a stop arriving mid-removal cannot
    // start a second removal of the same annotation.
    readingHighlightRef.current = null;
    const view = viewRef.current;
    if (!view) return;
    await view.deleteAnnotation({ value: cfi }).catch(() => {});
    const annotation = appliedAnnotationsRef.current.get(cfi);
    if (annotation) await view.addAnnotation({ value: cfi, ...annotation }).catch(() => {});
  }, [viewRef]);

  const showReadingHighlight = useCallback(async (cfi: string) => {
    if (readingHighlightRef.current === cfi) return;
    await clearReadingHighlight();
    const view = viewRef.current;
    if (!view || !supportsCfiNavigation) return;
    readingHighlightRef.current = cfi;
    await view.addAnnotation({ value: cfi, color: READING_HIGHLIGHT_COLOR }).catch(() => {});
  }, [clearReadingHighlight, supportsCfiNavigation, viewRef]);

  const resetAnnotationState = useCallback(() => {
    autoMarkersRef.current.clear();
    appliedAnnotationsRef.current.clear();
    readingHighlightRef.current = null;
    navigationFlashRef.current.clear();
    markerSnapshotRef.current = null;
    wordMarkWordsRef.current = [];
    wordMarkExceptionsRef.current.clear();
  }, []);

  useEffect(() => {
    const refreshFonts = async (event: Event) => {
      const records = (event as CustomEvent<CustomFontRecord[]>).detail ?? [];
      const available = new Set(records.map((font) => font.id));
      setReaderSettings((current) => {
        if (!current.font.startsWith("custom-") || available.has(current.font)) return current;
        const next = { ...current, font: "system" };
        readerSettingsRef.current = next;
        if (bookId) localStorage.setItem(`reader-settings-${bookId}`, JSON.stringify(next));
        return next;
      });
      const storedMarkerStyle = await invoke<string | null>("get_setting", {
        key: MARKER_STYLE_SETTING_KEY,
      }).catch(() => null);
      const nextMarkerStyle = parseMarkerStyleConfig(storedMarkerStyle);
      markerStyleRef.current = nextMarkerStyle;
      markMatchingWordsRef.current = nextMarkerStyle.wordMatchScope !== "current";
      setMarkerStyle(nextMarkerStyle);
      const view = viewRef.current;
      if (!view) return;
      for (const { doc } of view.renderer?.getContents?.() ?? []) {
        if (doc) installCustomFontFacesInDocument(doc);
      }
      if (supportsReflowSettings) view.renderer?.setStyles?.(getReaderCSS(readerSettingsRef.current));
      applyFoliateMarkerStyles();
    };
    window.addEventListener("custom-font-faces-loaded", refreshFonts);
    return () => window.removeEventListener("custom-font-faces-loaded", refreshFonts);
  }, [
    applyFoliateMarkerStyles,
    bookId,
    markMatchingWordsRef,
    markerStyleRef,
    readerSettingsRef,
    setMarkerStyle,
    setReaderSettings,
    supportsReflowSettings,
    viewRef,
  ]);

  const markerVisibility = [
    readerSettings.showLookupMarkers,
    readerSettings.showNewVocabMarkers,
    readerSettings.showLearningMarkers,
    readerSettings.showMasteredMarkers,
  ].join(":");
  useEffect(() => {
    refreshAnnotations().catch(() => {});
  }, [bookReady, markerVisibility, markerStyle, refreshAnnotations]);

  useEffect(() => {
    if (!bookId || !supportsWordMarkers || isTextBook) return;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (detail?.bookId && detail.bookId !== bookId) return;
      Promise.all([
        invoke<WordMarkRule[]>("list_word_marks", { bookId }),
        invoke<WordMarkException[]>("list_word_mark_exceptions", { bookId }),
      ]).then(async ([rules, exceptions]) => {
        wordMarkWordsRef.current = await expandWordForms(
          rules.filter((rule) => rule.enabled).map((rule) => rule.normalized_word),
          markerStyleRef.current.wordMatchScope === "forms",
        );
        wordMarkExceptionsRef.current = new Set(exceptions
          .filter((exception) => exception.excluded)
          .map((exception) => `${exception.normalized_word}\0${exception.location}`));
        applyFoliateMarkerStyles();
      }).catch(() => {});
    };
    window.addEventListener("word-mark-changed", refresh);
    return () => window.removeEventListener("word-mark-changed", refresh);
  }, [applyFoliateMarkerStyles, bookId, isTextBook, markerStyleRef, supportsWordMarkers]);

  useEffect(() => {
    if (!bookId || isTextBook || !supportsWordMarkers) return;
    const refresh = async () => {
      const rules = await invoke<WordMarkRule[]>("list_word_marks", { bookId });
      wordMarkWordsRef.current = await expandWordForms(
        rules.filter((rule) => rule.enabled).map((rule) => rule.normalized_word),
        markerStyleRef.current.wordMatchScope === "forms",
      );
      applyFoliateMarkerStyles();
    };
    void refresh();
    window.addEventListener("word-forms-changed", refresh);
    return () => window.removeEventListener("word-forms-changed", refresh);
  }, [
    applyFoliateMarkerStyles,
    bookId,
    isTextBook,
    markerStyle.wordMatchScope,
    markerStyleRef,
    supportsWordMarkers,
  ]);

  useEffect(() => {
    if (!bookId || isTextBook) return;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (!detail?.bookId || detail.bookId === bookId) refreshAnnotations().catch(() => {});
    };
    window.addEventListener("lookup-mark-changed", refresh);
    return () => window.removeEventListener("lookup-mark-changed", refresh);
  }, [bookId, isTextBook, refreshAnnotations]);

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (!detail?.bookId || detail.bookId === bookId) refreshAnnotations().catch(() => {});
    };
    window.addEventListener("lookup-record-changed", refresh);
    window.addEventListener("vocab-changed", refresh);
    window.addEventListener("highlight-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("lookup-record-changed", refresh);
      window.removeEventListener("vocab-changed", refresh);
      window.removeEventListener("highlight-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [bookId, refreshAnnotations]);

  return {
    applyAnnotations,
    applyFoliateMarkerStyles,
    autoMarkersRef,
    clearReadingHighlight,
    flashNavigationTarget,
    refreshAnnotations,
    resetAnnotationState,
    showReadingHighlight,
    wordMarkExceptionsRef,
    wordMarkWordsRef,
  };
}
