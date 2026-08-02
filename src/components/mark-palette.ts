import { getThemeStyles } from "./reader-settings.ts";
import type { MarkerVisualStyle } from "./marker-style.ts";

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
  mastered: "__mastered__",
} as const;

/** A mark whose colour is the app's to choose, and the reader's to avoid. */
export type SystemMarkId = "reading" | "vocabNew" | "learning" | "mastered";

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
 * The vocabulary marks read as one progression rather than four unrelated
 * colours: a new word is the warmest and most solid, each step towards mastered
 * drains the hue out of it, and mastered is a grey dash you can read straight
 * past without it ever having claimed your attention.
 *
 * The reading wash is the only cold colour here, and the only one that is not a
 * property of the text — it marks where the voice currently is.
 */
export const SYSTEM_MARKS: readonly SystemMark[] = [
  { id: "reading", color: "#7DD3FC", opacity: 0.42, shape: "wash", blendIntoPage: true },
  { id: "vocabNew", color: "#D97706", opacity: 0.85, shape: "underline" },
  { id: "learning", color: "#2F9E8F", opacity: 0.85, shape: "underline" },
  { id: "mastered", color: "#94A3B8", opacity: 0.9, shape: "underline", dashed: true },
];

export const systemMark = Object.fromEntries(
  SYSTEM_MARKS.map((mark) => [mark.id, mark]),
) as Record<SystemMarkId, SystemMark>;

/** The style each word-marker sentinel draws with. `lookup` is absent by design. */
export const wordMarkerStyle: Record<string, SystemMark> = {
  [wordMarkerColor.vocabNew]: systemMark.vocabNew,
  [wordMarkerColor.learning]: systemMark.learning,
  [wordMarkerColor.mastered]: systemMark.mastered,
};

export const READING_HIGHLIGHT_COLOR = systemMark.reading.color;
export const READING_HIGHLIGHT_OPACITY = systemMark.reading.opacity;

/** The colours a saved highlight can be named. Not configurable. */
export const savedHighlightColor: Record<string, string> = {
  yellow: "#FBBF24",
  green: "#34D399",
  blue: "#60A5FA",
  pink: "#F472B6",
  purple: "#A78BFA",
};

export const SAVED_HIGHLIGHT_OPACITY = 0.35;

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

/** The page colours a mark has to survive. A clash on either theme is a clash. */
const BACKDROPS = [getThemeStyles("paper").body, getThemeStyles("dark").body];

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
    return BACKDROPS.some((backdrop) => {
      const drawn = blendOver(style.color, opacity, backdrop);
      const against = blendOver(mark.color, mark.opacity, backdrop, markBlendMode(mark, backdrop));
      // A mark this close to the paper is barely there. Nothing you can hardly
      // see can be mistaken for something else, and the faintest settings are
      // deliberate — the automatic mark is meant to be read straight past — so
      // measuring it against another mark on this page would only ever nag.
      // Same threshold, same question: are these two too close to tell apart.
      if (colorDistance(drawn, backdrop) < MARK_COLLISION_THRESHOLD) return false;
      if (colorDistance(against, backdrop) < MARK_COLLISION_THRESHOLD) return false;
      return colorDistance(drawn, against) < MARK_COLLISION_THRESHOLD;
    });
  }).map((mark) => mark.id);
}
