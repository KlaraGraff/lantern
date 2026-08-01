import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Input from "../ui/Input";
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
  SPEECH_CUSTOM_BASE_URL_KEY,
  SPEECH_CUSTOM_MODEL_KEY,
  SPEECH_CUSTOM_VOICE_UK_KEY,
  SPEECH_CUSTOM_VOICE_US_KEY,
  SPEECH_RATE_PRESETS,
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

/** `1x`, `1.25x` — trailing zeros read as false precision on a speed chip. */
function formatRate(rate: number): string {
  return String(Number(rate.toFixed(2)));
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

/** Commits on blur or Enter, so a base URL is not saved one keystroke at a time. */
function TextSettingRow({
  title,
  subtitle,
  value,
  placeholder,
  type,
  width = ROW_CONTROL_WIDTH,
  onChange,
  onCommit,
}: {
  title: string;
  subtitle: string;
  value: string;
  placeholder?: string;
  type?: string;
  width?: string;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <SettingsRow title={title} subtitle={subtitle}>
      <div className={width}>
        <Input
          value={value}
          type={type}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>
    </SettingsRow>
  );
}

export default function SpeechSettings({ showSavedToast }: { showSavedToast: (msg?: string) => void }) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(speechSettings);
  const [rate, setRate] = useState(() => speechSettings().rate);
  const [custom, setCustom] = useState(() => speechSettings().custom);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [voicesRevision, setVoicesRevision] = useState(0);
  const [cache, setCache] = useState<SpeechCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [rateDraft, setRateDraft] = useState("");

  useEffect(() => {
    ensureSpeechSettings();
    return subscribeToSpeechSettings((value) => {
      setSettings(value);
      setRate(value.rate);
      setCustom(value.custom);
    });
  }, []);

  const refreshKeyState = useCallback(() => {
    invoke<boolean>("speech_custom_key_configured")
      .then(setKeyConfigured)
      .catch((error) => console.error("Failed to read speech key state:", error));
  }, []);

  useEffect(refreshKeyState, [refreshKeyState]);

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

  const clampRate = (value: number) =>
    Math.min(SPEECH_RATE_RANGE.max, Math.max(SPEECH_RATE_RANGE.min, value));

  const commitRate = (value: number) => {
    setRate(value);
    persist({ [SPEECH_RATE_SETTING_KEY]: String(value) });
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
              { value: "custom", label: t("settings.speech.sourceOption.custom") },
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

      {/* Always shown, never gated on the source being active: you have to be
          able to set a provider up *before* switching to it, or the switch
          leaves playback broken until you finish typing. */}
      <div className="border-t border-border-light pt-1">
        <div className="px-1 pt-2 pb-1">
          <p className="text-[12px] font-semibold text-text-primary">
            {t("settings.speech.custom.section")}
          </p>
          <p className="mt-0.5 text-[11px] leading-[17px] text-text-placeholder">
            {settings.source === "custom"
              ? t("settings.speech.custom.sectionActive")
              : t("settings.speech.custom.sectionInactive")}
          </p>
        </div>
        <div>
          <TextSettingRow
            title={t("settings.speech.custom.baseUrl")}
            subtitle={t("settings.speech.custom.baseUrlHint")}
            value={custom.baseUrl}
            placeholder="https://api.openai.com/v1"
            width="w-[280px] shrink-0"
            onChange={(value) => setCustom((current) => ({ ...current, baseUrl: value }))}
            onCommit={() => persist({ [SPEECH_CUSTOM_BASE_URL_KEY]: custom.baseUrl.trim() })}
          />
          <TextSettingRow
            title={t("settings.speech.custom.model")}
            subtitle={t("settings.speech.custom.modelHint")}
            value={custom.model}
            placeholder="gpt-4o-mini-tts"
            onChange={(value) => setCustom((current) => ({ ...current, model: value }))}
            onCommit={() => persist({ [SPEECH_CUSTOM_MODEL_KEY]: custom.model.trim() })}
          />
          <TextSettingRow
            title={t("settings.speech.custom.voiceUk")}
            subtitle={t("settings.speech.custom.voiceUkHint")}
            value={custom.voiceUk}
            placeholder={custom.voiceUs || "alloy"}
            onChange={(value) => setCustom((current) => ({ ...current, voiceUk: value }))}
            onCommit={() => persist({ [SPEECH_CUSTOM_VOICE_UK_KEY]: custom.voiceUk.trim() })}
          />
          <TextSettingRow
            title={t("settings.speech.custom.voiceUs")}
            subtitle={t("settings.speech.custom.voiceUsHint")}
            value={custom.voiceUs}
            placeholder="nova"
            onChange={(value) => setCustom((current) => ({ ...current, voiceUs: value }))}
            onCommit={() => persist({ [SPEECH_CUSTOM_VOICE_US_KEY]: custom.voiceUs.trim() })}
          />
          <SettingsRow
            title={t("settings.speech.custom.apiKey")}
            subtitle={keyConfigured
              ? t("settings.speech.custom.apiKeyConfigured")
              : t("settings.speech.custom.apiKeyHint")}
          >
            <div className="flex items-center gap-2">
              <div className="w-[180px] shrink-0">
                <Input
                  type="password"
                  value={keyDraft}
                  autoComplete="off"
                  placeholder={keyConfigured ? "••••••••••••" : "sk-…"}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                disabled={keyDraft.trim().length === 0 && !keyConfigured}
                onClick={() => {
                  // An empty draft on a configured key means "disconnect".
                  invoke("set_speech_custom_key", { value: keyDraft })
                    .then(() => {
                      setKeyDraft("");
                      refreshKeyState();
                      showSavedToast(keyDraft.trim()
                        ? t("settings.speech.custom.apiKeySaved")
                        : t("settings.speech.custom.apiKeyCleared"));
                    })
                    .catch((error) => console.error("Failed to save speech key:", error));
                }}
              >
                {keyDraft.trim() ? t("common.save") : t("settings.speech.custom.apiKeyClear")}
              </Button>
            </div>
          </SettingsRow>
          <p className="px-1 pb-2 text-[11px] leading-[17px] text-text-placeholder">
            {t("settings.speech.custom.meteredNote")}
          </p>
        </div>
      </div>

      <div className="border-t border-border-light px-1 py-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {SPEECH_RATE_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              aria-pressed={rate === preset}
              onClick={() => commitRate(preset)}
              className={`rounded-lg border px-2.5 py-1 text-[12px] tabular-nums transition-colors ${
                rate === preset
                  ? "border-transparent bg-accent-bg text-accent-text"
                  : "border-border text-text-secondary hover:bg-bg-input"
              }`}
            >
              {formatRate(preset)}x
            </button>
          ))}
          <Input
            className="ml-1 w-[72px]"
            value={rateDraft}
            inputMode="decimal"
            placeholder={t("settings.speech.rateCustom")}
            onChange={(event) => setRateDraft(event.target.value)}
            onBlur={() => {
              const parsed = Number.parseFloat(rateDraft);
              if (Number.isFinite(parsed)) commitRate(clampRate(parsed));
              setRateDraft("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </div>
        <Slider
          min={SPEECH_RATE_RANGE.min}
          max={SPEECH_RATE_RANGE.max}
          step={SPEECH_RATE_RANGE.step}
          value={rate}
          onChange={setRate}
          onChangeEnd={(value) => persist({ [SPEECH_RATE_SETTING_KEY]: String(value) })}
          label={t("settings.speech.rate")}
          displayValue={`${formatRate(rate)}x`}
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
