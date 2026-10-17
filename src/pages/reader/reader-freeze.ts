export interface ShadowHost {
  shadowRoot: ShadowRoot | null;
}

/**
 * Holds the page still while the space around it changes size.
 *
 * Foliate re-columnizes the whole chapter whenever its container's width
 * changes. During a panel drag or a card pinning itself, the width changes on
 * every frame, so the renderer is told to skip reflow (`resize-dragging`) and
 * the viewer is fixed at the pixel width it has now — otherwise the frozen
 * columns no longer match the box and the page renders clipped. The space
 * that opens or closes simply covers or uncovers the viewer's edge (`<main>`
 * is overflow-hidden).
 *
 * The returned release lets the viewer flex to its final size first and then
 * drops the attribute, so the one reflow that follows reads the final width.
 * Calling it twice is harmless.
 */
export function freezeReader(host: ShadowHost | null, viewer: HTMLElement | null): () => void {
  const renderer = host?.shadowRoot
    ?.querySelector("foliate-paginator, foliate-fxl, foliate-pdf-scroll");
  renderer?.setAttribute("resize-dragging", "");
  if (viewer) viewer.style.width = `${viewer.clientWidth}px`;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (viewer) viewer.style.width = "";
    renderer?.removeAttribute("resize-dragging");
  };
}
