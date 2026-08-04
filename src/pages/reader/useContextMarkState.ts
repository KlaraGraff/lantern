import { useCallback, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Highlight } from "../../hooks/useBookmarks";
import type { ReaderInteraction } from "../../components/reader-interaction";
import type { MarkerStyleConfig } from "../../components/marker-style";
import type {
  LookupOccurrenceMark,
  WordMarkException,
  WordMarkRule,
} from "./useFoliateAnnotations";
import { highlightMutationPlan, highlightRemovalPlan } from "./highlight-plans";

export interface ContextMarkState {
  /** Marked by any of the three mechanisms — what the menu's toggle reads. */
  selectionFullyMarked: boolean;
  manualSelectionFullyMarked: boolean;
  hasManualSelectionMark: boolean;
  hasLookupOccurrenceMark: boolean;
  hasBookWordMark: boolean;
  /**
   * The rule that actually marks the clicked word. With form matching on it may
   * be a rule on another form, and every whole-book action has to address that
   * rule rather than the form the reader happened to click.
   */
  bookWordMarkWord: string | null;
  bookWordMarkExcluded: boolean;
  loading: boolean;
}

/**
 * Whether the selection under the context menu is already marked, and by which
 * of the three mechanisms that can mark it: a manual highlight, a lookup
 * occurrence mark, or a whole-book word-mark rule.
 *
 * Answering takes four backend round-trips, so every open carries a request
 * token and a late answer for a superseded menu is dropped rather than painted
 * over the current one. The same token is bumped whenever the menu closes,
 * which is why the ref is shared with the foliate view.
 */
export function useContextMarkState(
  bookId: string | undefined,
  markerStyleRef: RefObject<MarkerStyleConfig>,
) {
  const contextMenuRequestRef = useRef(0);
  const [selectionFullyMarked, setSelectionFullyMarked] = useState(false);
  const [manualSelectionFullyMarked, setManualSelectionFullyMarked] = useState(false);
  const [hasManualSelectionMark, setHasManualSelectionMark] = useState(false);
  const [hasLookupOccurrenceMark, setHasLookupOccurrenceMark] = useState(false);
  const [hasBookWordMark, setHasBookWordMark] = useState(false);
  const [bookWordMarkWord, setBookWordMarkWord] = useState<string | null>(null);
  const [bookWordMarkExcluded, setBookWordMarkExcluded] = useState(false);
  const [loading, setLoading] = useState(false);

  const clearMarkFlags = useCallback(() => {
    setSelectionFullyMarked(false);
    setManualSelectionFullyMarked(false);
    setHasManualSelectionMark(false);
    setHasLookupOccurrenceMark(false);
    setHasBookWordMark(false);
    setBookWordMarkWord(null);
    setBookWordMarkExcluded(false);
  }, []);

  /** Invalidate any in-flight answer — the menu this state described is gone. */
  const bumpContextMenuRequest = useCallback(() => {
    contextMenuRequestRef.current += 1;
  }, []);

  /** A menu that never asks the backend: shown with everything unmarked. */
  const resetMarkState = useCallback(() => {
    contextMenuRequestRef.current += 1;
    setLoading(false);
    clearMarkFlags();
  }, [clearMarkFlags]);

  /** The quick-lookup path, which opens a card instead of a menu. */
  const dismissMarkState = useCallback(() => {
    contextMenuRequestRef.current += 1;
    setLoading(false);
  }, []);

  const loadMarkState = useCallback((interaction: ReaderInteraction) => {
    const requestToken = ++contextMenuRequestRef.current;
    setLoading(Boolean(bookId));
    clearMarkFlags();
    if (!bookId) {
      setLoading(false);
      return;
    }
    Promise.all([
      invoke<Highlight[]>("list_highlights", { bookId }),
      interaction.kind === "word"
        ? invoke<(WordMarkRule & { display_word: string }) | null>("find_covering_word_mark_rule", {
          bookId,
          word: interaction.text,
          matchForms: markerStyleRef.current.wordMatchScope === "forms",
        })
        : Promise.resolve(null),
      interaction.kind === "word"
        ? invoke<WordMarkException[]>("list_word_mark_exceptions", { bookId })
        : Promise.resolve([]),
      interaction.kind === "word"
        ? invoke<LookupOccurrenceMark[]>("list_lookup_occurrence_marks", { bookId })
        : Promise.resolve([]),
    ]).then(async ([highlights, coveringRule, exceptions, occurrences]) => {
      if (contextMenuRequestRef.current !== requestToken) return;
      const [plan, removalPlan] = await Promise.all([
        highlightMutationPlan(interaction, highlights),
        highlightRemovalPlan(interaction, highlights),
      ]);
      if (contextMenuRequestRef.current !== requestToken) return;
      const hasBookRule = Boolean(coveringRule);
      // An exclusion is stored under the word on the page, not the rule's
      // word, because that is the only key the marker painter can match an
      // occurrence against.
      const isExcluded = hasBookRule && exceptions.some((exception) => (
        exception.excluded
        && exception.normalized_word === interaction.normalizedText
        && exception.location === interaction.location
      ));
      const manualFullyMarked = Boolean(plan?.fullyHighlighted);
      const manualSelectionMark = Boolean(removalPlan?.removeIds.length);
      const lookupOccurrence = occurrences.some((mark) => (
        mark.enabled && mark.location === interaction.location
      ));
      setManualSelectionFullyMarked(manualFullyMarked);
      setHasManualSelectionMark(manualSelectionMark);
      setHasLookupOccurrenceMark(lookupOccurrence);
      setHasBookWordMark(hasBookRule);
      setBookWordMarkWord(coveringRule?.display_word ?? null);
      setBookWordMarkExcluded(isExcluded);
      setSelectionFullyMarked(
        manualFullyMarked || lookupOccurrence || (hasBookRule && !isExcluded),
      );
      setLoading(false);
    }).catch(() => {
      if (contextMenuRequestRef.current === requestToken) setLoading(false);
    });
  }, [bookId, clearMarkFlags, markerStyleRef]);

  const markState: ContextMarkState = {
    selectionFullyMarked,
    manualSelectionFullyMarked,
    hasManualSelectionMark,
    hasLookupOccurrenceMark,
    hasBookWordMark,
    bookWordMarkWord,
    bookWordMarkExcluded,
    loading,
  };

  return {
    markState,
    contextMenuRequestRef,
    bumpContextMenuRequest,
    resetMarkState,
    dismissMarkState,
    loadMarkState,
  };
}
