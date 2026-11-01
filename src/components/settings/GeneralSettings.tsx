import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import Button from "../ui/Button";
import { ROW_CONTROL_WIDTH, type SettingsProps } from "./types";
import { LANGUAGE_OPTIONS } from "./languageOptions";
import { platform } from "../../services/platform";
import {
  THEME_PREFERENCES,
  THEME_PREFERENCE_LABEL_KEYS,
  applyThemePreference,
  themePreferenceOf,
} from "./theme-preference";
import { ONBOARDING_STATE_KEY } from "../onboarding/onboarding-state";
import i18n from "../../i18n";
import { createSettingsSaveFeedback, runSettingsSave } from "./settings-save-feedback";
import ResetDataDialog from "./ResetDataDialog";
import { runReset, type ResetDataSummary, type ResetStep } from "./reset-data";

/**
 * 通用 — the app-shell layer only. Six flat rows, no sub-groups: interface
 * language leads (the escape hatch from a wrong language pick has to be the
 * very first thing on the very first section), then theme, display name,
 * auto-update, onboarding replay, and log access — then, set apart at the
 * very bottom, the 危险操作 zone with 重置全部数据.
 *
 * Everything that used to live here about *how Lantern explains English* —
 * CEFR level, explanation language, translation language, exam estimates,
 * lookup history retention — moved to `LearningSettings.tsx`. Reading
 * behavior (auto-save, skip front matter) moved to `ReadingSettings.tsx`.
 */
