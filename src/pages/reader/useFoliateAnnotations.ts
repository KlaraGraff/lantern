import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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
  NOTE_ANCHOR_MARK_OPACITY,
  NOTE_ANCHOR_MARK_SENTINEL,
  READING_HIGHLIGHT_COLOR,
  READING_HIGHLIGHT_OPACITY,
  SAVED_HIGHLIGHT_OPACITY,
  noteAnchorMarkColor,
  savedHighlightColor,
  washBlendMode,
  wordMarkerColor,
  wordMarkerStyle,
} from "../../components/mark-palette";
import {
  installCustomFontFacesInDocument,
  type CustomFontRecord,
} from "../../components/custom-fonts";
import { getFontFamily, getReaderMeasure } from "../../components/reader-settings";
import { getReaderCSS, getReaderThemeVars } from "./reader-theme";
import { expandWordForms } from "../../components/word-forms";
import type { AnnotationStyleKind, FoliateView } from "./foliate-types";
import {
  cleanupPassiveVocabAnnotations,
  installPassiveVocabAnnotations,
  isNarrowPassiveVocabViewport,
  passiveVocabLabel,
  selectPassiveVocab,
  type PassiveVocabSettings,
} from "../../components/passive-vocab";
import {
  cleanupChapterEndHint,
  installChapterEndHint,
  shouldShowChapterEndHint,
} from "../../components/chapter-end-hint";
import { notifySettingsChanged } from "../../components/settings-events";

// Reader.tsx has its own copy of this pair for the same reason: a standalone
// reader window (opened from the shelf, one book per window) has no library
// list of its own, so "go review" there means closing the window rather than
// routing within it. Duplicated here instead of threaded through as a prop
// because this hook is the only place that needs it, and Reader.tsx is not a
// file this feature is allowed to touch.
const chapterEndHintAppWindow = getCurrentWebviewWindow();
const isStandaloneReaderWindow = chapterEndHintAppWindow.label.startsWith("reader-");

export interface VocabMarker {
  cfi: string | null;
  mastery: string;
  definition?: string | null;
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

/** Just enough of a margin note (P3.2) to mark the passage it was written about. */
export interface NoteAnchorMark {
  location: string | null;
}

interface NoteAnchorPage { notes: NoteAnchorMark[] }

/**
 * The rail loads a page of notes at a time and so does this: a book with
 * thousands of notes must not stall the reader's first paint to mark them, and
 * the ones past this bound are on pages nobody is looking at yet.
 */
const NOTE_ANCHOR_LIMIT = 500;

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
  annotation: {
    color: string;
    styleKind?: AnnotationStyleKind;
    /**
     * How much of a continuously-read sentence the voice has already spoken,
     * 0–1. Absent or `null` means the engine reports no word timings, and the
     * whole sentence is drawn as one shade rather than a guessed split.
     */
    progress?: number | null;
  };
  range?: Range;
}

