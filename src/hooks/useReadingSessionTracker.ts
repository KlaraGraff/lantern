import { useEffect, useState } from "react";
import {
  browserReadingSessionClock,
  READING_SESSION_HEARTBEAT_MS,
  ReadingSessionTracker,
  type ReadingSessionInput,
} from "../pages/reading-stats/session-tracker";

export interface UseReadingSessionTrackerOptions {
  bookId: string | null;
  enabled: boolean;
  readerReady: boolean;
  record(input: ReadingSessionInput): Promise<unknown>;
  activityTarget?: EventTarget | null;
}

export const READING_ACTIVITY_EVENT = "lantern-reading-activity";
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "scroll", "touchstart", READING_ACTIVITY_EVENT] as const;

export function useReadingSessionTracker({
  bookId,
  enabled,
  readerReady,
  record,
  activityTarget,
}: UseReadingSessionTrackerOptions): void {
  const [tracker] = useState(() => new ReadingSessionTracker({
    clock: browserReadingSessionClock,
    record,
  }));

  useEffect(() => tracker.setRecord(record), [record, tracker]);

  useEffect(() => {
    tracker.setBook(enabled && readerReady ? bookId : null);
  }, [bookId, enabled, readerReady, tracker]);

  useEffect(() => {
    if (!enabled || !readerReady || !bookId) return;
    const target = activityTarget ?? window;
    const onActivity = () => tracker.activity();
    const onBlur = () => tracker.blur();
    const onFocus = () => tracker.focus();
    const onVisibility = () => tracker.visibilityChange(document.visibilityState === "hidden");
    const onPageHide = () => tracker.pageHide();

    for (const event of ACTIVITY_EVENTS) target.addEventListener(event, onActivity, { passive: true });
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    const heartbeat = window.setInterval(() => tracker.heartbeat(), READING_SESSION_HEARTBEAT_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) target.removeEventListener(event, onActivity);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(heartbeat);
      void tracker.stop();
    };
  }, [activityTarget, bookId, enabled, readerReady, tracker]);
}
