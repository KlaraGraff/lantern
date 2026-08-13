import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import ComboField from "../ui/ComboField";
import Input from "../ui/Input";
import Select from "../ui/Select";
import Slider from "../ui/Slider";
import Toggle from "../ui/Toggle";
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
  SPEECH_CUSTOM_CACHE_PASSAGES_KEY,
  SPEECH_CUSTOM_MODEL_KEY,
  SPEECH_CUSTOM_VOICE_UK_KEY,
  SPEECH_CUSTOM_SPEED_KEY,
  SPEECH_CUSTOM_SPEED_RANGE,
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

/** Voice names this endpoint reported when it rejected one, and when. */
interface SpeechVoiceHints {
  options: string[];
  updated_at: number | null;
}

const NO_VOICE_HINTS: SpeechVoiceHints = { options: [], updated_at: null };

/** OpenAI's own voices — the only names that are right by default, since the
 *  custom source is an OpenAI-compatible endpoint before it is anything else. */
const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];

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
  stackOnNarrow = false,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  /** The control needs more room than `ROW_CONTROL_WIDTH` genuinely fits (a
   * URL field, a model combo) — below `md` the label goes on its own line and
   * the control takes the full row width instead of being squeezed into
   * whatever the label left over. */
  stackOnNarrow?: boolean;
}) {
  return (
    <div
      className={`flex min-h-[52px] w-full gap-4 px-1 py-1.5 ${
        stackOnNarrow
          ? "flex-col items-stretch gap-2 md:flex-row md:items-center md:justify-between md:gap-4"
          : "items-center justify-between"
      }`}
    >
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
  stackOnNarrow = false,
  onChange,
  onCommit,
}: {
  title: string;
  subtitle: string;
  value: string;
  placeholder?: string;
  type?: string;
  width?: string;
  stackOnNarrow?: boolean;
  onChange: (value: string) => void;
  onCommit: () => void;
}) {
  return (
    <SettingsRow title={title} subtitle={subtitle} stackOnNarrow={stackOnNarrow}>
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
  const [speedDraft, setSpeedDraft] = useState(() => String(speechSettings().custom.speed));
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [voiceHints, setVoiceHints] = useState<SpeechVoiceHints>(NO_VOICE_HINTS);

  useEffect(() => {
    ensureSpeechSettings();
    return subscribeToSpeechSettings((value) => {
      setSettings(value);
      setRate(value.rate);
      setCustom(value.custom);
      setSpeedDraft(String(value.custom.speed));
    });
  }, []);

  const refreshKeyState = useCallback(() => {
    invoke<boolean>("speech_custom_key_configured")
      .then(setKeyConfigured)
      .catch((error) => console.error("Failed to read speech key state:", error));
  }, []);

  useEffect(refreshKeyState, [refreshKeyState]);

  useEffect(() => subscribeToVoices(() => setVoicesRevision((value) => value + 1)), []);

  // Learned during playback, not here, so the endpoint the fields point at is
  // the only thing worth re-reading them for.
  useEffect(() => {
    let active = true;
    invoke<SpeechVoiceHints>("speech_voice_options")
      .then((hints) => {
        if (active) setVoiceHints(hints);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // Keyed on the saved endpoint, not the draft: the lookup is by what is
    // actually stored, and a draft changes on every keystroke.
  }, [settings.custom.baseUrl, settings.custom.model]);

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

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelError(null);
    try {
      // Unfiltered on purpose: a self-hosted gateway can name its speech model
      // anything, so hiding rows by keyword would hide valid choices.
      setModels(await invoke<string[]>("speech_list_models"));
    } catch (error) {
      setModels([]);
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingModels(false);
    }
  };

  const forgetVoiceOptions = async () => {
    try {
      await invoke("speech_forget_voice_options");
      setVoiceHints(NO_VOICE_HINTS);
    } catch (error) {
      console.error("Failed to forget speech voice options:", error);
    }
  };

  // Kept apart from the built-in names rather than merged: which voices this
  // endpoint actually reported is the useful half of the information.
  const voiceGroups = useMemo(
    () => [
      ...(voiceHints.options.length > 0
        ? [{ label: t("settings.speech.custom.voiceGroupReported"), options: voiceHints.options }]
        : []),
      {
        label: t("settings.speech.custom.voiceGroupBuiltIn"),
        options: OPENAI_VOICES.filter((voice) => !voiceHints.options.includes(voice)),
      },
    ],
    [t, voiceHints.options],
  );

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
            value={settings.source}
            onChange={(value) => persist({ [SPEECH_SOURCE_SETTING_KEY]: value as SpeechSourceId })}
            options={[
              { value: "auto", label: t("settings.speech.sourceOption.auto") },
              { value: "dictionary", label: t("settings.speech.sourceOption.dictionary") },
              { value: "system", label: t("settings.speech.sourceOption.system") },
              { value: "edge", label: t("settings.speech.sourceOption.edge") },
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
            width="w-full md:w-[280px] md:shrink-0"
            stackOnNarrow
            onChange={(value) => setCustom((current) => ({ ...current, baseUrl: value }))}
            onCommit={() => persist({ [SPEECH_CUSTOM_BASE_URL_KEY]: custom.baseUrl.trim() })}
          />
          <SettingsRow
            title={t("settings.speech.custom.model")}
            subtitle={modelError ?? t("settings.speech.custom.modelHint")}
            stackOnNarrow
          >
            <div className="w-full md:w-[224px] md:shrink-0">
              <ComboField
                label={t("settings.speech.custom.model")}
                value={custom.model}
                placeholder="gpt-4o-mini-tts"
                groups={
                  models.length > 0
                    ? [{ label: t("settings.speech.custom.modelGroupFetched"), options: models }]
                    : []
                }
                onChange={(model) => setCustom((current) => ({ ...current, model }))}
                onCommit={(model) => persist({ [SPEECH_CUSTOM_MODEL_KEY]: model.trim() })}
                onRefresh={() => void fetchModels()}
                refreshing={loadingModels}
                refreshLabel={t("settings.speech.custom.fetchModels")}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings.speech.custom.speed")}
            subtitle={t("settings.speech.custom.speedHint")}
          >
            <div className={ROW_CONTROL_WIDTH}>
              <Input
                value={speedDraft}
                inputMode="decimal"
                placeholder="1.0"
                onChange={(event) => setSpeedDraft(event.target.value)}
                onBlur={() => {
                  const parsed = Number.parseFloat(speedDraft);
                  const next = Number.isFinite(parsed)
                    ? Math.min(
                        SPEECH_CUSTOM_SPEED_RANGE.max,
                        Math.max(SPEECH_CUSTOM_SPEED_RANGE.min, parsed),
                      )
                    : custom.speed;
                  setSpeedDraft(String(next));
                  if (next !== custom.speed) persist({ [SPEECH_CUSTOM_SPEED_KEY]: String(next) });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings.speech.custom.voiceUk")}
            subtitle={t("settings.speech.custom.voiceUkHint")}
          >
            <div className={ROW_CONTROL_WIDTH}>
              <ComboField
                label={t("settings.speech.custom.voiceUk")}
                value={custom.voiceUk}
                placeholder={custom.voiceUs || "alloy"}
                groups={voiceGroups}
                onChange={(value) => setCustom((current) => ({ ...current, voiceUk: value }))}
                onCommit={(value) => persist({ [SPEECH_CUSTOM_VOICE_UK_KEY]: value.trim() })}
              />
            </div>
          </SettingsRow>
          <SettingsRow
            title={t("settings.speech.custom.voiceUs")}
            subtitle={t("settings.speech.custom.voiceUsHint")}
          >
            <div className={ROW_CONTROL_WIDTH}>
              <ComboField
                label={t("settings.speech.custom.voiceUs")}
                value={custom.voiceUs}
                placeholder="nova"
                groups={voiceGroups}
                onChange={(value) => setCustom((current) => ({ ...current, voiceUs: value }))}
                onCommit={(value) => persist({ [SPEECH_CUSTOM_VOICE_US_KEY]: value.trim() })}
              />
            </div>
          </SettingsRow>
          {voiceHints.options.length > 0 && (
            <p className="flex flex-wrap items-baseline gap-x-1.5 px-1 pb-1 text-[11px] leading-[17px] text-text-placeholder">
              {t("settings.speech.custom.voiceSource", {
                count: voiceHints.options.length,
                model: custom.model,
                date: new Date(voiceHints.updated_at ?? 0).toLocaleDateString(),
              })}
              <button
                type="button"
                className="cursor-pointer text-accent-text hover:underline"
                onClick={() => void forgetVoiceOptions()}
              >
                {t("settings.speech.custom.voiceForget")}
              </button>
            </p>
          )}
          <SettingsRow
            title={t("settings.speech.custom.cachePassages")}
            subtitle={t("settings.speech.custom.cachePassagesHint")}
          >
            <Toggle
              checked={custom.cachePassages}
              label={t("settings.speech.custom.cachePassages")}
              onChange={(checked) => {
                setCustom((current) => ({ ...current, cachePassages: checked }));
                persist({ [SPEECH_CUSTOM_CACHE_PASSAGES_KEY]: String(checked) });
              }}
            />
          </SettingsRow>
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
