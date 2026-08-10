import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePronunciation } from "./speech/usePronunciation";
import { GLANCE_SAFE_ATTR } from "./dictionary-glance";

export interface DictionaryGroup {
  pos: string;
  /** One sense per element, never pre-joined — see the measurement below. */
  senses: string[];
}

export interface DictionaryEntry {
  word: string;
  phonetic: string | null;
  groups: DictionaryGroup[];
  fallbackSummary: string | null;
}

/** Parts of speech shown before 展开. A fourth is rare (`light` has one). */
const COLLAPSED_GROUP_LIMIT = 3;
/**
 * Sense lines the collapsed card gives away in total, split between the
 * groups it shows rather than handed to each. One part of speech gets all
 * six — which is the whole point: `deliver` has a single `v.` with eleven
 * senses and no second part of speech to compete with, so rationing it to two
 * lines left two thirds of the card empty.
 */
const COLLAPSED_TOTAL_LINES = 6;
/** `Math.floor(6 / n)` for n = 1..3, floored at 2. Static so Tailwind sees them. */
const CLAMP_CLASS: Record<number, string> = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  6: "line-clamp-6",
};

function collapsedLines(shownGroups: number) {
  return Math.max(2, Math.floor(COLLAPSED_TOTAL_LINES / Math.max(1, shownGroups)));
}

/**
 * Counts the senses the CSS clamp is hiding, by asking the layout rather than
 * by predicting it.
 *
 * The obvious alternative — have the backend cut each group to a character
 * budget — is what this replaces, and it cannot be made right. It has to guess
 * the card's width and type size, and because it can only cut between whole
 * senses it leaves the last line ragged: `light` used to end a line at
 * `车灯；…` with half the line blank. A CSS clamp fills every line to the pixel
 * and ellipsises exactly where the text runs out; the only thing it does not
 * tell you is how much it swallowed. So each sense is its own `<span>` and we
 * ask where each one landed.
 */
function hiddenSenseCount(paragraph: HTMLElement): number {
  const box = paragraph.getBoundingClientRect();
  // `line-clamp` clips with `overflow: hidden`, so children past the clamp are
  // still laid out and still report geometry — they are merely not painted.
  const spans = paragraph.querySelectorAll<HTMLElement>("[data-sense]");
  let hidden = 0;
  for (const span of spans) {
    const first = span.getClientRects()[0];
    // Counted as shown when it *starts* inside the clamp: the reader can see
    // it begin, even if the ellipsis eats its tail.
    if (first && first.top - box.top >= box.height - 1) hidden += 1;
  }
  // The clamp is overflowing but every sense starts inside it: one long sense
  // is being cut mid-way. Report it rather than claiming nothing is hidden.
  if (hidden === 0 && paragraph.scrollHeight > paragraph.clientHeight + 1) hidden = 1;
  return hidden;
}

/**
 * The single-click dictionary layer at the top of the reader's context menu.
 *
 * Rendered from the moment the menu opens, before the lookup resolves: the
 * word is already known, so only the phonetic and the senses have to wait, and
 * they wait as skeleton bars that hold the card's width and height. Letting
 * the card appear when the response arrived meant the whole menu changed width
 * and jumped to a new position a beat after opening.
 */
