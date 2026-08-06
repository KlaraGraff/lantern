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
 * Three parts, in the order they are useful: what is missing, what Lantern
 * observed, and the way out. The way out comes before the diagnosis in
 * prominence — entering the key here is the only move that is both fast and
 * certain, and a reader who takes it never needs to read the rest.
 *
 * There is deliberately no spinner and no progress bar. A spinner promises that
 * waiting works; here waiting may never finish, and the honest shape of that is
 * a button that says what it can do.
 *
 * See `missing-key.ts` for which state is chosen when, and D-018 for why the
 * inference is allowed to be stated at all.
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

      {state.kind === "waiting" && (
        <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
          {t("settings.ai.missingKey.waiting")}
        </p>
      )}
      {state.kind === "inferred" && (
        <>
          <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
            {t("settings.ai.missingKey.evidence", { peer: state.peer })}
          </p>
          <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
            {t("settings.ai.missingKey.inference")}
          </p>
        </>
      )}
      {state.kind === "alone" && (
        <p className="mt-2 text-[11.5px] leading-[1.7] text-text-secondary">
          {t("settings.ai.missingKey.alone")}
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

      {state.kind === "inferred" && (
        <p className="mt-3 border-t border-warning/20 pt-3 text-[11px] leading-[1.65] text-text-muted">
          {t("settings.ai.missingKey.checkSwitch")}
        </p>
      )}
    </section>
  );
}
