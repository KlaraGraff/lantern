import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Loader2, XCircle } from "lucide-react";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { AI_PRESETS, presetFor } from "../settings/aiPresets";
import { connectionErrorLabel } from "../settings/ai-connection-errors";
import { type AiConnectionTestResult, type AiCredential, type AiProfile } from "../settings/AiServiceCard";
import { openSettings } from "../settings-open";

interface StepAiProps {
  bookTitle: string | null;
  onComplete: () => void;
  onSkip: () => void;
}

type TestState = "idle" | "testing" | "success" | "failure";

const DEEPSEEK = presetFor("deepseek")!;
const OTHER_PRESETS = AI_PRESETS.filter((preset) => preset.provider !== "deepseek");

/**
 * Step 3 of onboarding — connect DeepSeek (the one recommended service).
 * Profile + credential creation is lazy: nothing is written until the first
 * "Test" click, and a retry reuses the same profile/credential rather than
 * creating duplicates.
 */
export default function StepAi({ bookTitle, onComplete, onSkip }: StepAiProps) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testErrorKind, setTestErrorKind] = useState<string | undefined>(undefined);
  const [altOpen, setAltOpen] = useState(false);

  const runTest = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setTestState("testing");
    try {
      let pid = profileId;
      if (!pid) {
        const profile = await invoke<AiProfile>("ai_create_profile", {
          label: t(DEEPSEEK.nameKey),
          provider: DEEPSEEK.provider,
          authMode: "api_key",
          baseUrl: DEEPSEEK.baseUrl,
          model: DEEPSEEK.model,
          temperature: 0.3,
          reasoningEffort: null,
          reasoningEffortAllFeatures: false,
          keepAlive: DEEPSEEK.keepAlive,
          enabled: true,
        });
        pid = profile.id;
        setProfileId(pid);
      }
      let cid = credentialId;
      if (!cid) {
        const credential = await invoke<AiCredential>("ai_add_credential", {
          profileId: pid,
          label: t("settings.ai.defaultKeyLabel"),
          value: key,
        });
        cid = credential.id;
        setCredentialId(cid);
      } else {
        await invoke("ai_replace_credential", { id: cid, value: key });
      }
      const result = await invoke<AiConnectionTestResult>("ai_test_profile", {
        id: pid,
        provider: DEEPSEEK.provider,
        authMode: "api_key",
        baseUrl: DEEPSEEK.baseUrl,
        model: DEEPSEEK.model,
        temperature: 0.3,
        reasoningEffort: null,
        keepAlive: DEEPSEEK.keepAlive,
      });
      if (result.success) {
        setTestState("success");
        // No frontend event bus exists yet for "AI configuration changed" —
        // the library banner (Home.tsx) listens for this to clear itself the
        // moment onboarding connects a service, instead of waiting for its
        // next poll.
        window.dispatchEvent(new CustomEvent("lantern:ai-config-changed"));
      } else {
        setTestState("failure");
        setTestErrorKind(result.error_kind);
      }
    } catch {
      setTestState("failure");
      setTestErrorKind(undefined);
    }
  };

  // Best-effort cleanup: a profile created here but never proven to work is
  // clutter, not a saved configuration. A profile that did pass its test is
  // left alone even on skip — it is a real, working service.
  const cleanupUnprovenProfile = async () => {
    if (profileId && testState !== "success") {
      await invoke("ai_delete_profile", { id: profileId }).catch(() => {});
    }
  };

  const handleSkip = async () => {
    await cleanupUnprovenProfile();
    onSkip();
  };

  // Picking a different provider is really "leave this step" plus "go
  // configure it properly in Settings" — the alternates get no lookup/test
  // UI of their own here, just a link into the full editor.
  const chooseOtherProvider = async () => {
    await cleanupUnprovenProfile();
    onSkip();
    openSettings("services");
  };

  return (
    <div>
      <h2 className="text-[18px] font-semibold text-text-primary">{t("onboarding.step3.title")}</h2>
      <p className="mt-2 text-[13px] leading-5 text-text-secondary">
        {bookTitle ? t("onboarding.step3.why", { title: bookTitle }) : t("onboarding.step3.whyFallback")}
      </p>

      <div className="mt-5 rounded-lg border border-accent/30 bg-accent-bg p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[13px] font-semibold text-accent-text">{t(DEEPSEEK.nameKey)}</p>
          <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white">
            {t("onboarding.step3.recommended")}
          </span>
        </div>
        <p className="mt-1 text-[12px] leading-5 text-text-secondary">{t(DEEPSEEK.descriptionKey)}</p>

        {DEEPSEEK.keyPage && (
          <button
            type="button"
            onClick={() => { openUrl(DEEPSEEK.keyPage!).catch(() => {}); }}
            className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-accent-text hover:opacity-70"
          >
            <ExternalLink size={13} />
            {t("onboarding.step3.getKey")}
          </button>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            className="min-w-0 flex-1"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (testState === "failure") setTestState("idle");
            }}
            placeholder={t("onboarding.step3.keyPlaceholder")}
          />
          <Button
            variant="primary"
            size="md"
            disabled={!apiKey.trim() || testState === "testing"}
            onClick={() => void runTest()}
          >
            {testState === "testing" && <Loader2 size={14} className="animate-spin" />}
            {t("onboarding.step3.test")}
          </Button>
        </div>

        {testState === "testing" && (
          <p className="mt-2 text-[12px] text-text-muted">{t("onboarding.step3.testing")}</p>
        )}
        {testState === "success" && (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-success-text">
            <CheckCircle2 size={14} />
            {t("onboarding.step3.testSuccess")}
          </p>
        )}
        {testState === "failure" && (
          <div className="mt-2 rounded-md bg-danger-bg px-3 py-2 text-[12px] leading-5 text-danger-text">
            <p className="flex items-center gap-1.5 font-medium">
              <XCircle size={14} />
              {t("onboarding.step3.testFailedTitle")}
              {testErrorKind && ` · ${connectionErrorLabel(testErrorKind, t)}`}
            </p>
            <p className="mt-1 opacity-90">{t("onboarding.step3.testFailedHint")}</p>
          </div>
        )}
      </div>

      <div className="mt-4 border-t border-border-light pt-3">
        <button
          type="button"
          aria-expanded={altOpen}
          onClick={() => setAltOpen((open) => !open)}
          className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-accent-text"
        >
          {altOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t("onboarding.step3.altOthers")}
        </button>
        {altOpen && (
          <div className="mt-3 rounded-md border border-border bg-bg-muted p-3">
            <p className="text-[11px] leading-5 text-text-muted">{t("onboarding.step3.otherProvidersHint")}</p>
            <div className="mt-2 space-y-1.5">
              {OTHER_PRESETS.map((preset) => (
                <div
                  key={preset.provider}
                  className="flex items-center justify-between gap-2 rounded-md bg-bg-surface px-2.5 py-2"
                >
                  <span className="min-w-0 truncate text-[12px] font-medium text-text-primary">
                    {t(preset.nameKey)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void chooseOtherProvider()}
                    className="shrink-0 text-[11px] font-medium text-accent-text hover:opacity-70"
                  >
                    {t("onboarding.step3.configureInSettings")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <p className="mt-4 text-[11px] leading-5 text-text-muted">{t("onboarding.step3.privacy")}</p>

      <div className="mt-6 flex items-center justify-between border-t border-border-light pt-4">
        <button
          type="button"
          onClick={() => void handleSkip()}
          className="text-[13px] font-medium text-text-muted hover:text-text-secondary"
        >
          {t("onboarding.skip")}
        </button>
        <Button variant="primary" size="md" onClick={onComplete}>
          {t("onboarding.step3.complete")}
        </Button>
      </div>
    </div>
  );
}
