import { planSpeechPlayback } from "../../hooks/useSpeech";
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

export function createContinuousSpeechPlayer(ownerId: string): ContinuousReadPlayer {
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
        void speak(
          ownerId,
          async () => planSpeechPlayback(sentence.text, "passage", speechSettings(), {
            language: sentence.language,
            rate,
          }),
          { detached: true },
        ).catch((error) => settle(error instanceof Error ? error : new Error(String(error))));
      });
    },
    pause: pauseSpeech,
    resume: resumeSpeech,
    stop: cancelSpeech,
  };
}
