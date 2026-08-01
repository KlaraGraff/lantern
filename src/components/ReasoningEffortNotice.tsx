import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import Toast from "./ui/Toast";

interface ReasoningEffortCleared {
  profile_id: string;
  profile_label: string;
  effort: string;
  options: string[];
}

const VISIBLE_MS = 6000;

/**
 * Clearing an unsupported reasoning effort happens deep in the router, during a
 * request the user is watching for an answer — not for a settings change. Left
 * silent, the setting would simply be empty the next time they opened settings
 * and read as a bug, so say what happened where they already are.
 */
export default function ReasoningEffortNotice() {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<ReasoningEffortCleared | null>(null);

  useEffect(() => {
    const unlisten = listen<ReasoningEffortCleared>("ai-reasoning-effort-cleared", (event) => {
      setNotice(event.payload);
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
    <Toast icon={<AlertCircle size={14} className="shrink-0 text-accent-text" />}>
      {notice.options.length > 0
        ? t("settings.ai.reasoningEffortClearedWithOptions", {
            effort: notice.effort,
            options: notice.options.join(" / "),
          })
        : t("settings.ai.reasoningEffortCleared", { effort: notice.effort })}
    </Toast>
  );
}
