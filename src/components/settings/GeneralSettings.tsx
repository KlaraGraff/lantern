import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * 通用 — the app-shell layer only. Six flat rows, no sub-groups: interface
 * language leads (the escape hatch from a wrong language pick has to be the
 * very first thing on the very first section), then theme, display name,
 * auto-update, onboarding replay, and log access.
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
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);

  useEffect(() => {
    if (loading) return;
    if (settings.language) setLanguage(settings.language);
    if (settings.user_name) setDisplayName(settings.user_name);
    // Unset means on, matching what the toast does with a missing value.
    setAutoCheckUpdates(settings.auto_check_updates !== "false");
  }, [settings, loading]);

  const theme = themePreferenceOf(settings.theme);

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
            save("language", lang);
            localStorage.setItem("lantern-language", lang);
            i18n.changeLanguage(lang);
            showSavedToast();
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
            save("theme", value);
            localStorage.setItem("lantern-theme", value);
            applyThemePreference(value);
            showSavedToast();
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
          onChange={(e) => setDisplayName(e.target.value)}
          onBlur={() => { save("user_name", displayName); showSavedToast(); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="Reader"
          className={`${ROW_CONTROL_WIDTH} h-8 bg-white dark:bg-bg-surface rounded-[10px] px-3 text-[13px] font-medium text-text-secondary text-center outline-none border border-border focus:border-accent transition-colors`}
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
              save("auto_check_updates", String(v));
              showSavedToast();
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
            void save(ONBOARDING_STATE_KEY, "").then(() => showSavedToast(t("settings.onboarding.replayed")));
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
    </div>
  );
}
