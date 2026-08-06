import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  diagnoseBookFile,
  isCellularConsentError,
  retryDiagnoseBookFileAfterConsent,
  type BookAvailability,
} from "../../hooks/useBooks";
import { createUuid } from "../../utils/randomUuid";
import type { ReaderOpenError } from "./reader-open-error";

/**
 * Ask what the file is doing, once, after the reader has failed to open it.
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
 */
export function useReaderFileDiagnosis(
  bookId: string | undefined,
  readerError: ReaderOpenError | null,
  setReaderError: Dispatch<SetStateAction<ReaderOpenError | null>>,
  requestConsent: () => Promise<"allow" | "deny">,
) {
  const undiagnosed = readerError !== null && readerError.fileStatus === undefined;

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

    diagnoseBookFile(bookId, requestId)
      .then((result) => applyStatus(result.status))
      .catch(async (error) => {
        if (!isCellularConsentError(error)) return;
        const answer = await requestConsent();
        if (cancelled) return;
        if (answer === "allow") {
          const result = await retryDiagnoseBookFileAfterConsent(bookId, requestId);
          applyStatus(result.status);
        } else {
          applyStatus("icloud_placeholder");
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [bookId, undiagnosed, setReaderError, requestConsent]);
}
