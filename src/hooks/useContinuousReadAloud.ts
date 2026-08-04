import { useEffect, useMemo, useState, type RefObject } from "react";
import {
  ContinuousReadAloudController,
  type ContinuousReadState,
} from "../components/continuous-read-aloud";
import { createContinuousSpeechPlayer } from "../components/speech/continuous-player";
import { subscribeToPlayer } from "../components/speech/player";
import { createFoliateContinuousSource } from "../pages/reader/foliate-continuous-source";
import type { FoliateView } from "../pages/reader/foliate-types";

interface Options {
  bookId?: string;
  viewRef: RefObject<FoliateView | null>;
  currentCfiRef: RefObject<string | null>;
  showHighlight(cfi: string, paused: boolean): Promise<void>;
  clearHighlight(): Promise<void>;
  clearLegacyHighlight(): Promise<void>;
}

export function useContinuousReadAloud({
  bookId,
  viewRef,
  currentCfiRef,
  showHighlight,
  clearHighlight,
  clearLegacyHighlight,
}: Options) {
  const ownerId = useMemo(() => `continuous-read-aloud:${bookId ?? "unavailable"}`, [bookId]);
  const controller = useMemo(() => new ContinuousReadAloudController(
    createFoliateContinuousSource(viewRef, currentCfiRef),
    createContinuousSpeechPlayer(ownerId),
  ), [currentCfiRef, ownerId, viewRef]);
  const [state, setState] = useState<ContinuousReadState>(() => controller.snapshot());

  useEffect(() => {
    setState(controller.snapshot());
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      controller.stop();
      void clearHighlight();
    };
  }, [clearHighlight, controller]);

  useEffect(() => {
    if (!bookId) controller.stop();
  }, [bookId, controller]);

  useEffect(() => subscribeToPlayer((player) => {
    if (player.paused?.ownerId === ownerId) {
      controller.syncPlayerPaused();
      return;
    }
    if (player.ownerId === ownerId && (player.status === "loading" || player.status === "playing")) {
      controller.syncPlayerPlaying();
      return;
    }
    const snapshot = controller.snapshot();
    const active = snapshot.status === "loading" || snapshot.status === "playing" || snapshot.status === "paused";
    if (!active || !player.ownerId || player.ownerId === ownerId) return;
    if (player.detached) controller.abandon();
    else controller.syncPlayerPaused();
  }), [controller, ownerId]);

  useEffect(() => {
    if (state.current && (state.status === "playing" || state.status === "paused")) {
      void showHighlight(state.current.id, state.status === "paused");
    } else if (state.status === "idle" || state.status === "finished" || state.status === "error") {
      void clearHighlight();
    }
  }, [clearHighlight, showHighlight, state]);

  return {
    state,
    start: async (fromBeginning = false) => {
      await clearLegacyHighlight();
      await controller.start(fromBeginning);
    },
    pause: () => controller.pause(),
    resume: () => controller.resume(),
    stop: () => controller.stop(),
    previous: () => controller.skip("previous"),
    next: () => controller.skip("next"),
    setRate: (rate: number) => controller.setRate(rate),
    setCollapsed: (collapsed: boolean) => controller.setCollapsed(collapsed),
  };
}
