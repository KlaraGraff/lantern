import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import Toast from "./ui/Toast";

const VISIBLE_MS = 5000;

/**
 * Say, once, that the saved-word repair has started.
 *
 * `commands::vocab_gloss_backfill` rewrites vocabulary definitions that an
 * earlier defect filled with a whole learning card. It spends the reader's own
 * quota, so it is refusable in Settings → Automatic Analysis — and something
 * refusable has to be visible at least once, or the switch is for a thing
 * nobody knows is happening.
 *
 * The backend decides when there is anything to say: the event fires only when
 * the job is switched on *and* has found damaged rows, so this never announces
 * a launch where nothing happens. That is why there is no condition here — one
 * event, one notice.
 *
 * No button. There is nothing to approve (the switch already carried that
 * decision) and nothing to open (the repair leaves no page behind), so a
 * dismiss control would only be a second thing to do about a message that ends
 * on its own.
 */
export default function VocabGlossBackfillNotice() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const unlisten = listen("vocab-gloss-backfill-started", () => setVisible(true));
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!visible) return null;

  return (
    <Toast icon={<Sparkles size={14} className="shrink-0 text-accent-text" />}>
      {t("vocabGlossBackfill.toast")}
    </Toast>
  );
}
