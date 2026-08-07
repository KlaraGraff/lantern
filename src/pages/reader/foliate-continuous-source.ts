import type { ContinuousReadSentence, ContinuousReadSource } from "../../components/continuous-read-aloud";
import { sentenceRangesInRange } from "../../components/reader-interaction";
import type { FoliateView } from "./foliate-types";
import { decideFollow, isReaderRelocation, type SentencePlacement } from "./read-aloud-follow";
import { pickReadAloudStart } from "./read-aloud-start";

interface ReadAloudSection {
  linear?: string;
  createDocument(): Promise<Document>;
}

interface SentenceRecord extends ContinuousReadSentence {
  sectionIndex: number;
  ordinal: number;
  range: Range;
}

function sentenceLanguage(range: Range, doc: Document) {
  const element = range.startContainer.nodeType === 1
    ? range.startContainer as Element
    : range.startContainer.parentElement;
  return element?.closest("[lang]")?.getAttribute("lang")
    ?? doc.documentElement.getAttribute("lang")
    ?? undefined;
}

export function createFoliateContinuousSource(
  viewRef: { current: FoliateView | null },
  currentCfiRef: { current: string | null },
): ContinuousReadSource {
  const cache = new Map<number, SentenceRecord[]>();
  const byId = new Map<string, SentenceRecord>();
  /**
   * The one sentence `reveal` must not navigate to: the page is the middle of
   * it, so its true start is on an earlier page and going there would move the
   * reader backwards. Cleared as soon as it is honoured — every later sentence
   * in the run is revealed normally.
   */
  let holdPositionFor: string | null = null;
  /**
   * Set once the reader moves the page themselves during a run, and cleared the
   * moment playback lands back on what they are looking at. While it is set,
   * `reveal` reports where the voice is but never moves the view — the app does
   * not take the book out of the reader's hands.
   */
  let readerTurnedAway = false;
  /** The renderer the manual-turn listener is already installed on. */
  let watched: EventTarget | null = null;

  const view = () => {
    const current = viewRef.current;
    if (!current) throw new Error("READER_NOT_READY");
    return current;
  };

  /**
   * Listens on the paginator rather than the view element: only the paginator's
   * own `relocate` carries `reason`, which is the sole way to tell the reader
   * turning a page from this source navigating to a sentence (or from a reflow
   * re-anchoring the same one).
   */
  const watchForReaderTurns = (currentView: FoliateView) => {
    const renderer = currentView.renderer as EventTarget | undefined | null;
    if (!renderer || renderer === watched) return;
    watched = renderer;
    renderer.addEventListener("relocate", (event: Event) => {
      const { reason } = (event as CustomEvent<{ reason?: unknown }>).detail ?? {};
      if (isReaderRelocation(reason)) readerTurnedAway = true;
    });
  };

  /**
   * Where a sentence sits relative to the page on screen, or `null` when the
   * question cannot be answered against the live document — a section that is
   * not loaded, or a visible range measured in a document that has since been
   * replaced.
   */
  const placeOnPage = (currentView: FoliateView, sentenceId: string): SentencePlacement | null => {
    try {
      const resolved = currentView.resolveCFI(sentenceId);
      const loaded = currentView.renderer?.getContents?.()
        ?.find((content: { index?: number }) => content.index === resolved.index) as
          { doc?: Document } | undefined;
      const doc = loaded?.doc;
      if (!doc) return null;
      const page = currentView.lastLocation?.range as Range | undefined;
      if (!page?.startContainer || page.startContainer.ownerDocument !== doc) return null;
      const target = resolved.anchor(doc);
      return {
        startVsVisibleEnd: target.compareBoundaryPoints(Range.END_TO_START, page),
        endVsVisibleStart: target.compareBoundaryPoints(Range.START_TO_END, page),
      };
    } catch {
      return null;
    }
  };

  const sections = () => (view().book?.sections ?? []) as ReadAloudSection[];

  const readable = (section: ReadAloudSection | undefined) => Boolean(section) && section?.linear !== "no";

  /**
   * Whether any readable section sits on the far side of this one.
   *
   * Only the spine is consulted, never the sections themselves: opening every
   * later document to check it has sentences would defeat the streaming this
   * source exists to preserve. A later section that turns out to hold nothing
   * still ends the run — the reader simply sees "end of book" one sentence after
   * the button said it could go further, which is the cheap way to be wrong.
   */
  const hasReadableBeyond = (index: number, direction: -1 | 1) => {
    const all = sections();
    for (let next = index + direction; next >= 0 && next < all.length; next += direction) {
      if (readable(all[next])) return true;
    }
    return false;
  };

  const load = async (index: number) => {
    const cached = cache.get(index);
    if (cached) return cached;
    const section = sections()[index];
    if (!section) return [];
    const doc = await section.createDocument();
    const bodyRange = doc.createRange();
    bodyRange.selectNodeContents(doc.body);
    const sentences = sentenceRangesInRange(bodyRange, doc.documentElement.lang || undefined);
    const records: SentenceRecord[] = [];
    for (const sentence of sentences) {
      const range = sentence.range;
      const sentenceText = sentence.text.trim();
      if (!sentenceText) continue;
      const id = view().getCFI(index, range);
      const record: SentenceRecord = {
        id,
        text: sentenceText,
        language: sentenceLanguage(range, doc),
        sectionIndex: index,
        ordinal: records.length,
        range,
      };
      records.push(record);
      byId.set(id, record);
    }
    // Position is filled in only once the whole section is segmented: the total
    // and the characters still to come are both suffix facts, and a sentence
    // that reported them mid-scan would be reporting a smaller book than it is.
    const beforeStart = !hasReadableBeyond(index, -1);
    const afterEnd = !hasReadableBeyond(index, 1);
    let remainingCharacters = 0;
    for (let at = records.length - 1; at >= 0; at -= 1) {
      remainingCharacters += records[at].text.length;
      records[at].position = { index: at + 1, total: records.length, remainingCharacters };
      records[at].atBookStart = beforeStart && at === 0;
      records[at].atBookEnd = afterEnd && at === records.length - 1;
    }
    cache.set(index, records);
    return records;
  };

  const adjacent = async (index: number, direction: -1 | 1) => {
    const all = sections();
    for (let next = index + direction; next >= 0 && next < all.length; next += direction) {
      if (all[next]?.linear === "no") continue;
      const records = await load(next);
      if (records.length > 0) return direction > 0 ? records[0] : records[records.length - 1];
    }
    return null;
  };

  return {
    refocus() {
      // The reader asked for a particular sentence, so the page owes them that
      // sentence even if they had paged away from the voice earlier.
      readerTurnedAway = false;
    },
    async first(fromBeginning = false) {
      const currentView = view();
      watchForReaderTurns(currentView);
      holdPositionFor = null;
      readerTurnedAway = false;
      if (fromBeginning) {
        const firstLinear = sections().findIndex((section) => section.linear !== "no");
        const startIndex = firstLinear >= 0 ? firstLinear : 0;
        const firstRecords = await load(startIndex);
        return firstRecords[0] ?? adjacent(startIndex, 1);
      }
      const cfi = currentCfiRef.current ?? currentView.lastLocation?.cfi as string | undefined;
      const resolved = cfi ? currentView.resolveCFI(cfi) : { index: 0, anchor: null };
      const records = await load(resolved.index);
      if (!resolved.anchor || records.length === 0) return records[0] ?? adjacent(resolved.index, 1);
      try {
        const doc = records[0].range.startContainer.ownerDocument!;
        const target = resolved.anchor(doc);
        const choice = pickReadAloudStart(records.map((record) => ({
          startVsPage: record.range.compareBoundaryPoints(Range.START_TO_START, target),
          endVsPage: record.range.compareBoundaryPoints(Range.START_TO_END, target),
        })));
        if (choice.kind === "none") return adjacent(resolved.index, 1);
        const record = records[choice.index];
        if (choice.kind === "continuation") holdPositionFor = record.id;
        return record;
      } catch {
        return records[0] ?? adjacent(resolved.index, 1);
      }
    },
    async next(after) {
      const record = byId.get(after.id);
      if (!record) return null;
      const records = await load(record.sectionIndex);
      return records[record.ordinal + 1] ?? adjacent(record.sectionIndex, 1);
    },
    async previous(before) {
      const record = byId.get(before.id);
      if (!record) return null;
      const records = await load(record.sectionIndex);
      return records[record.ordinal - 1] ?? adjacent(record.sectionIndex, -1);
    },
    async reveal(sentence) {
      const currentView = view();
      watchForReaderTurns(currentView);
      if (holdPositionFor === sentence.id) {
        // The reader is already looking at the middle of this sentence; its start
        // is on an earlier page, so navigating to it would move them backwards.
        holdPositionFor = null;
        readerTurnedAway = false;
        return;
      }
      currentView.deselect?.();
      const decision = decideFollow(placeOnPage(currentView, sentence.id), readerTurnedAway);
      if (decision === "visible") {
        // Playback is on the page the reader is looking at, whether they put it
        // there or the last reveal did. Either way the two are together again.
        readerTurnedAway = false;
        return;
      }
      if (decision === "hold") return;
      const revealed = await currentView.goTo(sentence.id, { history: false });
      if (!revealed) throw new Error("CONTINUOUS_REVEAL_FAILED");
    },
  };
}