export default function DictionaryCard({
  word,
  loading,
  entry,
  showSpeak,
  showAiHint,
}: {
  word: string;
  loading: boolean;
  /** Null once `loading` is false means the word is genuinely not in there. */
  entry: DictionaryEntry | null;
  /**
   * False when the reader turned the speak action off in the menu order — the
   * header must not smuggle back a row they removed.
   */
  showSpeak: boolean;
  /**
   * Mirrors the `double_click_quick_lookup` setting. Off means double-clicking
   * a word does nothing (`TextBookReader` hands the event to a custom binding
   * instead), so the hint would be promising something the reader has turned
   * off — drop the line rather than reword it.
   */
  showAiHint: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [clippedSenses, setClippedSenses] = useState(0);
  const sensesRef = useRef<HTMLDivElement>(null);

  const {
    empty: nothingToSpeak,
    status,
    notice,
    Icon,
    iconClassName,
    accentLabel,
    switchAccentLabel,
    playLabel,
    play,
    toggleAccent,
  } = usePronunciation(word, "word");

  const groups = entry?.groups ?? [];
  const shownGroups = expanded ? groups : groups.slice(0, COLLAPSED_GROUP_LIMIT);
  const lines = collapsedLines(shownGroups.length);
  // Senses in parts of speech the collapsed card never got to. Known exactly,
  // so they need no measuring.
  const groupsBeyondLimit = expanded ? [] : groups.slice(COLLAPSED_GROUP_LIMIT);
  const hiddenInDroppedGroups = groupsBeyondLimit.reduce(
    (sum, g) => sum + g.senses.length,
    0,
  );
  const hiddenCount = expanded ? 0 : clippedSenses + hiddenInDroppedGroups;

  const measure = useCallback(() => {
    const root = sensesRef.current;
    if (!root || expanded) {
      setClippedSenses(0);
      return;
    }
    let total = 0;
    for (const p of root.querySelectorAll<HTMLElement>("[data-group]")) {
      total += hiddenSenseCount(p);
    }
    setClippedSenses(total);
  }, [expanded]);

  useLayoutEffect(() => {
    measure();
    const root = sensesRef.current;
    if (!root) return;
    // Re-measure when the card resizes for any reason — a reader font change,
    // a window resize, or the fonts finishing loading after first paint.
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure, entry]);

  // Collapsing must not leave the reader staring at the middle of a long
  // entry: the card scrolls when expanded, so put it back at the top.
  const toggleExpanded = () => {
    setExpanded((was) => {
      if (was) sensesRef.current?.scrollTo({ top: 0 });
      return !was;
    });
  };

  const aiHint = t("dictionary.askAiHint", {
    defaultValue: "双击让 AI 告诉你这里是哪个意思",
  });

  return (
    <div className="mx-1 mb-1 border-b border-border-light px-2 pb-2 pt-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text-primary">
          {word}
        </span>
        {loading ? (
          <span className="h-[10px] w-14 animate-pulse rounded-sm bg-border" />
        ) : entry?.phonetic ? (
          <span className="text-[11px] text-text-muted">
            /{entry.phonetic}/
          </span>
        ) : null}
        {showSpeak && !nothingToSpeak ? (
          // The pronounce control belongs beside the word, the way every
          // dictionary puts it — and it is useful from the first frame, since
          // speech does not wait on the lookup.
          <span className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              role="menuitem"
              onClick={play}
              title={playLabel}
              aria-label={playLabel}
              className="flex h-[22px] w-[22px] items-center justify-center rounded-sm text-text-muted transition-colors hover:bg-accent-bg hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Icon
                size={16}
                className={`${status === "playing" ? "text-accent-text" : ""} ${iconClassName}`}
              />
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={toggleAccent}
              title={switchAccentLabel}
              aria-label={switchAccentLabel}
              className="flex h-[18px] shrink-0 items-center rounded border border-border/70 px-1 text-[10px] font-medium leading-none text-text-muted transition-colors hover:border-accent/60 hover:text-accent-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {accentLabel}
            </button>
          </span>
        ) : null}
      </div>

      {notice && (
        <p
          role="status"
          className="mt-1 rounded-sm bg-bg-muted px-2 py-1 text-[11px] leading-[15px] text-text-secondary"
        >
          {notice}
        </p>
      )}

      {loading ? (
        // Two bars: the height the great majority of entries settle at, so the
        // swap to real text moves the menu as little as possible.
        <div className="mt-1 space-y-[9px] py-[4.5px]">
          <div className="h-[11px] animate-pulse rounded-sm bg-border" />
          <div className="h-[11px] w-2/3 animate-pulse rounded-sm bg-border" />
        </div>
      ) : (
        <>
          {!entry ? (
            <p className="mt-1 text-[12px] leading-5 text-text-secondary">
              {t("dictionary.notFound", { defaultValue: "词典里没有这个词" })}
            </p>
          ) : entry.fallbackSummary ? (
            // Degraded fallback: no phonetic, no part-of-speech grouping — one
            // line, already hard-truncated by the backend.
            <p className="mt-1 text-[12px] leading-5 text-text-secondary">
              {entry.fallbackSummary}
            </p>
          ) : (
            <>
              <div
                ref={sensesRef}
                className={`mt-1 space-y-1 ${expanded ? "max-h-[min(46vh,420px)] overflow-y-auto pr-1" : ""}`}
              >
                {shownGroups.map((group, index) => (
                  <p
                    key={index}
                    data-group
                    className={`text-[12px] leading-5 text-text-secondary ${expanded ? "" : CLAMP_CLASS[lines]}`}
                  >
                    {group.pos ? (
                      <span className="mr-1 font-medium text-text-primary">
                        {group.pos}
                      </span>
                    ) : null}
                    {group.senses.map((sense, senseIndex) => (
                      <span key={senseIndex} data-sense>
                        {senseIndex > 0 ? "；" : ""}
                        {sense}
                      </span>
                    ))}
                  </p>
                ))}
              </div>
              {hiddenCount > 0 || expanded ? (
                <p className="mt-1 text-[11px] leading-4 text-text-muted">
                  {/* The count string carries its own trailing separator: only
                      the verb is a link, and which comma joins them is the
                      translator's call, not the layout's. */}
                  {hiddenCount > 0 ? t("dictionary.moreSenses", { count: hiddenCount }) : null}
                  <button
                    type="button"
                    role="menuitem"
                    // Reading more of the entry is the dictionary glance, not a
                    // detour away from it — see dictionary-glance.ts.
                    {...{ [GLANCE_SAFE_ATTR]: "" }}
                    onClick={toggleExpanded}
                    className="rounded-sm font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {expanded
                      ? t("dictionary.collapse", { defaultValue: "收起" })
                      : t("dictionary.expandAll", { defaultValue: "展开全部" })}
                  </button>
                </p>
              ) : null}
            </>
          )}
          {/* The last line of every state including "not in there": the
              dictionary answers what a word means, the AI answers which of
              those meanings is on this page, and that second question is worth
              asking even when the entry came back complete. */}
          {showAiHint ? (
            <p className="mt-1 text-[11px] leading-4 text-text-muted">{aiHint}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
