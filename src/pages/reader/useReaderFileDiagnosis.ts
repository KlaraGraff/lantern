import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  bookDownloadEventName,
  diagnoseBookFile,
  isCellularConsentError,
  retryDiagnoseBookFileAfterConsent,
  type BookAvailability,
  type BookDownloadProgress,
} from "../../hooks/useBooks";
import { createUuid } from "../../utils/randomUuid";
import type { ReaderOpenError } from "./reader-open-error";

/**
 * Ask what the file is doing, once, after the reader has failed to open it —
 * and, when the answer is "it is still in iCloud", stay on the line while it
 * comes down.
 *
 * The alternative — probing every book on every library refresh, so the answer
 * is ready before it is needed — costs one file read per book per refresh to
 * answer a question that is almost always "it is fine". Probing at the failure
 * point costs one read per actual failure and cannot produce a false negative,
 * because there is nothing to race: the open has already finished failing.
 *
 * A failed probe leaves `fileStatus` unset rather than guessing, and the effect
 * does not retry — the error screen is written to read without it.
 *
 * The probe carries a request id, which makes it the app's one *watched*
 * download path (D-013) and therefore the one place the D-016 cellular gate
 * can fire: on cellular with no remembered answer the probe rejects with the
 * consent code instead of fetching, `requestConsent` puts the question on
 * screen, and "allow" re-runs the same watched probe. "Deny" records what the
 * gate already established — the file is an evicted placeholder, the only
 * state the gate fires on — so the error screen explains the file instead of
 * showing the parser's red herring.
 *
 * That same request id is a channel, and this hook is what listens on it.
 * Without a subscriber the backend's watch still ran, but it ran behind a
 * screen that said the book could not be opened and never took the word back:
 * the bytes landed, and the reader went on showing the failure until somebody
 * pressed Retry. So the events are surfaced as {@link download} for the screen
 * to render, and `onReady` fires once the file opens — that is the half of
 * D-013 that closes the loop, and it is why the download's own terminal states
 * (`cancelled`, `failed`) deliberately do *not* call it.
 *
 * Subscription order matters and is the backend's stated contract: listen
 * first, invoke second. `start_watch` can emit its first event during the
 * invoke, so a listener registered afterwards would miss it — and on a book
 * already most of the way down, that first event can also be the last.
 */
export function useReaderFileDiagnosis(
  bookId: string | undefined,
  readerError: ReaderOpenError | null,
  setReaderError: Dispatch<SetStateAction<ReaderOpenError | null>>,
  requestConsent: () => Promise<"allow" | "deny">,
  onReady?: () => void,
) {
  const undiagnosed = readerError !== null && readerError.fileStatus === undefined;
  const [download, setDownload] = useState<BookDownloadProgress | null>(null);

  useEffect(() => {
    if (!bookId || !undiagnosed) return;
    let cancelled = false;
    // Fresh per run: the backend refuses to reuse a live watch's request id.
    const requestId = createUuid();

    // Merged into whatever error is current rather than the one captured
    // when the effect ran: a retry can fail again while the probe is in
    // flight, and the answer is about the file either way.
    const applyStatus = (status: BookAvailability["status"]) => {
      if (cancelled) return;
      setReaderError((current) => (
        current && current.fileStatus === undefined
          ? { ...current, fileStatus: status }
          : current
      ));
    };

    let unlisten: (() => void) | undefined;
    const run = async () => {
      unlisten = await listen<BookDownloadProgress>(
        bookDownloadEventName(requestId),
        ({ payload }) => {
          if (cancelled) return;
          setDownload(payload);
          // `ready` is the only phase the reader can act on. The others are
          // states to show, not to move on from: a failed or cancelled
          // download leaves the same unopenable file that was already on
          // screen.
          if (payload.phase === "ready") onReady?.();
        },
      );
      if (cancelled) {
        unlisten();
        return;
      }

      try {
        const result = await diagnoseBookFile(bookId, requestId);
        applyStatus(result.status);
      } catch (error) {
        if (!isCellularConsentError(error)) return;
        const answer = await requestConsent();
        if (cancelled) return;
        if (answer === "allow") {
          const result = await retryDiagnoseBookFileAfterConsent(bookId, requestId);
          applyStatus(result.status);
        } else {
          applyStatus("icloud_placeholder");
        }
      }
    };
    run().catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [bookId, undiagnosed, setReaderError, requestConsent, onReady]);

  // Cleared alongside the error it describes, so a second failure never opens
  // on the previous book's progress bar.
  useEffect(() => {
    if (readerError === null) setDownload(null);
  }, [readerError]);

  return { download };
}
