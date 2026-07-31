import { useEffect, useState } from "react";
import { Bot, Radar, ScanText, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import AiSettings from "./AiSettings";
import EmbeddingSettings from "./EmbeddingSettings";
import OcrSettings from "./OcrSettings";
import SpeechSettings from "./SpeechSettings";
import type { SettingsProps } from "./types";

export type ServicesView = "models" | "embedding" | "speech" | "ocr";

interface ServicesSettingsProps extends SettingsProps {
  onSaveRef?: (save: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  initialView?: ServicesView;
}

/**
 * One home for every external engine the app talks to — chat models, the
 * retrieval model, speech and OCR. Reading behaviour lives in 阅读辅助; this
 * section is purely "what is plugged in and with which credentials".
 */
export default function ServicesSettings({
  onSaveRef,
  onDirtyChange,
  initialView,
  ...settingsProps
}: ServicesSettingsProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<ServicesView>(initialView ?? "models");

  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);

  // Only the chat-model pane has a dirty/save cycle, and it unregisters its
  // save handler on unmount. Clearing the flag keeps the modal's Save button
  // from staying lit over a pane it can no longer save.
  useEffect(() => {
    if (view !== "models") onDirtyChange?.(false);
  }, [onDirtyChange, view]);

  const views: { id: ServicesView; icon: typeof Bot; label: string }[] = [
    { id: "models", icon: Bot, label: t("settings.services.views.models") },
    { id: "embedding", icon: Radar, label: t("settings.services.views.embedding") },
    { id: "speech", icon: Volume2, label: t("settings.services.views.speech") },
    { id: "ocr", icon: ScanText, label: t("settings.services.views.ocr") },
  ];

  return (
    <div className="w-full min-w-0 pb-10">
      <div role="tablist" className="mb-4 flex min-w-0 gap-1 border-b border-border-light">
        {views.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={view === item.id}
              onClick={() => setView(item.id)}
              className={`flex h-10 min-w-0 items-center gap-1.5 border-b-2 px-3 text-[12px] font-medium ${
                view === item.id
                  ? "border-accent text-accent-text"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              <Icon size={14} className="shrink-0" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </div>

      {view === "models" && (
        <AiSettings {...settingsProps} onDirtyChange={onDirtyChange} onSaveRef={onSaveRef} />
      )}
      {view === "embedding" && <EmbeddingSettings />}
      {view === "speech" && <SpeechSettings showSavedToast={settingsProps.showSavedToast} />}
      {view === "ocr" && <OcrSettings />}
    </div>
  );
}
