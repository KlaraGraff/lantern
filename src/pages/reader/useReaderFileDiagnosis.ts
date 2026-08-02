import { useEffect, type Dispatch, type SetStateAction } from "react";
import { diagnoseBookFile } from "../../hooks/useBooks";
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
 */
export function useReaderFileDiagnosis(
  bookId: string | undefined,
  readerError: ReaderOpenError | null,
  setReaderError: Dispatch<SetStateAction<ReaderOpenError | null>>,
) {
  const undiagnosed = readerError !== null && readerError.fileStatus === undefined;

  useEffect(() => {
    if (!bookId || !undiagnosed) return;
    let cancelled = false;

    diagnoseBookFile(bookId)
      .then((result) => {
        if (cancelled) return;
        // Merged into whatever error is current rather than the one captured
        // when the effect ran: a retry can fail again while the probe is in
        // flight, and the answer is about the file either way.
        setReaderError((current) => (
          current && current.fileStatus === undefined
            ? { ...current, fileStatus: result.status }
            : current
        ));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [bookId, undiagnosed, setReaderError]);
}
