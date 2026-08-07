import { getThemeStyles } from "./reader-settings.ts";
import type { ReaderTheme } from "./reader-settings.ts";
import type { MarkerStyleConfig, MarkerVisualStyle } from "./marker-style.ts";

/**
 * Every mark colour the reader does not get to choose — the vocabulary states,
 * the range being read aloud, and the fixed set a saved highlight can be named.
 *
 * It lives here rather than beside the renderer because the settings preview
 * has to draw the same marks the book does. A preview reading from its own copy
 * would be a picture of a palette instead of the palette, and would drift the
 * first time one of these changed.
 */

/**
 * Sentinels, not colours. A word marker travels through foliate as an
 * annotation's `color`, which is a string, so these occupy that field and are
 * swapped for a real style at draw time.
 *
 * `lookup` is the exception: a lookup mark is drawn with whatever the reader set
 * the *automatic* style to, so its annotation carries `styleKind: "automatic"`
 * and is styled from that before its colour is ever read. The sentinel is only
 * there to keep it out of the saved-highlight path.
 */
export const wordMarkerColor = {
  lookup: "__lookup__",
  vocabNew: "__vocab_new__",
  learning: "__learning__",
  familiar: "__familiar__",
} as const;

/** A mark whose colour is the app's to choose, and the reader's to avoid. */
export type SystemMarkId = "reading" | "vocabNew" | "learning" | "familiar";

export interface SystemMark {
  id: SystemMarkId;
  color: string;
  /** As drawn, 0 to 1 — not the 0-to-100 the reader's own styles are stored in. */
  opacity: number;
  /** A wash covers a range; an underline sits under a word. */
  shape: "wash" | "underline";
  dashed?: boolean;
  /**
   * Blended into the page rather than laid flat over it, so the words underneath
   * keep their contrast: darkened into light paper, lightened into a dark one.
   * See `washBlendMode` for why the direction has to follow the page.
   */
  blendIntoPage?: boolean;
}

/**
 * The vocabulary marks read as one progression rather than three unrelated
 * colours: a new word is the warmest and most solid, each step towards mastery
 * drains the hue out of it, and a familiar word is a grey dash you can read
 * straight past without it ever having claimed your attention.
 *
 * Mastery has a fourth tier and it is deliberately not here. `mastered` is
 * drawn as nothing at all — the progression ends by disappearing, which is the
 * only ending that means "you are done with this word". The three colours below
 * are the ones that were tuned against every paper theme; the tiers moved under
 * them, the hexes did not.
 *
 * The reading wash is the only cold colour here, and the only one that is not a
 * property of the text — it marks where the voice currently is.
 */
export const SYSTEM_MARKS: readonly SystemMark[] = [
  { id: "reading", color: "#7DD3FC", opacity: 0.42, shape: "wash", blendIntoPage: true },
  { id: "vocabNew", color: "#D97706", opacity: 0.85, shape: "underline" },
  { id: "learning", color: "#2F9E8F", opacity: 0.85, shape: "underline" },
  { id: "familiar", color: "#94A3B8", opacity: 0.9, shape: "underline", dashed: true },
];

export const systemMark = Object.fromEntries(
  SYSTEM_MARKS.map((mark) => [mark.id, mark]),
) as Record<SystemMarkId, SystemMark>;

/** The style each word-marker sentinel draws with. `lookup` is absent by design. */
export const wordMarkerStyle: Record<string, SystemMark> = {
  [wordMarkerColor.vocabNew]: systemMark.vocabNew,
  [wordMarkerColor.learning]: systemMark.learning,
  [wordMarkerColor.familiar]: systemMark.familiar,
};

/**
 * Which mark a saved word wears, by mastery tier, and which switch decides
 * whether it is drawn at all.
 *
 * Every tier migration 038 defines is named here, `mastered` included — as
 * `null`, which is an answer rather than a gap. Reading the mark off "everything
 * that is not mastered or learning" is what painted a `familiar` word with the
 * brand-new-word colour for as long as the tier existed, and turned it off with
 * the new-word switch. A tier this table does not name therefore draws nothing:
 * an unmarked word is a smaller wrong answer than a word wearing a claim about
 * itself that is false, and a fifth tier can no longer land in the new-word
 * bucket by default.
 *
 * `familiar` and `learning` share `showLearningMarkers` on purpose. The question
 * a visibility switch answers is "do I want to see the words I am still working
 * on", and a familiar word is still one — a fourth switch would be asking the
 * same question twice.
 */
