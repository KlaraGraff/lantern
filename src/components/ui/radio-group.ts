/**
 * Keyboard movement for a radio group built out of plain buttons.
 *
 * `role="radio"` promises arrow-key movement: a radio group is one tab stop,
 * and the arrows pick inside it. Buttons give none of that on their own, so a
 * hand-rolled group without this reads as a list of separate tab stops — worse
 * for the keyboard than the `<select>` it usually replaced.
 */

/**
 * The index an arrow (or Home/End) moves to, or null when the key is not the
 * group's to handle.
 *
 * Both axes move: a two-column card grid is horizontal to the eye and vertical
 * to someone stepping down the list, and guessing wrong leaves a dead key.
 * Movement wraps, as WAI-ARIA specifies for radio groups.
 */
export function nextRadioIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  // An unknown selection (nothing matched) still has to move somewhere sane.
  const index = current >= 0 && current < count ? current : 0;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
