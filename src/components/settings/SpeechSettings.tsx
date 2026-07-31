import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Select from "../ui/Select";
import Slider from "../ui/Slider";
import {
  ensureSpeechSettings,
  speechSettings,
  subscribeToSpeechSettings,
  updateSpeechSettings,
} from "../speech/settings-store";
import { accentAvailability, subscribeToVoices } from "../speech/system-voices";
import {
  SPEECH_ACCENT_SETTING_KEY,
  SPEECH_RATE_RANGE,
  SPEECH_RATE_SETTING_KEY,
  SPEECH_SOURCE_SETTING_KEY,
  type SpeechAccent,
  type SpeechSourceId,
} from "../speech/types";
import { ROW_CONTROL_WIDTH } from "./types";

interface SpeechCacheStats {
  bytes: number;
  entries: number;
  limitBytes: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function SettingsRow({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] w-full items-center justify-between gap-4 px-1 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-text-primary">{title}</p>
        <p className="break-words text-[11px] leading-[17px] text-text-placeholder">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

export default function SpeechSettings({ showSavedToast }: { showSavedToast: (msg?: string) => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(speechSettings);
  const [rate, setRate] = useState(() => speechSettings().rate);
  const [voicesRevision, setVoicesRevision] = useState(0);
  const [cache, setCache] = useState<SpeechCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    ensureSpeechSettings();
    return subscribeToSpeechSettings((value) => {
      setSettings(value);
      setRate(value.rate);
    });
  }, []);

  useEffect(() => subscribeToVoices(() => setVoicesRevision((value) => value + 1)), []);

  const refreshCache = useCallback(() => {
    invoke<SpeechCacheStats>("speech_cache_stats")
      .then(setCache)
      .catch((error) => console.error("Failed to read speech cache stats:", error));
  }, []);

  useEffect(refreshCache, [refreshCache]);

  const persist = (values: Record<string, string>) => {
    updateSpeechSettings(values)
      .then(() => showSavedToast())
      .catch((error) => console.error("Failed to save speech settings:", error));
  };

  const availability = useMemo(
    () => accentAvailability(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on voiceschanged
    [voicesRevision],
  );
  const accentHint = () => {
    if (settings.source !== "system" || (availability.uk && availability.us)) {
      return t("settings.speech.accentHint");
    }
    // Neither installed means the system source cannot speak English at all,
    // which is a different problem from one missing accent.
    if (!availability.uk && !availability.us) return t("settings.speech.noEnglishVoices");
    return t(`speech.accentUnavailable.${availability.uk ? "us" : "uk"}`);
  };

  return (
    <div className="mx-auto w-full max-w-[620px]">
      <SettingsRow
        title={t("settings.speech.source")}
        subtitle={t(`settings.speech.sourceHint.${settings.source}`)}
      >
        <div className={ROW_CONTROL_WIDTH}>
          <Select
            label={t("settings.speech.source")}
            value={settings.source}
            onChange={(value) => persist({ [SPEECH_SOURCE_SETTING_KEY]: value as SpeechSourceId })}
            options={[
              { value: "dictionary", label: t("settings.speech.sourceOption.dictionary") },
              { value: "system", label: t("settings.speech.sourceOption.system") },
            ]}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        title={t("settings.speech.accent")}
        subtitle={accentHint()}
      >
        <div className={ROW_CONTROL_WIDTH}>
          <Select
            label={t("settings.speech.accent")}
            value={settings.accent}
            onChange={(value) => persist({ [SPEECH_ACCENT_SETTING_KEY]: value as SpeechAccent })}
            options={[
              { value: "uk", label: t("settings.speech.accentOption.uk") },
              { value: "us", label: t("settings.speech.accentOption.us") },
            ]}
          />
        </div>
      </SettingsRow>

      <div className="border-t border-border-light px-1 py-4">
        <Slider
          min={SPEECH_RATE_RANGE.min}
          max={SPEECH_RATE_RANGE.max}
          value={rate}
          onChange={setRate}
          onChangeEnd={(value) => persist({ [SPEECH_RATE_SETTING_KEY]: String(value) })}
          label={t("settings.speech.rate")}
          displayValue={`${rate.toFixed(1)}x`}
          hint={t("settings.speech.rateHint")}
        />
      </div>

      <div className="border-t border-border-light">
        <SettingsRow
          title={t("settings.speech.cache")}
          subtitle={
            cache
              ? t("settings.speech.cacheSummary", {
                  entries: cache.entries,
                  size: formatBytes(cache.bytes),
                  limit: formatBytes(cache.limitBytes),
                })
              : t("settings.speech.cacheHint")
          }
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={clearing || !cache || cache.entries === 0}
            onClick={() => {
              setClearing(true);
              invoke<SpeechCacheStats>("speech_cache_clear")
                .then((next) => {
                  setCache(next);
                  showSavedToast(t("settings.speech.cacheCleared"));
                })
                .catch((error) => console.error("Failed to clear speech cache:", error))
                .finally(() => setClearing(false));
            }}
          >
            {clearing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            {t("settings.speech.cacheClear")}
          </Button>
        </SettingsRow>
      </div>

      <p className="px-1 pt-2 text-[11px] leading-[17px] text-text-placeholder">
        {t("settings.speech.privacyNote")}
      </p>
    </div>
  );
}