export const WORD_MARKER_BY_MASTERY: Record<
  string,
  { color: string; visibility: MarkerVisibilityKey } | null
> = {
  new: { color: wordMarkerColor.vocabNew, visibility: "showNewVocabMarkers" },
  learning: { color: wordMarkerColor.learning, visibility: "showLearningMarkers" },
  familiar: { color: wordMarkerColor.familiar, visibility: "showLearningMarkers" },
  mastered: null,
};

/**
 * The mark a word of this tier wears, or `null` for no mark at all.
 *
 * A word with no tier recorded has only just been saved, which is exactly what
 * `new` means — so an absent tier resolves to the new-word mark rather than to
 * nothing.
 */
export function wordMarkerForMastery(mastery: string | null | undefined) {
  return WORD_MARKER_BY_MASTERY[mastery || "new"] ?? null;
}

export const READING_HIGHLIGHT_COLOR = systemMark.reading.color;
export const READING_HIGHLIGHT_OPACITY = systemMark.reading.opacity;

/**
 * Which vocabulary marks the text is allowed to show, in the order they are
 * offered — the lookup mark first because it is the one a reader meets without
 * asking for it, then the two states a marked word can be in.
 *
 * Three switches for four mastery tiers, and that is the whole design: a
 * mastered word carries no mark, so there is nothing to switch, and `familiar`
 * rides with `learning` because both are words the reader is still working on.
 * See `WORD_MARKER_BY_MASTERY` for the tier-to-mark half of the same answer.
 *
 * This lives beside the palette rather than beside either screen that edits it:
 * the Settings page sets the global default and the reader panel overrides it
 * per book, and both have to agree on the key names, the order and the value an
 * absent row means. A second copy of that answer is how these ended up
 * per-book-only in the first place.
 */
export const MARKER_VISIBILITY_KEYS = [
  "showLookupMarkers",
  "showNewVocabMarkers",
  "showLearningMarkers",
] as const;

export type MarkerVisibilityKey = typeof MARKER_VISIBILITY_KEYS[number];

export type MarkerVisibility = Record<MarkerVisibilityKey, boolean>;

/** The row in the global `settings` table each switch is stored in. */
export const MARKER_VISIBILITY_SETTING_KEY: Record<MarkerVisibilityKey, string> = {
  showLookupMarkers: "show_lookup_markers",
  showNewVocabMarkers: "show_new_vocab_markers",
  showLearningMarkers: "show_learning_markers",
};

/**
 * What a missing row means — and it has to keep meaning exactly this, because
 * every install that predates the global layer has all three rows missing. These
 * are the values the reader hardcoded before there was anywhere to write them
 * down; `DEFAULT_MARKER_VISIBILITY` in `useReaderSettingsSync` is the same set,
 * and `tests/marker-visibility.test.ts` fails if the two ever drift.
 *
 * All three are on, and there is no odd one out any more. The switch that used
 * to be off by default governed mastered words, on the reasoning that a word you
 * have finished learning is a word you should be able to read straight past —
 * which is now true unconditionally, because a mastered word is never marked at
 * all. Every switch that is left governs a word still being worked on, and those
 * are worth seeing.
 *
 * A stale `show_mastered_markers` row survives in the `settings` table of any
 * install that ever turned it on. Nothing reads it, which is the intended end
 * state — do not add anything that does.
 */
export const DEFAULT_MARKER_VISIBILITY: MarkerVisibility = {
  showLookupMarkers: true,
  showNewVocabMarkers: true,
  showLearningMarkers: true,
};

/**
 * The three switches as the settings table has them. Anything that is not the
 * string `"true"` or `"false"` is treated as no answer at all rather than as
 * `false` — a truncated write or a hand-edited database must not silently turn
 * a mark off.
 */
export function resolveMarkerVisibility(
  settings: Record<string, string | undefined>,
): MarkerVisibility {
  const resolved = {} as MarkerVisibility;
  for (const key of MARKER_VISIBILITY_KEYS) {
    const raw = settings[MARKER_VISIBILITY_SETTING_KEY[key]];
    resolved[key] = raw === "true" ? true : raw === "false" ? false : DEFAULT_MARKER_VISIBILITY[key];
  }
  return resolved;
}

