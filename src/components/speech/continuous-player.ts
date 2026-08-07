import { planSpeechPlayback } from "../../hooks/useSpeech";
import { createSentencePrefetch } from "./continuous-prefetch";
import {
  cancelSpeech,
  pauseSpeech,
  playerState,
  resumeSpeech,
  speak,
  subscribeToPlayer,
} from "./player";
import { speechSettings } from "./settings-store";
import type { ContinuousReadPlayer, ContinuousReadSentence } from "../continuous-read-aloud";
import type { SpeechSettings } from "./types";

export function createContinuousSpeechPlayer(ownerId: string): ContinuousReadPlayer {
  const ahead = createSentencePrefetch();
  const planFor = (sentence: ContinuousReadSentence, settings: SpeechSettings, rate: number) =>
    () => planSpeechPlayback(sentence.text, "passage", settings, {
      language: sentence.language,
      rate,
    });

  return {
    play(sentence: ContinuousReadSentence, rate: number) {
      return new Promise<void>((resolve, reject) => {
        let owned = false;
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          if (error) reject(error);
          else resolve();
        };
        const watch = (state: ReturnType<typeof playerState>) => {
          if (state.ownerId === ownerId || state.paused?.ownerId === ownerId) owned = true;
          if (state.ownerId === ownerId && state.status === "error") {
            settle(new Error("CONTINUOUS_SPEECH_FAILED"));
            return;
          }
          if (!owned || state.paused?.ownerId === ownerId) return;
          if (state.ownerId && state.ownerId !== ownerId) {
            settle(new Error("CONTINUOUS_SPEECH_REPLACED"));
          } else if (state.ownerId === null) {
            settle();
          }
        };
        const unsubscribe = subscribeToPlayer(watch);
        const settings = speechSettings();
        void speak(
          ownerId,
          async () => ahead.take({ id: sentence.id, settings }, planFor(sentence, settings, rate), rate),
          { detached: true },
        ).catch((error) => settle(error instanceof Error ? error : new Error(String(error))));
      });
    },
    prefetch(sentence: ContinuousReadSentence, rate: number) {
      const settings = speechSettings();
      ahead.warm({ id: sentence.id, settings }, planFor(sentence, settings, rate));
    },
    pause: pauseSpeech,
    resume: resumeSpeech,
    // Deliberately not dropping the warmed clip: `stop` is also how skipping
    // silences the sentence it is leaving, and the sentence it is skipping *to*
    // is usually the one already warmed. Throwing it away there would spend a
    // second request on audio that had already been paid for.
    stop: cancelSpeech,
  };
}
