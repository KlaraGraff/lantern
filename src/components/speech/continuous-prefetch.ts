// Extension spelled out because the unit tests load this module through Node's
// type stripping, which does not resolve extensionless paths.
import type { Playback, PlaybackStep } from "./player.ts";

/**
 * One sentence's audio, fetched while the sentence before it is still playing.
 *
 * Continuous reading speaks a sentence at a time, and each sentence used to be
 * planned and synthesised only once the previous one had fallen silent — so
 * every sentence boundary was a full request round trip of dead air. Exactly one
 * sentence is warmed, and only while its predecessor is speaking, which is the
 * same rule the player's own chunk queue already follows: on a metered provider
 * nothing is paid for until playback is demonstrably heading there.
 *
 * There is no explicit discard. A warmed clip is replaced by the next one warmed
 * and dies with the run that owns it, so the slot holds at most one sentence of
 * audio — and a clip that has already been paid for survives a skip onto it
 * rather than being thrown away and bought twice.
 */

/** What makes a warmed clip the right clip. Compared by identity, not by value. */
export interface PrefetchKey {
  /** The sentence's stable id — a CFI, in the reader. */
  id: string;
  /**
   * The speech settings the clip was planned against. A different object means
   * source, accent or voice changed and the warmed clip is the wrong one.
   */
  settings: unknown;
}

export interface SentencePrefetch {
  /**
   * Starts fetching this sentence, replacing whatever else was warm. Warming the
   * sentence that is already warm is free and does not re-request it.
   */
  warm(key: PrefetchKey, plan: () => PlaybackStep[]): void;
  /**
   * The steps to play now. Consumes the warmed fetch when it is for this
   * sentence, and otherwise plans fresh — leaving anything warm alone, since a
   * detour (a replayed sentence after a pause) does not invalidate what comes
   * after it.
   */
  take(key: PrefetchKey, plan: () => PlaybackStep[], rate: number): PlaybackStep[];
}

/**
 * Rate rides on the clip rather than being baked into it — the synthesizers
 * return audio at one speed and the player varies playback — so a clip warmed
 * before the reader moved the speed slider is still the right clip.
 */
function atRate(playback: Playback, rate: number): Playback {
  if (playback.rate === rate) return playback;
  return { ...playback, rate };
}

function atRateStep(step: PlaybackStep, rate: number): PlaybackStep {
  return async () => atRate(await step(), rate);
}

interface Warmed {
  key: PrefetchKey;
  steps: PlaybackStep[];
  /** The first step, already in flight. Later steps are the player's to fetch. */
  first: Promise<Playback>;
}

export function createSentencePrefetch(): SentencePrefetch {
  let warmed: Warmed | null = null;

  const matches = (key: PrefetchKey) =>
    warmed !== null && warmed.key.id === key.id && warmed.key.settings === key.settings;

  return {
    warm(key, plan) {
      if (matches(key)) return;
      const steps = plan();
      if (steps.length === 0) {
        warmed = null;
        return;
      }
      const first = steps[0]();
      // A warmed clip nobody ends up playing must not surface its failure as an
      // unhandled rejection; `take` re-reads the same promise and sees it there.
      first.catch(() => {});
      warmed = { key, steps, first };
    },
    take(key, plan, rate) {
      if (!matches(key)) return plan().map((step) => atRateStep(step, rate));
      const hit = warmed!;
      warmed = null;
      const first: PlaybackStep = async () => {
        try {
          return atRate(await hit.first, rate);
        } catch {
          // The sentence is due now, and one failed request is not a reason to
          // skip it — ask again, and let the ordinary fallback chain answer.
          return atRate(await hit.steps[0](), rate);
        }
      };
      return [first, ...hit.steps.slice(1).map((step) => atRateStep(step, rate))];
    },
  };
}