export interface MarkerVisibilitySummary {
  /** `partial` is the only one that has to name a number. */
  state: "all" | "none" | "partial";
  shown: number;
  total: number;
}

/** Which of the three sentences the heading gets to say, and the count it needs. */
export function markerVisibilitySummary(visibility: MarkerVisibility): MarkerVisibilitySummary {
  const total = MARKER_VISIBILITY_KEYS.length;
  const shown = MARKER_VISIBILITY_KEYS.filter((key) => visibility[key]).length;
  return { state: shown === total ? "all" : shown === 0 ? "none" : "partial", shown, total };
}

/** The colours a saved highlight can be named. Not configurable. */
export const savedHighlightColor: Record<string, string> = {
  yellow: "#FBBF24",
  green: "#34D399",
  blue: "#60A5FA",
  pink: "#F472B6",
  purple: "#A78BFA",
};

export const SAVED_HIGHLIGHT_OPACITY = 0.35;

/**
 * The passage a margin note (P3.2) was written about.
 *
 * Deliberately the faintest mark the reader can be shown: its whole job is to
 * let you trace a card back to its sentence *when you go looking*, not to be
 * noticed while reading. It is drawn as a hairline under the glyphs rather than
 * a wash through them, so it competes with nothing — a saved highlight, the
 * read-aloud wash and the vocabulary underlines all sit above it in weight, and
 * `useFoliateAnnotations` never draws it where one of those already is.
 *
 * The colour has to follow the page for the same reason every other mark's
 * does: the reader accent is a dark violet, and on the dark and Gray papers a
 * dark violet hairline is not a faint mark, it is no mark. `NOTE_ANCHOR_MARK`
 * keeps one entry per direction and `noteAnchorMarkColor` picks between them the
 * way `washBlendMode` picks a blend — by how much light the paper has.
 */
/**
 * A sentinel in the same spirit as `wordMarkerColor`: a note anchor's colour is
 * decided at draw time from the page it lands on, so the annotation's `color`
 * field carries no colour at all. It only has to be a value no saved highlight
 * can be named, so the highlight path can never claim one of these.
 */
export const NOTE_ANCHOR_MARK_SENTINEL = "__note_anchor__";

export const NOTE_ANCHOR_MARK = {
  /** Papers with light to take away. */
  onLight: "#7C3AED",
  /** Papers that need light added — the dark theme, and the Gray mid-tone. */
  onDark: "#C4B5FD",
} as const;

/**
 * Low enough that the hairline reads as a tint of the paper rather than a line
 * drawn on it, and still clear of `MARK_LEGIBILITY_THRESHOLD` on every theme.
 */
export const NOTE_ANCHOR_MARK_OPACITY = 0.18;

/** Which of the two note-anchor tones this page can actually show. */
export function noteAnchorMarkColor(backdrop: string): string {
  return washBlendMode(backdrop) === "multiply" ? NOTE_ANCHOR_MARK.onLight : NOTE_ANCHOR_MARK.onDark;
}

