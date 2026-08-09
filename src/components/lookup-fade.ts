import type { MarkerVisualStyle } from "./marker-style.ts";

/**
 * How much of a lookup mark is left, as the backend reports it per occurrence.
 *
 * `gone` still travels in the list: the reader has to know a word was looked up
 * here even when nothing is drawn over it, so selection and the occurrence
 * bookkeeping keep working. Only the drawing stops.
 */
export type LookupFade = "full" | "faded" | "gone";

/**
 * The one number the fade is worth, and it is a ratio rather than an opacity.
 *
 * A lookup mark is drawn with whatever the reader set the *automatic* style to
 * — colour, treatments, and an opacity they can put anywhere between 5 and 100.
 * A hardcoded faded opacity would ignore that: someone who tuned their marks
 * down to 8% would find the "faded" step darker than their own full-strength
 * one. So the middle step is a fraction of whatever they chose, and stays in
 * proportion to it at every setting.
 *
 * 55% rather than a half, because the step has to read as *the same mark, later*
 * — far enough down to be noticed as a change, not so far that the word looks
 * unmarked while the mark is still meant to be doing its job.
 */
export const FADED_LOOKUP_STRENGTH = 0.55;

/**
 * What is left to draw for this occurrence, or `null` for nothing at all.
 *
 * `neverFade` is the reader's opt-out (`lookup_markers_never_fade`), and it is
 * checked before anything else: with it on, every lookup mark is a `full` one,
 * including the occurrences the backend has already written off as `gone`.
 * That is the whole point of the switch — someone using these marks as reading
 * notes wants the ones they have read past most of all.
 */
export function lookupFadeLevel(
  fade: LookupFade,
  neverFade: boolean,
): "full" | "faded" | null {
  if (neverFade) return "full";
  if (fade === "gone") return null;
  return fade === "faded" ? "faded" : "full";
}

/**
 * The reader's automatic style, thinned by one step.
 *
 * Only the opacity moves. Colour and treatments are untouched on purpose: a
 * lookup mark keeps its solid underline for its whole life, because a neutral
 * dashed underline already means something else in this app — a `familiar`
 * saved word (see `SYSTEM_MARKS`) — and two marks that look alike and mean
 * different things is a worse page than a mark that is merely fainter.
 */
export function fadedLookupMarkStyle(style: MarkerVisualStyle): MarkerVisualStyle {
  // Two decimals, because the raw product is a binary float: 100 × 0.55 is
  // 55.00000000000001, which reaches the SVG overlay as an `opacity` of
  // "0.5500000000000001". Rounding to whole percent instead would flatten the
  // bottom of the range, where 5% has only 2.75 to give.
  return { ...style, opacity: Math.round(style.opacity * FADED_LOOKUP_STRENGTH * 100) / 100 };
}

export interface LookupMarkRender {
  /** The style to draw with — the automatic style, or a thinned copy of it. */
  style: MarkerVisualStyle;
  /**
   * 0–1, applied to the underline only. The background already carries the
   * fade in `style.opacity`; an underline is drawn at full strength whatever
   * that number says, so it needs the step handed to it separately.
   */
  underlineOpacity: number;
}

/**
 * Fade tier + the reader's own style + the opt-out → what actually gets drawn.
 *
 * The single answer both renderers ask: the foliate overlay (SVG rects) and the
 * text-book renderer (inline CSS) draw a lookup mark by completely different
 * means, and the one thing they must not disagree about is how faint it is.
 */
export function lookupMarkRender(
  style: MarkerVisualStyle,
  fade: LookupFade,
  neverFade: boolean,
): LookupMarkRender | null {
  const level = lookupFadeLevel(fade, neverFade);
  if (level === null) return null;
  return level === "full"
    ? { style, underlineOpacity: 1 }
    : { style: fadedLookupMarkStyle(style), underlineOpacity: FADED_LOOKUP_STRENGTH };
}