/** Spoken text keeps the established weight; what is still ahead sits back. */
const CONTINUOUS_SPOKEN_OPACITY = "0.42";
const CONTINUOUS_AHEAD_OPACITY = "0.16";

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
  if (annotation.styleKind === "continuous") {
    const progress = typeof annotation.progress === "number" && Number.isFinite(annotation.progress)
      ? Math.min(1, Math.max(0, annotation.progress))
      : null;
    draw((rects) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("fill", annotation.color);
      group.style.mixBlendMode = washBlendMode(pageBackdrop());
      const boxes = Array.from(rects);
      // The split is measured along the underline, not in characters: rects are
      // what the renderer gives us, and their widths already track the glyphs
      // they cover — including across a line break, where the sentence arrives
      // as two boxes and a character count would say nothing about either.
      const total = boxes.reduce((sum, box) => sum + box.width, 0);
      // `null` progress paints the whole sentence as spoken, which is the shade
      // this highlight has always used. An unsplit underline is the honest
      // fallback; a zero-width spoken part would claim the voice had not started.
      let spokenLeft = progress === null ? total : total * progress;
      for (const { left, top, height, width } of boxes) {
        const inset = glyphInset(height, boxHeight);
        const glyphTop = top + inset;
        const glyphHeight = height - inset * 2;
        const y = String(glyphTop + glyphHeight * 0.61);
        const markHeight = String(Math.max(2, glyphHeight * 0.39));
        const spoken = Math.max(0, Math.min(width, spokenLeft));
        spokenLeft -= spoken;
        const segments: [number, number, string][] = [
          [left, spoken, CONTINUOUS_SPOKEN_OPACITY],
          [left + spoken, width - spoken, CONTINUOUS_AHEAD_OPACITY],
        ];
        for (const [x, segmentWidth, opacity] of segments) {
          if (segmentWidth <= 0) continue;
          const marker = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          marker.setAttribute("x", String(x));
          marker.setAttribute("y", y);
          marker.setAttribute("height", markHeight);
          marker.setAttribute("width", String(segmentWidth));
          marker.setAttribute("opacity", opacity);
          marker.setAttribute("rx", "1");
          group.append(marker);
        }
      }
      return group;
    });
    return;
  }
  if (annotation.styleKind === "note") {
    // A hairline sitting on the baseline, not a band through the words: a note
    // anchor has to be findable when looked for and invisible when not. The
    // colour follows the paper for the reason every mark's does — see
    // `noteAnchorMarkColor`.
    const color = noteAnchorMarkColor(pageBackdrop());
    draw((rects) => {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("fill", color);
      group.setAttribute("opacity", String(NOTE_ANCHOR_MARK_OPACITY));
      for (const { left, top, height, width } of rects) {
        const baseline = top + height - glyphInset(height, boxHeight);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        line.setAttribute("x", String(left));
        line.setAttribute("y", String(baseline - 1));
        line.setAttribute("height", "1");
        line.setAttribute("width", String(width));
        group.append(line);
      }
      return group;
    });
    return;
  }
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
  passiveVocab: PassiveVocabSettings;
  readerSettingsRef: MutableRefObject<ReaderSettingsState>;
  viewRef: MutableRefObject<FoliateView | null>;
  markerStyle: MarkerStyleConfig;
  markerStyleRef: MutableRefObject<MarkerStyleConfig>;
  markMatchingWordsRef: MutableRefObject<boolean>;
  setMarkerStyle: Dispatch<SetStateAction<MarkerStyleConfig>>;
  setReaderSettings: Dispatch<SetStateAction<ReaderSettingsState>>;
  textReaderNavigateRef: MutableRefObject<((location: string, flash?: boolean) => boolean) | null>;
  currentCfiRef: MutableRefObject<string | null>;
  /** Jump-history push (P1.3) — see `useJumpHistory`. */
  pushJump: (location: string | null | undefined, label: string) => void;
  getCurrentLabel: () => string;
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
  passiveVocab,
  readerSettingsRef,
  viewRef,
  markerStyle,
  markerStyleRef,
  markMatchingWordsRef,
  setMarkerStyle,
  setReaderSettings,
  textReaderNavigateRef,
  currentCfiRef,
  pushJump,
  getCurrentLabel,
}: UseFoliateAnnotationsOptions) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const autoMarkersRef = useRef(new Map<string, FoliateMarker>());
  const appliedAnnotationsRef = useRef(new Map<string, AppliedAnnotation>());
  const navigationFlashRef = useRef(new Map<string, number>());
  const markerSnapshotRef = useRef<{
    highlights: Highlight[];
    vocab: VocabMarker[];
    lookupOccurrences: LookupOccurrenceMark[];
    noteAnchors: NoteAnchorMark[];
  } | null>(null);
  const wordMarkWordsRef = useRef<string[]>([]);
  const wordMarkExceptionsRef = useRef(new Set<string>());

  const applyAnnotations = useCallback(async (reapplyVisible = false) => {
    const view = viewRef.current;
    if (!view || !supportsManualAnnotations) return;
    const snapshot = markerSnapshotRef.current;
    if (!snapshot) return;
    const { highlights, vocab, lookupOccurrences, noteAnchors } = snapshot;
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
    // Note anchors go in first and never overwrite: foliate's overlayer is keyed
    // by CFI, so a note mark laid over a highlight would evict the highlight
    // rather than sit under it. Where a passage already carries a mark, that
    // mark is the stronger cue and the note anchor has nothing to add.
    for (const note of noteAnchors) {
      if (note.location && !desired.has(note.location)) {
        desired.set(note.location, { color: NOTE_ANCHOR_MARK_SENTINEL, styleKind: "note" });
      }
    }
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

  // "Go review" from the chapter-end line: a standalone reader window has no
  // library of its own to route within, so there it just closes back to the
  // window that does (falling back to a plain navigate if the close somehow
  // fails). The normal in-app reader hands the intent to Home the same way the
  // existing chat/vocab deep links do — via `location.state`, for Home's own
  // code to pick up.
  const reviewChapterEndHint = useCallback(() => {
    if (isStandaloneReaderWindow) {
      chapterEndHintAppWindow.close().catch(() => navigate("/"));
    } else {
      navigate("/", { state: { openReview: true } });
    }
  }, [navigate]);

  // "Don't show again": takes effect immediately and everywhere, not just on
  // the page the reader is looking at — the setting is global, so every
  // currently loaded section document has its line pulled the moment this
  // fires, not just on the next per-document install.
  const dismissChapterEndHint = useCallback(() => {
    const next = { ...readerSettingsRef.current, chapterEndReviewHint: false };
    readerSettingsRef.current = next;
    setReaderSettings(next);
    const values = { chapter_end_review_hint: "false" };
    invoke("set_settings_bulk", { settings: values }).catch(() => {});
    notifySettingsChanged(values).catch(() => {});
    for (const { doc } of viewRef.current?.renderer?.getContents?.() ?? []) {
      if (doc) cleanupChapterEndHint(doc);
    }
  }, [readerSettingsRef, setReaderSettings, viewRef]);

  const applyPassiveVocabAnnotations = useCallback((loaded?: { doc: Document; index: number }) => {
    const view = viewRef.current;
    if (!view) return;
    const contents = loaded ? [loaded] : (view.renderer?.getContents?.() ?? []);
    const vocab = markerSnapshotRef.current?.vocab ?? [];
    // Which of the three stages each saved word is in on this page: the gloss
    // itself, a bare marker, or nothing at all. Mastery decides the stage; the
    // limit only caps how many glosses one screen may carry.
    const stages = selectPassiveVocab(
      vocab.filter((word): word is VocabMarker & { cfi: string } => Boolean(word.cfi)),
      passiveVocab.limit,
    );
    const annotations = vocab.flatMap((word) => {
      const stage = word.cfi ? stages.get(word.cfi) : undefined;
      if (!word.cfi || !stage) return [];
      const label = passiveVocabLabel(word.definition);
      return label ? [{ cfi: word.cfi, label, stage }] : [];
    });
    for (const { doc, index } of contents as Array<{ doc?: Document; index?: number }>) {
      if (!doc || typeof index !== "number") continue;
      cleanupPassiveVocabAnnotations(doc);
      if (!passiveVocab.enabled || !supportsWordMarkers || !supportsReflowSettings) continue;
      installPassiveVocabAnnotations({
        doc,
        annotations,
        resolveRange: (cfi) => {
          try {
            const resolved = view.resolveCFI(cfi);
            return resolved.index === index ? resolved.anchor(doc) : null;
          } catch {
            return null;
          }
        },
        style: passiveVocab.style,
        narrowViewport: isNarrowPassiveVocabViewport(window.innerWidth),
        spread: Number(view.renderer?.getAttribute?.("max-column-count")) > 1,
      });
    }
    // A second pass over the same documents for the chapter-end line. Kept
    // separate from the loop above rather than merged into it: the line has
    // nothing to do with word density or `supportsWordMarkers`/
    // `supportsReflowSettings` (a scrolling or plain-reflow book still finishes
    // chapters), and folding the two would make one feature's gate silently
    // start applying to the other's.
    const settings = readerSettingsRef.current;
    const themeVars = getReaderThemeVars(settings.theme, settings.customTheme);
    // The reader's resolved paper palette, not the host stylesheet's CSS
    // variables — those do not reach inside a section document's iframe. The
    // fallbacks are the "original" theme's own values (`getReaderThemeVars`
    // returns `undefined` only for a theme id outside the five it knows,
    // which `ReaderSettingsState` does not allow, so these should be inert).
    const chapterEndColor = {
      muted: themeVars?.["--color-text-muted"] ?? "#71717b",
      rule: themeVars?.["--color-border-light"] ?? "rgba(0,0,0,.08)",
    };
    for (const { doc, index } of contents as Array<{ doc?: Document; index?: number }>) {
      if (!doc || typeof index !== "number") continue;
      cleanupChapterEndHint(doc);
      // "Distinct saved words in this chapter" — not a string match against the
      // TOC, but the same CFI→Range resolution the passive-vocab loop above
      // uses: a word counts for this document only if its saved location
      // actually resolves into it.
      let lookupCount = 0;
      for (const word of vocab) {
        if (!word.cfi) continue;
        try {
          const resolved = view.resolveCFI(word.cfi);
          if (resolved.index === index && resolved.anchor(doc)) lookupCount += 1;
        } catch {
          // Not resolvable at all, so certainly not resolvable into this doc.
        }
      }
      if (!shouldShowChapterEndHint(settings.chapterEndReviewHint, lookupCount)) continue;
      installChapterEndHint({
        doc,
        lookupCount,
        text: {
          line: t("reader.chapterEndHint.line", { count: lookupCount }),
          action: t("reader.chapterEndHint.action"),
          dismiss: t("reader.chapterEndHint.dismiss"),
        },
        color: chapterEndColor,
        onReview: reviewChapterEndHint,
        onDismiss: dismissChapterEndHint,
      });
    }
  }, [dismissChapterEndHint, passiveVocab, readerSettingsRef, reviewChapterEndHint, supportsReflowSettings, supportsWordMarkers, t, viewRef]);

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
        "lantern-word-marks",
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
    const [highlights, vocab, lookupOccurrences, noteAnchors] = await Promise.all([
      invoke<Highlight[]>("list_highlights", { bookId }),
      supportsWordMarkers
        ? invoke<VocabMarker[]>("list_vocab_words", { bookId })
        : Promise.resolve([]),
      invoke<LookupOccurrenceMark[]>("list_lookup_occurrence_marks", { bookId }),
      // A margin note the reader cannot find again is a note they will not
      // write. The shipped rail left the passage unmarked, so a card and its
      // sentence had nothing tying them together on the page itself.
      invoke<NoteAnchorPage>("list_notes", {
        bookId,
        anchorKind: "selection",
        word: null,
        search: null,
        updatedAfter: null,
        updatedBefore: null,
        cursor: null,
        limit: NOTE_ANCHOR_LIMIT,
      }).then((page) => page.notes).catch(() => [] as NoteAnchorMark[]),
    ]);
    markerSnapshotRef.current = { highlights, vocab, lookupOccurrences, noteAnchors };
    await applyAnnotations(reapplyVisible);
    applyFoliateMarkerStyles();
    applyPassiveVocabAnnotations();
  }, [
    applyAnnotations,
    applyFoliateMarkerStyles,
    applyPassiveVocabAnnotations,
    bookId,
    isTextBook,
    supportsManualAnnotations,
    supportsWordMarkers,
    viewRef,
  ]);

  const flashNavigationTarget = useCallback(async (cfi: string): Promise<boolean> => {
    // Centralized here rather than at each caller: every AI/vocab/cross-window
    // jump that lands on a specific spot goes through this one function, so
    // pushing once here covers all of them (P1.3). The push happens only once
    // the jump is known to be feasible — recording a jump that never happened
    // would send "return" to a place the reader never left.
    if (isTextBook) {
      const navigateText = textReaderNavigateRef.current;
      if (!navigateText) return false;
      // Read "here" before moving; afterwards it is the destination.
      const from = currentCfiRef.current;
      const label = getCurrentLabel();
      if (!navigateText(cfi, true)) return false;
      pushJump(from, label);
      return true;
    }
    const view = viewRef.current;
    if (!view || !supportsCfiNavigation) return false;
    pushJump(currentCfiRef.current, getCurrentLabel());
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
    return true;
  }, [currentCfiRef, getCurrentLabel, isTextBook, pushJump, supportsCfiNavigation, textReaderNavigateRef, viewRef]);

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

  type ContinuousHighlight = { cfi: string; paused: boolean; progress: number | null };
  const continuousHighlightDesiredRef = useRef<ContinuousHighlight | null>(null);
  const continuousHighlightRenderedRef = useRef<ContinuousHighlight | null>(null);
  const continuousHighlightQueueRef = useRef<Promise<void>>(Promise.resolve());

  const updateContinuousReadingHighlight = useCallback((next: ContinuousHighlight | null) => {
    continuousHighlightDesiredRef.current = next;
    const sync = async () => {
      const target = continuousHighlightDesiredRef.current;
      const rendered = continuousHighlightRenderedRef.current;
      if (rendered?.cfi === target?.cfi
        && rendered?.paused === target?.paused
        && rendered?.progress === target?.progress) return;
      const view = viewRef.current;
      if (rendered && view) {
        await view.deleteAnnotation({ value: rendered.cfi }).catch(() => {});
        const annotation = appliedAnnotationsRef.current.get(rendered.cfi);
        if (annotation) await view.addAnnotation({ value: rendered.cfi, ...annotation }).catch(() => {});
      }
      continuousHighlightRenderedRef.current = null;
      if (!target || target !== continuousHighlightDesiredRef.current || !view || !supportsCfiNavigation) return;
      await view.addAnnotation({
        value: target.cfi,
        color: target.paused ? "#B4AEA6" : "#B99BE5",
        styleKind: "continuous",
        progress: target.progress,
      }).catch(() => {});
      continuousHighlightRenderedRef.current = target;
    };
    continuousHighlightQueueRef.current = continuousHighlightQueueRef.current.then(sync, sync);
    return continuousHighlightQueueRef.current;
  }, [supportsCfiNavigation, viewRef]);

  const showContinuousReadingHighlight = useCallback(
    (cfi: string, paused: boolean, progress: number | null) =>
      updateContinuousReadingHighlight({ cfi, paused, progress }),
    [updateContinuousReadingHighlight],
  );
  const clearContinuousReadingHighlight = useCallback(
    () => updateContinuousReadingHighlight(null),
    [updateContinuousReadingHighlight],
  );

  const resetAnnotationState = useCallback(() => {
    const view = viewRef.current;
    for (const { doc } of view?.renderer?.getContents?.() ?? []) {
      if (doc) {
        cleanupPassiveVocabAnnotations(doc);
        cleanupChapterEndHint(doc);
      }
    }
    autoMarkersRef.current.clear();
    appliedAnnotationsRef.current.clear();
    readingHighlightRef.current = null;
    continuousHighlightDesiredRef.current = null;
    continuousHighlightRenderedRef.current = null;
    navigationFlashRef.current.clear();
    markerSnapshotRef.current = null;
    wordMarkWordsRef.current = [];
    wordMarkExceptionsRef.current.clear();
  }, [viewRef]);

  useEffect(() => {
    const refreshFonts = async (event: Event) => {
      const records = (event as CustomEvent<CustomFontRecord[]>).detail ?? [];
      const available = new Set(records.map((font) => font.id));
      setReaderSettings((current) => {
        if (!current.font.startsWith("custom-") || available.has(current.font)) return current;
        const next = { ...current, font: "system" };
        readerSettingsRef.current = next;
        // Nothing is persisted here: `delete_custom_font` already resets the
        // book's `font` row to `system`, and writing the whole state would
        // re-freeze the typography fields that follow global settings.
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
      if (supportsReflowSettings && view.renderer) {
        const measure = getReaderMeasure(
          readerSettingsRef.current,
          view.renderer.clientWidth,
          view.renderer.clientHeight,
        );
        view.renderer.setStyles?.(getReaderCSS(readerSettingsRef.current, measure.fontSize));
      }
      applyFoliateMarkerStyles();
    };
    window.addEventListener("custom-font-faces-loaded", refreshFonts);
    return () => window.removeEventListener("custom-font-faces-loaded", refreshFonts);
  }, [
    applyFoliateMarkerStyles,
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
  const passiveVocabSignature = `${passiveVocab.enabled}:${passiveVocab.style}:${passiveVocab.limit}`;
  // Theme is in here too, not just the toggle: the chapter-end line's colour is
  // baked into inline styles at install time (the iframe cannot see the host's
  // CSS variables), so a theme switch has to force a reinstall to repaint it,
  // the way `getReaderCSS` repaints everything else that reads the theme.
  const chapterEndHintSignature = `${readerSettings.chapterEndReviewHint}:${readerSettings.theme}:${readerSettings.customTheme.color}:${readerSettings.customTheme.opacity}`;
  useEffect(() => {
    refreshAnnotations(true).catch(() => {});
  }, [bookReady, chapterEndHintSignature, markerVisibility, markerStyle, passiveVocabSignature, refreshAnnotations]);

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
    window.addEventListener("note-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("lookup-record-changed", refresh);
      window.removeEventListener("vocab-changed", refresh);
      window.removeEventListener("highlight-changed", refresh);
      window.removeEventListener("note-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [bookId, refreshAnnotations]);

  return {
    applyAnnotations,
    applyPassiveVocabAnnotations,
    applyFoliateMarkerStyles,
    autoMarkersRef,
    clearContinuousReadingHighlight,
    clearReadingHighlight,
    flashNavigationTarget,
    refreshAnnotations,
    resetAnnotationState,
    showContinuousReadingHighlight,
    showReadingHighlight,
    wordMarkExceptionsRef,
    wordMarkWordsRef,
  };
}
