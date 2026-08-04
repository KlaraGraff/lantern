import type { ContinuousReadSentence, ContinuousReadSource } from "../../components/continuous-read-aloud";
import { sentenceRangesInRange } from "../../components/reader-interaction";
import type { FoliateView } from "./foliate-types";

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

  const view = () => {
    const current = viewRef.current;
    if (!current) throw new Error("READER_NOT_READY");
    return current;
  };

  const sections = () => (view().book?.sections ?? []) as ReadAloudSection[];

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
    async first(fromBeginning = false) {
      const currentView = view();
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
        return records.find((record) => record.range.compareBoundaryPoints(Range.START_TO_END, target) > 0)
          ?? adjacent(resolved.index, 1);
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
      currentView.deselect?.();
      const resolved = currentView.resolveCFI(sentence.id);
      const visible = currentView.renderer?.getContents?.()
        ?.find((content: { index?: number }) => content.index === resolved.index) as { doc?: Document } | undefined;
      if (visible?.doc) {
        try {
          const rect = resolved.anchor(visible.doc).getBoundingClientRect();
          const width = visible.doc.defaultView?.innerWidth ?? visible.doc.documentElement.clientWidth;
          const height = visible.doc.defaultView?.innerHeight ?? visible.doc.documentElement.clientHeight;
          if (rect.bottom > 0 && rect.right > 0 && rect.top < height && rect.left < width) {
            return;
          }
        } catch {
          // Navigate below when the live document cannot resolve this CFI.
        }
      }
      const revealed = await currentView.goTo(sentence.id, { history: false });
      if (!revealed) throw new Error("CONTINUOUS_REVEAL_FAILED");
    },
  };
}
