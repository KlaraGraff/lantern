/**
 * 「停靠」 (design §10–11): the answer card beside the sentence turns into the
 * right card. A box the size of the right card starts drawn over the answer
 * card and travels to where the right card stands; the answer's words fade
 * where they were, and the right card's own content comes up when the box
 * lands.
 *
 * The box is a stand-in: the two cards are separate elements with separate
 * content, and scaling either into the other would squash its text for the
 * length of the move. The stand-in has nothing inside it, so it moves by
 * `transform` alone, which the compositor runs even while the reader is busy
 * opening the right card (motion rule ①: only transform and opacity move).
 */

/** `--motion-travel`: a move across the window. */
export const DOCK_MORPH_MS = 260;
/** `--motion-fast`: the card's words leaving, and the right card's arriving. */
export const DOCK_MORPH_FADE_MS = 140;
/** `--ease-in-out-soft`: the box leaves one place and settles in another. */
export const DOCK_MORPH_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

export interface MorphRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const hasArea = (rect: MorphRect | null): rect is MorphRect =>
  Boolean(rect && rect.width > 0 && rect.height > 0);

/**
 * Whether the hand-off is shown as a move at all. Under reduced motion the
 * right card simply opens, as it does from every other entry point; below the
 * breakpoint the right side is a full-screen sheet with no card to land on;
 * a card with no size on screen has nowhere to start from.
 */
export function shouldMorph({
  from,
  narrow,
  reducedMotion,
}: {
  from: MorphRect | null;
  narrow: boolean;
  reducedMotion: boolean;
}): boolean {
  return !narrow && !reducedMotion && hasArea(from);
}

/**
 * The move, as a transform on a box laid out where the right card stands
 * (origin at its top left): it starts squeezed onto the answer card's box and
 * ends untransformed. `null` when the right card has no box to land on.
 */
export function dockMorphFrames(from: MorphRect, to: MorphRect): Keyframe[] | null {
  if (!hasArea(from) || !hasArea(to)) return null;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  return [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform: "translate(0px, 0px) scale(1, 1)" },
  ];
}