export default function GeneralSettings({ settings, loading, save, showSavedToast }: SettingsProps) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState("en");
  const [displayName, setDisplayName] = useState("Reader");
  const displayNameDraftRef = useRef({ value: "Reader", dirty: false });
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (settings.language) setLanguage(settings.language);
    if (settings.user_name && !displayNameDraftRef.current.dirty) {
      displayNameDraftRef.current.value = settings.user_name;
      setDisplayName(settings.user_name);
    }
    // Unset means on, matching what the toast does with a missing value.
    setAutoCheckUpdates(settings.auto_check_updates !== "false");
  }, [settings, loading]);

  const saveFeedbackRef = useRef(createSettingsSaveFeedback());
  const savesRef = useRef<Promise<void>>(Promise.resolve());
  const persist = (key: string, value: string, afterSave?: () => void | Promise<unknown>, message?: string) => {
    return runSettingsSave(saveFeedbackRef.current, [key], () => {
      const result = savesRef.current.catch(() => {}).then(async () => {
        await save(key, value);
        await afterSave?.();
      });
      savesRef.current = result;
      return result;
    }, () => showSavedToast(t("readerSettings.scope.actionFailed")), () => showSavedToast(message));
  };

  const theme = themePreferenceOf(settings.theme);

  const [resetStep, setResetStep] = useState<ResetStep>("closed");
  const [resetSummary, setResetSummary] = useState<ResetDataSummary>({ bookCount: 0, syncEnabled: false });
  const [resetError, setResetError] = useState<string | null>(null);
  const closeReset = useCallback(() => {
    setResetStep("closed");
    setResetError(null);
  }, []);
  const openReset = () => {
    // The list in the first step names what goes, so it waits for the count
    // rather than showing a placeholder number.
    invoke<ResetDataSummary>("reset_data_summary")
      .then((summary) => {
        setResetSummary(summary);
        setResetError(null);
        setResetStep("explain");
      })
      .catch(() => showSavedToast(t("settings.reset.failed")));
  };
  const confirmReset = async (typed: string) => {
    setResetError(null);
    setResetStep("resetting");
    const outcome = await runReset({
      request: () => invoke("reset_all_data", { confirmation: typed }),
      clearWebStorage: () => {
        localStorage.clear();
        sessionStorage.clear();
      },
      relaunch,
    });
    if (outcome === "request-failed") {
      setResetError(t("settings.reset.failed"));
      setResetStep("confirm");
    } else if (outcome === "relaunch-failed") {
      setResetError(t("settings.reset.relaunchFailed"));
    }
  };

  return (
    <div>
      {/* Interface Language — row 1. Errantly setting the app to a language
          you cannot read has to be recoverable by position alone: this is
          the first section, and this is its first row. */}
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.language")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.languageHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={language}
          onChange={(lang) => {
            setLanguage(lang);
            void persist("language", lang, async () => {
              localStorage.setItem("lantern-language", lang);
              await i18n.changeLanguage(lang);
            });
          }}
          options={LANGUAGE_OPTIONS}
        />
      </div>

      {/* Theme — row 2, folded in from the former 外观 section (which held
          nothing else). On a touch device `Select` already raises itself as
          a bottom sheet, so no bespoke sheet mechanism is needed here. */}
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.appearance.theme")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.themeHint")}</p>
        </div>
        <Select
          className={ROW_CONTROL_WIDTH}
          value={theme}
          onChange={(value) => {
            void persist("theme", value, () => {
              localStorage.setItem("lantern-theme", value);
              applyThemePreference(value);
            });
          }}
          options={THEME_PREFERENCES.map((option) => ({
            value: option,
            label: t(THEME_PREFERENCE_LABEL_KEYS[option]),
          }))}
        />
      </div>

      {/* Display Name */}
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.general.displayName")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.displayNameHint")}</p>
        </div>
        <input
          value={displayName}
          onChange={(e) => {
            displayNameDraftRef.current = { value: e.target.value, dirty: true };
            setDisplayName(e.target.value);
          }}
          onBlur={() => {
            const draft = displayNameDraftRef.current.value;
            void persist("user_name", draft).then((saved) => {
              if (saved && displayNameDraftRef.current.value === draft) displayNameDraftRef.current.dirty = false;
            });
          }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="Reader"
          className={`field-soft ${ROW_CONTROL_WIDTH} h-8 bg-white dark:bg-bg-surface rounded-[10px] px-3 text-[13px] font-medium text-text-secondary text-center outline-none`}
        />
      </div>

      {/* The only update control anywhere in Settings. Everything else about
          an update happens in the toast; this row just decides whether the
          launch check runs at all. Gone where there is no updater to run. */}
      {platform.hasUpdater && (
        <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.general.autoCheckUpdates")}</p>
            <p className="text-[12px] text-text-muted mt-0.5">{t("settings.general.autoCheckUpdatesHint")}</p>
          </div>
          <Toggle
            label={t("settings.general.autoCheckUpdates")}
            checked={autoCheckUpdates}
            onChange={(v) => {
              setAutoCheckUpdates(v);
              void persist("auto_check_updates", String(v));
            }}
          />
        </div>
      )}

      {/* Lets someone who skipped or rushed through the first-launch card see
          it again, without a support request to reset a hidden flag. */}
      <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.onboarding.replay")}</p>
          <p className="text-[12px] text-text-muted mt-0.5">{t("settings.onboarding.replayHint")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className={`${ROW_CONTROL_WIDTH} justify-center`}
          onClick={() => {
            void persist(ONBOARDING_STATE_KEY, "", undefined, t("settings.onboarding.replayed"));
          }}
        >
          {t("settings.onboarding.replayButton")}
        </Button>
      </div>

      {/* Diagnostics — log triage entry point. Mirrors the Help menu's
          "Reveal Logs" item so the discoverability path doesn't depend
          on the user knowing about the menu. Nothing to reveal the logs
          *in* on a platform with no file manager, so the whole row goes. */}
      {platform.hasFileReveal && (
        <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.diagnostics.revealLogs")}</p>
            <p className="text-[12px] text-text-muted mt-0.5">{t("settings.diagnostics.revealLogsHint")}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className={`${ROW_CONTROL_WIDTH} justify-center`}
            onClick={() => {
              invoke("reveal_logs").catch(() => {});
            }}
          >
            {t("settings.diagnostics.revealLogsButton")}
          </Button>
        </div>
      )}

      {/* 危险操作 — last, under its own heading, so it is never next to
          something clicked every day. Gone where the app cannot relaunch
          itself: the wipe only runs at the start of the next launch. */}
      {platform.hasAppRelaunch && (
        <section aria-labelledby="settings-danger-zone" className="mt-8">
          <h3 id="settings-danger-zone" className="border-b border-black/10 dark:border-white/10 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.6px] text-danger-text">
            {t("settings.danger.title")}
          </h3>
          <div className="flex items-center justify-between gap-4 min-h-[73px] py-3">
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-text-primary tracking-[-0.15px]">{t("settings.reset.title")}</p>
              <p className="text-[12px] text-text-muted mt-0.5">{t("settings.reset.hint")}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              className={`${ROW_CONTROL_WIDTH} justify-center border-danger-border text-danger-text hover:bg-danger-bg`}
              onClick={openReset}
            >
              {t("settings.reset.button")}
            </Button>
          </div>
        </section>
      )}

      {resetStep !== "closed" && (
        <ResetDataDialog
          step={resetStep}
          summary={resetSummary}
          error={resetError}
          onCancel={closeReset}
          onContinue={() => setResetStep("confirm")}
          onConfirm={(typed) => void confirmReset(typed)}
        />
      )}
    </div>
  );
}
