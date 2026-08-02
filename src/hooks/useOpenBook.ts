import { useCallback } from "react";
import { useNavigate } from "react-router";

import { platform } from "../services/platform";
import { openReaderWindow, readerUrl, type ReaderTarget } from "../utils/openReaderWindow";

/**
 * "Open this book, at this place."
 *
 * Where the OS gives out windows, a book gets one of its own and the library
 * stays where it is. Where it does not (D-005 `hasWindow`), the same book takes
 * over the window it was opened from. Callers say what they want opened; how
 * many windows exist is not their business.
 *
 * A hook rather than a plain function because the single-window half needs the
 * router, and the router is only reachable from inside it.
 */
export function useOpenBook(): (bookId: string, target?: ReaderTarget) => void {
  const navigate = useNavigate();
  return useCallback((bookId: string, target?: ReaderTarget) => {
    if (platform.hasWindow) {
      void openReaderWindow(bookId, target);
      return;
    }
    void navigate(readerUrl(bookId, target));
  }, [navigate]);
}
