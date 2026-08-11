import { KeyRound, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import type { MissingKeyState } from "./missing-key";

interface MissingKeyNoticeProps {
  /** The model whose key did not arrive. */
  name: string;
  state: MissingKeyState;
  rechecking: boolean;
  onEnterKey: () => void;
  onRecheck: () => void;
}

/**
 * The pane a reader lands on when a model synced across but its key did not.
 *
 * Three parts, in the order they are useful: what is missing, why — stated as
 * fact, not diagnosed — and the way out. Lantern keeps every API key and OAuth
 * token in one local file that never leaves the device it was entered on (see
 * `src-tauri/src/secrets.rs`), so a credential never following its model's
 * settings across devices is the product working as built, not a fault to
 * chase down. The way out comes before that explanation in prominence anyway
 * — entering the key here is the only move that is both fast and certain, and
 * a reader who takes it never needs to read the rest.
 *
 * There is deliberately no spinner and no progress bar. A spinner promises
 * that waiting works; nothing here is ever in flight to wait for.
 *
 * See `missing-key.ts` for what each state still tracks, and why the machine
 * stays even though its states mostly render the same copy today.
 */
export default function MissingKeyNotice({
  name,
  state,
  rechecking,
  onEnterKey,
  onRecheck,
}: MissingKeyNoticeProps) {
  const { t } = useTranslation();
  if (state.kind === "none") return null;

  return (
    <section className="mt-3 rounded-lg border border-warning/30 bg-warning/[0.07] px-3.5 py-3.5">
      <h4 className="flex items-start gap-2 text-[13px] font-medium leading-5 text-warning">
        <KeyRound size={15} className="mt-0.5 shrink-0" />
        {t("settings.ai.missingKey.title", { name })}
      </h4>
      <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
        {t("settings.ai.missingKey.body")}
      </p>
      <p className="mt-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[11px] leading-5 text-warning">
        {t("settings.ai.missingKey.observation", { name })}
      </p>

      {/* `waiting` and `alone` add nothing here — both render the shared copy
          above and stop. Only `inferred` has something extra to say, and it
          is a fact (where the configuration came from), not a conclusion
          about the key. See missing-key.ts for why the states stay distinct
          in code even though two of them look identical on screen. */}
      {state.kind === "inferred" && (
        <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
          {t("settings.ai.missingKey.evidence", { peer: state.peer })}
        </p>
      )}

      <Button
        variant="primary"
        size="md"
        className="mt-3.5 w-full justify-center touch:h-12"
        onClick={onEnterKey}
      >
        {t("settings.ai.missingKey.enterKey")}
      </Button>
      <p className="mt-1.5 text-[11px] leading-[1.65] text-text-muted">
        {t("settings.ai.missingKey.enterKeyHint")}
      </p>

      <Button
        variant="secondary"
        size="md"
        disabled={rechecking}
        className="mt-3 w-full justify-center touch:h-12"
        onClick={onRecheck}
      >
        <RefreshCw size={14} />
        {t("settings.ai.missingKey.recheck")}
      </Button>
      <p className="mt-1.5 text-[11px] leading-[1.65] text-text-muted">
        {t("settings.ai.missingKey.recheckHint")}
      </p>
    </section>
  );
}
