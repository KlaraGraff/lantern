/**
 * Where a newly opened reader window goes.
 *
 * Reader windows used to be created with a size and no position, and their
 * default size was the *same* 1440×960 as the main window, so the OS put each
 * new one exactly on top of the library — pixel for pixel. Nothing had
 * navigated and nothing was hidden, but the library was gone from view, so
 * opening a book read as "the app switched screens", and opening a second book
 * stacked two readers on the same spot, which quietly cost the one thing the
 * window-per-book design was for.
 *
 * The fix is the platform convention: cascade. Each new window steps down and
 * to the right of the window it was opened from, far enough that the one behind
 * keeps a visible edge.
 *
 * Everything here is pure and in *logical* pixels — the unit Tauri's window
 * creation options take. Asking the OS where windows and monitors actually are
 * is `openReaderWindow.ts`'s job.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

/** One cascade step. macOS's own step is ~20–25pt; 28 is a touch larger because
 *  Lantern's title bar is `overlay` with no visible chrome of its own, so the
 *  strip of the window behind is the only thing saying "there is a window
 *  behind". */
export const CASCADE_STEP = 28;

/** How much of a window's top-left corner has to stay inside the work area.
 *
 *  Deliberately *not* "the whole window fits": a 1440×960 reader never fits a
 *  1512×944 laptop work area, and a fits-or-bust rule would bounce every window
 *  back to the same corner — the original bug wearing a different hat. What
 *  matters is that the new window is visible and its title bar is grabbable. */
export const MIN_VISIBLE = 160;

/** Runaway guard for the collision walk. Reached only if two dozen windows are
 *  stacked on one screen, at which point any answer is as good as any other. */
const MAX_STEPS = 24;

function band(workArea: Rect, margin: number) {
  const maxX = workArea.x + workArea.width - margin;
  const maxY = workArea.y + workArea.height - margin;
  return {
    minX: workArea.x,
    minY: workArea.y,
    // A work area smaller than the margin would invert the band; keep it empty
    // but ordered so clamping still lands on the corner.
    maxX: Math.max(workArea.x, maxX),
    maxY: Math.max(workArea.y, maxY),
  };
}

/** Would a window whose top-left is `origin` be visible and grabbable on this
 *  screen? `margin` is in the same units as `origin` and `workArea` — callers
 *  working in physical pixels scale {@link MIN_VISIBLE} by the monitor's scale
 *  factor. */
export function isOriginVisible(origin: Point, workArea: Rect, margin: number = MIN_VISIBLE): boolean {
  const b = band(workArea, margin);
  return origin.x >= b.minX && origin.x <= b.maxX && origin.y >= b.minY && origin.y <= b.maxY;
}

/** Is this corner still on *some* screen? Monitors get unplugged, and a window
 *  restored onto one that is gone is a window the user can neither see nor
 *  reach. */
export function isOriginOnAnyScreen(
  origin: Point,
  workAreas: readonly { area: Rect; margin: number }[],
): boolean {
  return workAreas.some(({ area, margin }) => isOriginVisible(origin, area, margin));
}

function collides(origin: Point, taken: readonly Point[]): boolean {
  return taken.some(
    (other) => Math.abs(other.x - origin.x) < CASCADE_STEP && Math.abs(other.y - origin.y) < CASCADE_STEP,
  );
}

function clampOrigin(origin: Point, workArea: Rect): Point {
  const b = band(workArea, MIN_VISIBLE);
  return {
    x: Math.round(Math.min(Math.max(origin.x, b.minX), b.maxX)),
    y: Math.round(Math.min(Math.max(origin.y, b.minY), b.maxY)),
  };
}

export interface CascadeInput {
  /** Top-left of the window this one is being opened from. */
  anchor: Point;
  /** The screen the anchor is on, minus its menu bar and dock. */
  workArea: Rect;
  /** Top-left corners of the reader windows already open, so a cascade that
   *  wraps or restores does not land on one of them. */
  taken?: readonly Point[];
}

/**
 * One step down-right from the anchor, stepping again past any window already
 * parked there, and restarting from the work area's own corner once the run
 * walks off the bottom-right — the same shape as a macOS cascade run.
 */
export function cascadeOrigin({ anchor, workArea, taken = [] }: CascadeInput): Point {
  const home: Point = { x: workArea.x + CASCADE_STEP, y: workArea.y + CASCADE_STEP };
  let candidate: Point = { x: anchor.x + CASCADE_STEP, y: anchor.y + CASCADE_STEP };
  if (!isOriginVisible(candidate, workArea)) candidate = home;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (!collides(candidate, taken)) break;
    const next: Point = { x: candidate.x + CASCADE_STEP, y: candidate.y + CASCADE_STEP };
    if (isOriginVisible(next, workArea)) {
      candidate = next;
      continue;
    }
    // Walked off the bottom-right. Start a fresh run from the corner — unless
    // that is where we already are, which means the work area has no room for
    // another distinct position and stepping forever would not find one.
    if (candidate.x === home.x && candidate.y === home.y) break;
    candidate = home;
  }

  return clampOrigin(candidate, workArea);
}

/**
 * Where to actually put a window whose position was remembered. The remembered
 * corner wins, except when another reader window is sitting on it — reopening a
 * book should never recreate the full overlap this module exists to prevent.
 */
export function restoredOrigin(saved: Point, workArea: Rect, taken: readonly Point[] = []): Point {
  if (!collides(saved, taken)) return clampOrigin(saved, workArea);
  return cascadeOrigin({ anchor: saved, workArea, taken });
}