function channels(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function toHex(channel: number) {
  return Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0");
}

/** The blend modes a mark can be drawn with — the CSS names, as passed straight to `mix-blend-mode`. */
export type BlendMode = "normal" | "multiply" | "screen";

/**
 * What a colour actually looks like once it is on the page: the hex the reader
 * picked, thinned to its opacity over the paper it sits on.
 *
 * Comparing raw hex values instead is the mistake this exists to prevent. A
 * marker blue and the read-aloud sky measure far apart at full strength and
 * still land within a few points of each other once both are washes — which is
 * the only form either of them is ever seen in.
 */
export function blendOver(color: string, opacity: number, backdrop: string, blend: BlendMode = "normal") {
  const source = channels(color);
  const base = channels(backdrop);
  const mixed = source.map((channel, index) => {
    const over = blend === "multiply"
      ? (channel * base[index]) / 255
      : blend === "screen"
        ? 255 - ((255 - channel) * (255 - base[index])) / 255
        : channel;
    return over * opacity + base[index] * (1 - opacity);
  });
  return `#${mixed.map(toHex).join("")}`.toUpperCase();
}

/**
 * Which way a wash has to be blended into this page to be seen at all.
 *
 * Multiply can only take light away and screen can only add it, so the choice
 * has to follow the paper. Multiplied into the dark theme's #1b1b1f the
 * read-aloud sky landed 10 away from the page — there was no light in the page
 * left to take, and the sentence being read aloud was simply not marked.
 * Screened into it, the same wash lands 232 away; multiplied into #FAF7F0 it
 * keeps the 98 it always had. Either way the words underneath move with the
 * page rather than against it, which is the point of blending at all.
 */
export function washBlendMode(backdrop: string): BlendMode {
  const [r, g, b] = channels(backdrop);
  // Rec. 709 luma — green carries most of the light, as the eye reads it.
  return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 128 ? "multiply" : "screen";
}

/** How a system mark is drawn on this page. Only a wash blends into it. */
export function markBlendMode(mark: SystemMark, backdrop: string): BlendMode {
  return mark.blendIntoPage ? washBlendMode(backdrop) : "normal";
}

/**
 * Redmean distance — a cheap approximation of how far apart two colours look,
 * which plain RGB distance is not. Good enough to decide "these two are close
 * enough to be confusing" without pulling in a colour library for it.
 */
export function colorDistance(a: string, b: string) {
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const mean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt((2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db);
}

/**
 * Below this, two colours are close enough that a reader would have to stop and
 * work out which is which. Tuned so the presets clear it against every system
 * mark and the teal that shipped as a preset does not.
 */
export const MARK_COLLISION_THRESHOLD = 62;

/**
 * The bar two marks are held to when something other than colour already tells
 * them apart — an underline under a wash, or a wash under an underline. A
 * second channel does most of the work the colour would otherwise have to do on
 * its own, so the colours only have to stay far enough apart to read as a
 * different mark rather than a different shade of the same one.
 *
 * Deliberately still well above `MARK_LEGIBILITY_THRESHOLD`: below that the two
 * would not be seen as different colours at all, and the cue would be carrying
 * the whole distinction.
 */
export const MARK_CUED_COLLISION_THRESHOLD = 36;

/**
 * Below this, a mark is not on the page so much as a rumour of one.
 *
 * Redmean weights sum to about 9 near mid-grey, so 24 is roughly a shift of 8
 * in every channel — the smallest step that still reads as a tint over the
 * paper rather than as the paper. The automatic mark is the reason the bar is
 * this low: it is meant to be read straight past, and warning about it would be
 * warning about it working.
 */
export const MARK_LEGIBILITY_THRESHOLD = 24;

/**
 * The pages a mark has to survive. Every theme that ships a colour of its own is
 * here, the Gray one included: it is the mid-tone the other three are not, and a
 * wash that clears the paper and the dark theme can still vanish into it.
 *
 * Custom is absent because its colour is the reader's — there is nothing to
 * check until they pick one.
 */
export const MARK_BACKDROPS = ["original", "paper", "quiet", "dark"] as const satisfies readonly ReaderTheme[];

const BACKDROPS = MARK_BACKDROPS.map((theme) => getThemeStyles(theme).body);

/**
 * Which system marks this style would be mistaken for.
 *
 * Shape is checked before colour, and it is the more important half: a wash
 * across a range and an underline beneath a word do not compete even in the
 * same hue. So a manual style only has to avoid the vocabulary colours once its
 * underline is switched on — and until then it is free to be any colour at all.
 */
export function markCollisions(style: MarkerVisualStyle): SystemMarkId[] {
  return SYSTEM_MARKS.filter((mark) => {
    if (!(mark.shape === "wash" ? style.background : style.underline)) return false;
    // A background carries the opacity the reader set; an underline is drawn at
    // full strength whatever that slider says.
    const opacity = mark.shape === "wash" ? style.opacity / 100 : 1;
    // A treatment the system mark does not carry is a second channel, and the
    // automatic style ships with exactly that: an underline no wash has. It
    // lowers the bar rather than removing it — two marks that differ only in
    // whether they are underlined still have to be different colours.
    const threshold = (mark.shape === "wash" ? style.underline : style.background)
      ? MARK_CUED_COLLISION_THRESHOLD
      : MARK_COLLISION_THRESHOLD;
    return BACKDROPS.some((backdrop) => {
      const drawn = blendOver(style.color, opacity, backdrop);
      const against = blendOver(mark.color, mark.opacity, backdrop, markBlendMode(mark, backdrop));
      // A mark you can hardly see cannot be mistaken for something else. That is
      // a question about visibility, not about confusion, so it is asked at the
      // legibility bar — the collision bar is far higher, and asking it here
      // once cost the Gray theme every comparison on it.
      if (colorDistance(drawn, backdrop) < MARK_LEGIBILITY_THRESHOLD) return false;
      if (colorDistance(against, backdrop) < MARK_LEGIBILITY_THRESHOLD) return false;
      return colorDistance(drawn, against) < threshold;
    });
  }).map((mark) => mark.id);
}

/**
 * Whether the reader's two own marks would be mistaken for each other.
 *
 * `markCollisions` only ever measures a style against the palette the app fixed,
 * so the one pair it cannot see is the pair most likely to be confused: the
 * manual mark and the automatic one share a page, and land on the same word as
 * often as not. Nothing stops a reader from tuning one to within a shade of the
 * other, and until now nothing said so.
 *
 * The reasoning is the one used against the system marks, because the eye does
 * not keep a separate rule for the marks the app chose: shape first — a wash and
 * an underline do not compete — then the colours as the page actually shows
 * them, then a treatment only one side carries as a second channel that lowers
 * the bar without lifting it. Weight is deliberately not counted as such a
 * channel: `markerOverlayStyle` strips it from whole-word markers unless the
 * reader opts into reflowing the page, so it is not there to be relied on.
 */
export function marksLookAlike(a: MarkerVisualStyle, b: MarkerVisualStyle): boolean {
  return (["background", "underline"] as const).some((shape) => {
    if (!a[shape] || !b[shape]) return false;
    // A background is worn at the opacity the reader set; an underline is drawn
    // at full strength whatever that slider says.
    const strength = (style: MarkerVisualStyle) => (shape === "background" ? style.opacity / 100 : 1);
    const cue = shape === "background" ? "underline" : "background";
    const threshold = a[cue] === b[cue] ? MARK_COLLISION_THRESHOLD : MARK_CUED_COLLISION_THRESHOLD;
    return BACKDROPS.some((backdrop) => {
      const drawnA = blendOver(a.color, strength(a), backdrop);
      const drawnB = blendOver(b.color, strength(b), backdrop);
      // A mark you can hardly see cannot be mistaken for the other one — that is
      // a question about visibility, and it is asked at the legibility bar.
      if (colorDistance(drawnA, backdrop) < MARK_LEGIBILITY_THRESHOLD) return false;
      if (colorDistance(drawnB, backdrop) < MARK_LEGIBILITY_THRESHOLD) return false;
      return colorDistance(drawnA, drawnB) < threshold;
    });
  });
}

/**
 * The same question asked of a saved config, where it has an answer the two
 * styles alone do not.
 *
 * With `automaticFollowsManual` on, the automatic style *is* the manual one —
 * `effectiveAutomaticMarkerStyle` hands back the very object. Comparing it with
 * its source is comparing a colour with itself, and the warning would be lit for
 * as long as the toggle was. That the two marks are identical is what the reader
 * asked for; it is the setting working, not something to complain about.
 */
export function configuredMarksLookAlike(config: MarkerStyleConfig): boolean {
  if (config.automaticFollowsManual) return false;
  return marksLookAlike(config.manual, config.automatic);
}

/**
 * The themes this style would be invisible on — a different failure from looking
 * like another mark, and the one no amount of separation from the palette fixes.
 *
 * The Gray theme is what makes this worth checking: it sits between the light
 * themes and the dark one, so a colour chosen to show up on paper can land
 * within a few points of it. The automatic default used to.
 */
export function markInvisibleOn(style: MarkerVisualStyle): ReaderTheme[] {
  // Weight is not a colour. A bold word carries on any page, so a style using it
  // cannot be argued out of existence by a swatch.
  if (style.bold) return [];
  // Whichever treatment shows the colour most: an underline is drawn at full
  // strength whatever the opacity slider says, only a background is thinned.
  const strength = Math.max(style.underline ? 1 : 0, style.background ? style.opacity / 100 : 0);
  return MARK_BACKDROPS.filter((theme) => {
    const backdrop = getThemeStyles(theme).body;
    return colorDistance(blendOver(style.color, strength, backdrop), backdrop) < MARK_LEGIBILITY_THRESHOLD;
  });
}
