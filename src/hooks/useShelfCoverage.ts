import { useEffect, useState } from "react";

import { listShelfCoverage, type ShelfCoverage } from "./useBookCoverage";
import { useSettings } from "./useSettings";
import {
  countFamiliarFrom,
  shelfCoverageFrom,
  shelfCoverageLabel,
} from "../pages/book-details/coverage-view";

/**
 * The shelf's coverage badges (08, D7) — off unless the reader asked for them.
 *
 * One query for the whole shelf, looked up per card. The setting is read here
 * rather than passed down so that a shelf which is not showing badges never
 * makes the call at all: the default is off, and off should cost nothing.
 *
 * A failed call is not reported anywhere. This is a decoration on a page whose
 * job is finding a book, and an error banner across the shelf because a badge
 * could not be drawn would be worse than the missing badge.
 */
export function useShelfCoverage(): (bookId: string) => string | null {
  const { settings } = useSettings();
  const enabled = shelfCoverageFrom(settings);
  const countFamiliar = countFamiliarFrom(settings);
  const [rows, setRows] = useState<Map<string, ShelfCoverage>>(new Map());

  useEffect(() => {
    if (!enabled) {
      setRows(new Map());
      return;
    }
    let alive = true;
    listShelfCoverage()
      .then((list) => {
        if (alive) setRows(new Map(list.map((row) => [row.bookId, row])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);

  return (bookId: string) => {
    if (!enabled) return null;
    const row = rows.get(bookId);
    return row ? shelfCoverageLabel(row, countFamiliar) : null;
  };
}
