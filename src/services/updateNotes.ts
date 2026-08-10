/**
 * Turning a release body into the changelog the update toast shows.
 *
 * The updater hands us `update.body` verbatim — the `notes` field of
 * `latest.json`, which `scripts/update-notes.mjs` fills with the published
 * GitHub release body. That body is deliberately bilingual: a link row, then
 * `<a id="chinese">` and `<a id="english">` blocks saying the same thing twice.
 * Showing both to everyone would mean half the toast is in a language the
 * reader did not pick, so the block that does not match the interface language
 * never reaches the DOM at all.
 *
 * Everything here is pure text work and lives outside the component so it can
 * be tested against real release bodies — `tests/update-notes.test.ts` runs it
 * over the actual published v2.15.2 body.
 */

/** Language anchors GitHub renders from the release body's `<a id=…>` tags. */
const ANCHORS: Record<string, string> = { zh: "chinese", en: "english" };

/** `<a id="chinese"></a>` — the boundary between the two language blocks. */
const anchorPattern = (id: string) => new RegExp(`<a\\s+id=["']${id}["']\\s*>\\s*</a>`, "i");

/** Any language anchor, used to find where the block we picked ends. */
const ANY_ANCHOR = /<a\s+id=["'](?:chinese|english)["']\s*>\s*<\/a>/i;

/**
 * The `[简体中文](#chinese) · [English](#english)` row at the top. It is
 * in-page navigation for the GitHub release page; inside the toast the links
 * point nowhere.
 */
const LANGUAGE_LINK_ROW = /^\s*(?:\[[^\]]*\]\(#(?:chinese|english)\)\s*(?:·|\|)?\s*)+$/i;

/** `## 中文` / `## English` — the block's own title, redundant once picked. */
const LANGUAGE_HEADING = /^#{1,3}\s*(中文|简体中文|English)\s*$/i;

/**
 * The changelog to show for `language`, or `null` when there is nothing worth
 * showing — in which case the toast falls back to the bare "vX.Y.Z is
 * available" line it has always shown.
 *
 * A body with no anchors at all (a single-language release, or an older
 * `latest.json` still carrying the build-time placeholder) is returned whole
 * rather than dropped: less tailored, still better than silence.
 */
export function extractLocaleNotes(
  body: string | null | undefined,
  language: string,
): string | null {
  if (typeof body !== "string") return null;

  const anchorId = ANCHORS[language.split("-")[0].toLowerCase()] ?? ANCHORS.en;
  const block = sliceAnchoredBlock(body, anchorId) ?? sliceAnchoredBlock(body, ANCHORS.en) ?? body;

  const cleaned = block
    .split("\n")
    .filter((line) => !LANGUAGE_LINK_ROW.test(line) && !LANGUAGE_HEADING.test(line))
    .join("\n")
    .replace(ANY_ANCHOR, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The text between `<a id="…">` and whichever language anchor comes next
 * (or the end of the body). Returns `null` when the anchor is absent, which is
 * what lets the caller fall through to English and then to the whole body.
 */
function sliceAnchoredBlock(body: string, anchorId: string): string | null {
  const start = body.match(anchorPattern(anchorId));
  if (!start || start.index === undefined) return null;

  const after = body.slice(start.index + start[0].length);
  const next = after.match(ANY_ANCHOR);
  return next && next.index !== undefined ? after.slice(0, next.index) : after;
}
