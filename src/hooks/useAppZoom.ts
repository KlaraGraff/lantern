import { useEffect } from "react";
import { appZoomCommandFor, nextAppZoom, zoomShortcutsClaimed } from "../services/app-zoom";
import {
  applyAppZoom,
  listenForAppZoom,
  persistAppZoom,
  readAppZoom,
} from "../services/app-zoom-window";

/**
 * Wire ⌘= / ⌘- / ⌘0 to the window's own zoom, app-wide.
 *
 * Capture phase on `window`: the reader's page-turn handler listens for the
 * same keys, and this one has to decide first. It stands aside for a PDF, where
 * the reader's own page zoom is the better meaning of the shortcut.
 *
 * Keys pressed inside a book's iframe never reach this listener — a separate
 * document does not bubble into its host. `useReaderInteractions` answers them
 * there, through the same rules.
 */
export function useAppZoom() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const command = appZoomCommandFor(event);
      if (!command || zoomShortcutsClaimed()) return;
      event.preventDefault();
      persistAppZoom(nextAppZoom(readAppZoom(), command));
    };
    window.addEventListener("keydown", handleKeyDown, true);

    let disposed = false;
    let unlisten: (() => void) | undefined;
    listenForAppZoom((percent) => {
      if (!disposed) applyAppZoom(percent);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      disposed = true;
      unlisten?.();
    };
  }, []);
}
