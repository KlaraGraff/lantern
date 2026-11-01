/**
 * The page an arrival address asks the reader to open at, or `undefined` when
 * it does not name one.
 *
 * The reader arrives either from router state (in-window navigation) or from
 * its own query string (a standalone window). Only the query string needs
 * parsing, and it is parsed here so the rule can be checked without a React
 * component. A missing (or empty) parameter is *not* page 0: `Number(null)` is
 * 0, which would send every plain arrival to the book's first page.
 */
export function parseArrivalPage(
  statePage: number | undefined,
  queryPage: string | null,
): number | undefined {
  if (statePage !== undefined) return Number.isInteger(statePage) && statePage >= 0 ? statePage : undefined;
  if (queryPage === null || queryPage.trim() === "") return undefined;
  const raw = Number(queryPage);
  return Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}
