import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ArrowRightLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "./settings/aiDuration";
import { presetFor } from "./settings/aiPresets";
import Toast from "./ui/Toast";

interface AiRouteFallback {
  from_profile_id: string;
  from_label: string;
  from_provider: string;
  from_model: string;
  to_profile_id: string;
  to_label: string;
  to_provider: string;
  to_model: string;
  /** Epoch milliseconds, or `null` when the failure has no deadline. */
  recovers_at: number | null;
}

const VISIBLE_MS = 6000;

interface Notice {
  from: string;
  to: string;
  /** Milliseconds until the skipped model returns; `0` when nothing is owed. */
  remaining: number;
}

/**
 * Say so the first time a request quietly moves from a free model to one that
 * bills per use.
 *
 * Only that direction is worth interrupting for. Free to free and paid to paid
 * change nothing the user is owed a say in, and a notice for every switch would
 * train them to ignore the one that costs money. The router reports every
 * switch and this decides, because whether a model is free is a fact about the
 * catalog, which lives here.
 *
 * It never blocks: streaming continues underneath, and the toast lets itself
 * out. Interrupting a reader mid-sentence to confirm a fallback would cost more
 * than the fallback does.
 *
 * Dormant as of the DeepSeek-led catalog: no preset carries `cost: "free"` any
 * more (Ollama is `local`), so nothing can trigger it. Kept deliberately — it
 * costs nothing at runtime and revives on its own the day a free preset earns
 * its place back. Do not widen the condition to announce every switch; that is
 * a product decision, not cleanup.
 */
export default function AiRouteFallbackNotice() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    const unlisten = listen<AiRouteFallback>("ai-route-fallback", (event) => {
      const from = presetFor(event.payload.from_provider)?.cost;
      const to = presetFor(event.payload.to_provider)?.cost;
      // A custom endpoint has no known cost, so it is never announced as a
      // downgrade — guessing would be worse than staying quiet.
      if (from !== "free" || to !== "metered") return;
      // Frozen at arrival rather than read during render: a countdown here
      // would draw the eye back to a message the reader has finished with.
      const recoversAt = event.payload.recovers_at;
      setNotice({
        from: event.payload.from_label,
        to: event.payload.to_label,
        remaining: recoversAt == null ? 0 : Math.max(0, recoversAt - Date.now()),
      });
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;

  return (
    <Toast icon={<ArrowRightLeft size={14} className="shrink-0 text-accent-text" />}>
      {notice.remaining > 0
        ? t("settings.ai.fallbackToPaidIn", {
            from: notice.from,
            to: notice.to,
            duration: formatDuration(notice.remaining, t),
          })
        : t("settings.ai.fallbackToPaid", { from: notice.from, to: notice.to })}
    </Toast>
  );
}
