import { useEffect, useRef, type MutableRefObject } from "react";

import { selectedRange, sentenceRangesInRange, type SentenceRange } from "../../components/reader-interaction";
import {
  subscribeToPlayer,
  subscribeToProgress,
  type PlaybackProgress,
  type SpeechPlayerState,
} from "../../components/speech/player";
import { segmentSentences, sentenceIndexAt, timeSentences } from "../../components/speech/routing";
import type { FoliateView } from "./foliate-types";

/**
 * What is being read, captured when playback is requested.
 *
 * `consumed` counts the sentences earlier steps already covered, so a step's own
 * sentence index can be turned into one over the whole selection. Steps arrive in
 * order, which is what makes a running total sufficient.
 */
interface ReadingTarget {
  /** Whose playback this follows. Anything else's progress is not ours to chase. */
  ownerId: string;
  index: number;
  sentences: SentenceRange[];
  locale?: string;
  consumed: number;
  step: number;
  /** The step's text, kept so its sentence count can be added when it ends. */
  lastText: string;
  highlighted: number | null;
  /** Whether the audio has actually started, which is when the selection goes. */
  started: boolean;
}

interface UseReadingHighlightOptions {
  viewRef: MutableRefObject<FoliateView | null>;
  showReadingHighlight: (cfi: string) => Promise<void>;
  clearReadingHighlight: () => Promise<void>;
}

/**
 * Moves a highlight through the text as the audio speaks it.
 *
 * The selection itself is dropped once the audio starts: a block selected for
 * reading stays lit for as long as the audio runs, which is tiring against
 * several paragraphs and says nothing about where playback has reached. What
 * replaces it is one sentence at a time.
 *
 * Nothing is plumbed in from the control that started playback. The selection is
 * still in the document when the request is made, so reading it here keeps the
 * context menu, `useSpeech` and the player all unaware of the reader.
 */
export function useReadingHighlight({
  viewRef,
  showReadingHighlight,
  clearReadingHighlight,
}: UseReadingHighlightOptions) {
  const targetRef = useRef<ReadingTarget | null>(null);

  useEffect(() => {
    const release = () => {
      targetRef.current = null;
      void clearReadingHighlight();
    };

    const capture = (ownerId: string): ReadingTarget | null => {
      const view = viewRef.current;
      for (const content of view?.renderer?.getContents?.() ?? []) {
        const doc = content?.doc as Document | undefined;
        if (!doc) continue;
        const range = selectedRange(doc);
        if (!range || !range.toString().trim()) continue;
        const locale = doc.documentElement.lang || undefined;
        const sentences = sentenceRangesInRange(range, locale);
        if (sentences.length === 0) continue;
        return {
          ownerId,
          index: content.index,
          sentences,
          locale,
          consumed: 0,
          step: 0,
          lastText: "",
          highlighted: null,
          started: false,
        };
      }
      return null;
    };

    /** Drops the native selection now that our own highlight is taking over. */
    const clearSelection = () => {
      const view = viewRef.current;
      for (const content of view?.renderer?.getContents?.() ?? []) {
        (content?.doc as Document | undefined)?.defaultView?.getSelection()?.removeAllRanges();
      }
    };

    const advance = (target: ReadingTarget, progress: PlaybackProgress) => {
      // A step boundary is the only moment the running total moves, and it is
      // charged against the step that just finished, not the one starting.
      if (progress.stepIndex !== target.step) {
        target.consumed += segmentSentences(target.lastText, target.locale).length;
        target.step = progress.stepIndex;
      }

      const timed = timeSentences(progress.text, progress.timings ?? [], target.locale);
      target.lastText = progress.text;
      // Without timings — system voices, or a source that reports none — there is
      // nothing to follow, so the whole step stays lit rather than the highlight
      // sitting on its first sentence pretending to track.
      const within = progress.timings && progress.timings.length > 0
        ? sentenceIndexAt(timed, progress.elapsedMs)
        : 0;
      return target.consumed + within;
    };

    /**
     * Capturing here rather than on the first progress event is what makes the
     * highlight survive the wait for audio. `speak` publishes this state inside
     * the click that started it, so the selection is still in the document; a
     * click anywhere during the fetch that follows would have wiped it out.
     *
     * Only detached playback is followed. A word played from a card is already
     * selected and already explained by the card, so a second highlight for it
     * would be noise — and while a passage is parked, the word's own progress
     * must not drag the passage's highlight along with it.
     */
    const stopWatchingPlayer = subscribeToPlayer((player: SpeechPlayerState) => {
      if (player.status === "loading" && player.detached && player.ownerId) {
        const captured = capture(player.ownerId);
        if (captured) {
          void clearReadingHighlight();
          targetRef.current = captured;
        }
        return;
      }
      const target = targetRef.current;
      if (!target) return;
      // A paused passage keeps its highlight: it is the bookmark saying where
      // the reading will pick up, even while a word plays over the top of it.
      const stillOurs = player.paused?.ownerId === target.ownerId
        || (player.ownerId === target.ownerId
          && player.status !== "idle"
          && player.status !== "error");
      if (!stillOurs) release();
    });

    const stopWatchingProgress = subscribeToProgress((progress) => {
      const target = targetRef.current;
      if (!target || !progress || progress.ownerId !== target.ownerId) return;

      if (!target.started) {
        target.started = true;
        clearSelection();
      }

      const index = advance(target, progress);
      const sentence = target.sentences[index];
      if (!sentence || index === target.highlighted) return;

      const cfi = viewRef.current?.getCFI(target.index, sentence.range);
      if (!cfi) return;
      target.highlighted = index;
      void showReadingHighlight(cfi);
    });

    return () => {
      stopWatchingPlayer();
      stopWatchingProgress();
    };
  }, [clearReadingHighlight, showReadingHighlight, viewRef]);
}
