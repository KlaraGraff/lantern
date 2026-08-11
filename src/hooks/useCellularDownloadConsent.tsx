import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import ConfirmDialog from "../components/settings/ConfirmDialog";
import { CELLULAR_CONSENT_SETTING_KEY, type CellularDownloadConsent } from "./useBooks";

/**
 * D-016's frontend half — a dialog for when `diagnoseBookFile` rejects with
 * {@link isCellularConsentError} (see `useBooks.ts`), and a `requestConsent`
 * promise a caller can `await` for the user's answer before writing it and
 * retrying the probe with `retryDiagnoseBookFileAfterConsent`.
 *
 * The two dialogs D-016 has needed so far — this one and the AI-calls one
 * `mobile-settings.md` describes — are deliberately identical in shape: same
 * sentence, same two buttons ("this will be remembered" rather than a
 * checkbox), no third option. Nothing here enforces that on a second caller;
 * it only has to stay true because both read from the same spec.
 *
 * Wired into the reader: `Reader.tsx` mounts the hook and renders `dialog`,
 * and `src/pages/reader/useReaderFileDiagnosis.ts` mints the `requestId` that
 * puts the probe on the watched path this gate lives on — it catches
 * `isCellularConsentError`, awaits `requestConsent()`, and retries with
 * `retryDiagnoseBookFileAfterConsent`, or falls back to the placeholder state
 * on a deny. `useBookAvailability.ts` still polls unwatched and so never
 * reaches the gate; that poll only asks whether the file is there, it never
 * asks for a download.
 */
export function useCellularDownloadConsent() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const resolverRef = useRef<((consent: "allow" | "deny") => void) | null>(null);

  /** Show the dialog and resolve once the user picks an answer. */
  const requestConsent = useCallback((): Promise<"allow" | "deny"> => {
    setOpen(true);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const answer = useCallback(async (consent: CellularDownloadConsent) => {
    setOpen(false);
    // The generic settings command, same as any other row — this hook does
    // not need (and must not become) a bespoke write path for one key.
    await invoke("set_setting", { key: CELLULAR_CONSENT_SETTING_KEY, value: consent });
    resolverRef.current?.(consent === "deny" ? "deny" : "allow");
    resolverRef.current = null;
  }, []);

  const dialog = open ? (
    <ConfirmDialog
      title={t("book.cellularConsent.title")}
      description={t("book.cellularConsent.body")}
      primaryLabel={t("book.cellularConsent.allow")}
      onPrimary={() => void answer("allow")}
      secondaryLabel={t("book.cellularConsent.deny")}
      onSecondary={() => void answer("deny")}
    />
  ) : null;

  return { dialog, requestConsent };
}
