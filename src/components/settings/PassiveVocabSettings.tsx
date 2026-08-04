import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import {
  parsePassiveVocabSettings,
  rollbackPassiveVocabSettings,
  updatePassiveVocabSettings,
  type PassiveVocabDensity,
  type PassiveVocabSettings as PassiveVocabSettingsValue,
  type PassiveVocabStyle,
} from "../passive-vocab";
import { ROW_CONTROL_WIDTH, type SettingsProps } from "./types";
import { notifyReadingAssistanceSettingsChanged } from "../reading-assistance-events";

export default function PassiveVocabSettings({ settings, saveBulk, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [passive, setPassive] = useState<PassiveVocabSettingsValue>(() => parsePassiveVocabSettings(settings));
  const [saveFailed, setSaveFailed] = useState(false);
  const revision = useRef(0);

  useEffect(() => {
    setPassive(parsePassiveVocabSettings(settings));
    setSaveFailed(false);
  }, [settings]); // Settings events also make the reader shortcut update this form.

  const update = (patch: Partial<PassiveVocabSettingsValue>) => {
    const mutation = updatePassiveVocabSettings(passive, patch);
    const request = ++revision.current;
    setSaveFailed(false);
    setPassive(mutation.next);
    void saveBulk(mutation.values)
      .then(() => {
        void notifyReadingAssistanceSettingsChanged(Object.keys(mutation.values)).catch((error) => {
          console.error("Failed to notify passive vocabulary settings change:", error);
        });
        showSavedToast();
      })
      .catch((error) => {
        console.error("Failed to save passive vocabulary settings:", error);
        if (request === revision.current) {
          setPassive((current) => rollbackPassiveVocabSettings(current, mutation));
          setSaveFailed(true);
        }
      });
  };

  return <section className="border-t border-border-light pt-4 mt-2">
    {saveFailed && <p role="alert" className="mb-3 rounded-md bg-danger-bg px-3 py-2 text-[12px] text-danger-text">{t("settings.passiveVocab.saveFailed")}</p>}
    <div className="flex items-center justify-between gap-4">
      <div>
        <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.passiveVocab.title")}</p>
        <p className="text-[12px] text-text-muted mt-0.5">{t("settings.passiveVocab.hint")}</p>
      </div>
      <Toggle label={t("settings.passiveVocab.title")} checked={passive.enabled} onChange={(enabled) => update({ enabled })} />
    </div>
    {passive.enabled && <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] text-text-primary">{t("settings.passiveVocab.style")}</span>
        <Select className={ROW_CONTROL_WIDTH} value={passive.style} onChange={(style) => update({ style: style as PassiveVocabStyle })} options={[
          { value: "ruby", label: t("settings.passiveVocab.styleRuby") },
          { value: "margin", label: t("settings.passiveVocab.styleMargin") },
        ]} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13px] text-text-primary">{t("settings.passiveVocab.density")}</span>
        <Select className={ROW_CONTROL_WIDTH} value={passive.density} onChange={(density) => update({ density: density as PassiveVocabDensity })} options={[
          { value: "low", label: t("settings.passiveVocab.densityLow") },
          { value: "medium", label: t("settings.passiveVocab.densityMedium") },
          { value: "high", label: t("settings.passiveVocab.densityHigh") },
        ]} />
      </div>
    </div>}
  </section>;
}
