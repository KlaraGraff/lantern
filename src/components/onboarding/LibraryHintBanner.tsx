import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle } from "lucide-react";
import { openSettings } from "../settings-open";
import { isAiConfigured, isCefrLevelUnset, type AiCredentialLike, type AiProfileLike } from "./onboarding-state";

type Reason = "aiNotConfigured" | "levelNotSet" | null;

/**
 * A quiet reminder atop the library for whichever setup step onboarding was
 * skipped on. It carries no dismiss button on purpose — the way to make it
 * go away is to fix the thing, not to hide the reminder — and it does go
 * away on its own, in this window or any other, the moment that happens.
 *
 * AI-not-configured takes priority over level-not-set: lookups being fully
 * broken matters more than explanations being pitched slightly wrong.
 */
export default function LibraryHintBanner() {
  const { t } = useTranslation();
  // Nothing shown until the first check resolves, so a slow AI list query
  // never flashes a false warning on first paint.
  const [reason, setReason] = useState<Reason>(null);
  const [checked, setChecked] = useState(false);

  const check = useCallback(async () => {
    try {
      const [settings, profiles] = await Promise.all([
        invoke<Record<string, string>>("get_all_settings"),
        invoke<AiProfileLike[]>("ai_list_profiles"),
      ]);
      const credentialLists = await Promise.all(
        profiles.map((profile) => invoke<AiCredentialLike[]>("ai_list_credentials", { profileId: profile.id })),
      );
      if (!isAiConfigured(profiles, credentialLists.flat())) {
        setReason("aiNotConfigured");
      } else if (isCefrLevelUnset(settings)) {
        setReason("levelNotSet");
      } else {
        setReason(null);
      }
    } catch {
      // Unable to check — say nothing rather than nag on a guess.
      setReason(null);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    window.addEventListener("lantern:ai-config-changed", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("lantern:ai-config-changed", onFocus);
    };
  }, [check]);

  if (!checked || !reason) return null;

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-bg-muted px-page py-2">
      <div className="flex min-w-0 items-center gap-2 text-[12px] text-text-secondary">
        <AlertCircle size={14} className="shrink-0 text-text-muted" />
        {/* Wraps rather than truncates. Both hints spend their second half
            saying what stops working — "…查词和解释暂时用不了" — and a phone
            has room for about the first half, so a single truncated line cut
            the sentence exactly where it started to matter. Still capped at
            two lines: this is a hint above the shelf, not a paragraph. */}
        <span className="line-clamp-2">{t(`home.onboardingHint.${reason}`)}</span>
      </div>
      <button
        type="button"
        onClick={() => openSettings(reason === "aiNotConfigured" ? "services" : "general")}
        className="tap-44 shrink-0 text-[12px] font-medium text-accent-text hover:opacity-70"
      >
        {t("home.onboardingHint.openSettings")}
      </button>
    </div>
  );
}
