import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CopyPlus,
  ExternalLink,
  GripVertical,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatDuration } from "./aiDuration";
import { AI_PRESETS, COST_TIER_CLASSES, presetFor } from "./aiPresets";
import Button from "../ui/Button";
import ComboField from "../ui/ComboField";
import Input from "../ui/Input";
import Select from "../ui/Select";
import Slider from "../ui/Slider";
import SortableList from "../ui/SortableList";
import Toggle from "../ui/Toggle";

export interface AiProfile {
  id: string;
  label: string;
  provider: string;
  auth_mode: "api_key" | "oauth";
  base_url: string | null;
  model: string;
  temperature: number;
  /** `null` means "send no reasoning parameter", unlike the literal `none`. */
  reasoning_effort: string | null;
  reasoning_effort_all_features: boolean;
  keep_alive: string | null;
  enabled: boolean;
  priority: number;
  state: string;
  cooldown_until: number | null;
  last_error_kind: string | null;
  last_used_at: number | null;
  last_latency_ms: number | null;
}

export interface AiCredential {
  id: string;
  profile_id: string;
  label: string;
  masked_suffix: string;
  enabled: boolean;
  priority: number;
  state: string;
  cooldown_until: number | null;
  last_error_kind: string | null;
  last_used_at: number | null;
}

export interface AiConnectionTestResult {
  success: boolean;
  profile_id: string;
  provider: string;
  model: string;
  credential_id?: string;
  first_response_ms?: number;
  total_ms: number;
  tested_at: number;
  attempt_count: number;
  error_kind?: string;
  attempts: AiConnectionTestAttempt[];
}

interface AiConnectionTestAttempt {
  credential_id?: string;
  credential_label?: string;
  error_kind?: string;
  error_detail?: string;
  latency_ms: number;
  request_sent: boolean;
}

interface OAuthStatus {
  connected: boolean;
  account_id: string | null;
}

const BUILT_IN_EFFORTS = ["none", "low", "medium", "high", "x-high", "max"];

/** Levels an endpoint named when it rejected one, plus when it told us. */
export interface AiEffortHints {
  options: string[];
  /** Epoch milliseconds; `null` only when nothing was ever learned. */
  updated_at: number | null;
}

/** Date only — the hour a request happened to fail says nothing useful. */
function formatHintDate(updatedAt: number | null): string {
  if (!updatedAt) return "";
  return new Date(updatedAt).toLocaleDateString();
}

interface AiServiceCardProps {
  profile: AiProfile;
  credentials: AiCredential[];
  expanded: boolean;
  dirty: boolean;
  busy: boolean;
  testing: boolean;
  loadingModels: boolean;
  modelOptions: string[];
  /** Levels this endpoint named when it rejected one, if it ever did. */
  learnedEfforts: AiEffortHints;
  testResult?: AiConnectionTestResult;
  healthStale: boolean;
  oauthStatus: OAuthStatus;
  oauthLoading: boolean;
  onToggleExpanded: () => void;
  onChange: (patch: Partial<AiProfile>) => void;
  onToggleEnabled: (enabled: boolean) => Promise<void>;
  onTest: () => Promise<void>;
  onFetchModels: () => Promise<void>;
  onForgetEffortOptions: () => Promise<void>;
  onDuplicate: () => Promise<void>;
  onDelete: () => Promise<void>;
  onMove: (direction: -1 | 1) => Promise<void>;
  onAddCredential: (label: string, value: string) => Promise<void>;
  onReplaceCredential: (id: string, value: string) => Promise<void>;
  onToggleCredential: (id: string, enabled: boolean) => Promise<void>;
  onDeleteCredential: (id: string) => Promise<void>;
  onReorderCredentials: (ids: string[]) => Promise<void>;
  onOAuthLogin: () => Promise<void>;
  onOAuthLogout: () => Promise<void>;
}

function providerLabel(
  provider: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const preset = presetFor(provider);
  return t(preset?.nameKey ?? "settings.ai.customCompatible");
}

/**
 * Re-render once a second while `until` is still ahead, so a model that is
 * cooling counts down instead of sitting on a static word. Nothing is scheduled
 * when there is no deadline, and the timer stops itself once it runs out.
 */
function useCountdown(until: number | null): number | null {
  const [remaining, setRemaining] = useState(() =>
    until == null ? null : Math.max(0, until - Date.now()),
  );
  useEffect(() => {
    if (until == null) {
      setRemaining(null);
      return;
    }
    setRemaining(Math.max(0, until - Date.now()));
    const timer = window.setInterval(() => {
      const left = Math.max(0, until - Date.now());
      setRemaining(left);
      if (left === 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return remaining;
}

/**
 * The single word shown for a model. Every word maps to exactly one condition,
 * and in particular a spent quota (about an hour) never shares a word with a
 * network blip (thirty seconds): the user's move differs — wait, or reorder the
 * route — and one word for both hides which it is.
 *
 * `connected` is whatever counts as having credentials for this profile's auth
 * mode; a model with nothing to authenticate with is not "unavailable", it has
 * simply never been connected, and says so.
 */
function profileHealth(
  profile: AiProfile,
  connected: boolean,
  testing: boolean,
  result: AiConnectionTestResult | undefined,
  healthStale: boolean,
  remaining: number | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): { label: string; className: string } {
  const countdown =
    remaining != null && remaining > 0
      ? ` · ${t("settings.ai.health.remaining", { duration: formatDuration(remaining, t) })}`
      : "";
  if (testing) {
    return {
      label: t("settings.ai.health.verifying"),
      className: "bg-bg-input text-text-muted",
    };
  }
  if (!connected) {
    return {
      label: t("settings.ai.health.needsConnection"),
      className: "bg-accent-bg text-accent-text",
    };
  }
  if (healthStale) {
    return {
      label: t("settings.ai.health.retest"),
      className: "bg-accent-bg text-accent-text",
    };
  }
  if (result) {
    if (result.success) {
      return {
        label: t("settings.ai.health.available"),
        className: "bg-success/10 text-success-text",
      };
    }
    if (result.error_kind === "credential_invalid") {
      return {
        label: t("settings.ai.health.invalid"),
        className: "bg-danger-bg text-danger-text",
      };
    }
    if (result.error_kind === "not_configured") {
      return {
        label: t("settings.ai.health.needsConnection"),
        className: "bg-accent-bg text-accent-text",
      };
    }
    return {
      label: `${t("settings.ai.health.unavailable")} · ${connectionErrorLabel(result.error_kind, t)}`,
      className: "bg-danger-bg text-danger-text",
    };
  }
  if (profile.last_used_at == null && profile.last_latency_ms == null) {
    return {
      label: t("settings.ai.health.untested"),
      className: "bg-bg-input text-text-muted",
    };
  }
  if (profile.state === "active" && profile.last_error_kind == null) {
    return {
      label: t("settings.ai.health.available"),
      className: "bg-success/10 text-success-text",
    };
  }
  if (profile.state === "invalid" || profile.last_error_kind === "credential_invalid") {
    return {
      label: t("settings.ai.health.invalid"),
      className: "bg-danger-bg text-danger-text",
    };
  }
  if (profile.last_error_kind === "not_configured") {
    return {
      label: t("settings.ai.health.needsConnection"),
      className: "bg-accent-bg text-accent-text",
    };
  }
  if (profile.state === "quota") {
    return {
      label: `${t("settings.ai.health.quota")}${countdown}`,
      className: "bg-accent-bg text-accent-text",
    };
  }
  if (profile.state === "cooldown") {
    return {
      label: `${t("settings.ai.health.cooldown")}${countdown}`,
      className: "bg-accent-bg text-accent-text",
    };
  }
  return {
    label: t("settings.ai.health.unavailable"),
    className: "bg-danger-bg text-danger-text",
  };
}

function credentialStateLabel(
  credential: AiCredential,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (!credential.enabled) return t("settings.ai.keyDisabled");
  if (credential.state === "active") return t("settings.ai.keyActive");
  if (credential.state === "cooldown") return t("settings.ai.keyCooldown");
  if (credential.state === "quota") return t("settings.ai.keyQuota");
  if (credential.state === "invalid") return t("settings.ai.keyInvalid");
  return t("settings.ai.keyState", { state: credential.state });
}

const CONNECTION_ERROR_KEYS: Record<string, string> = {
  credential_invalid: "credentialInvalid",
  auth: "auth",
  permission: "permission",
  rate_limit: "rateLimit",
  quota: "quota",
  network: "network",
  provider_5xx: "provider5xx",
  protocol: "protocol",
  request: "request",
  not_configured: "notConfigured",
  cancelled: "cancelled",
};

function connectionErrorLabel(
  kind: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const key = kind ? CONNECTION_ERROR_KEYS[kind] : undefined;
  return key ? t(`settings.ai.testError.${key}`) : (kind ?? t("settings.ai.unknownError"));
}

export default function AiServiceCard({
  profile,
  credentials,
  expanded,
  dirty,
  busy,
  testing,
  loadingModels,
  modelOptions,
  learnedEfforts,
  testResult,
  healthStale,
  oauthStatus,
  oauthLoading,
  onToggleExpanded,
  onChange,
  onToggleEnabled,
  onTest,
  onFetchModels,
  onForgetEffortOptions,
  onDuplicate,
  onDelete,
  onAddCredential,
  onReplaceCredential,
  onToggleCredential,
  onDeleteCredential,
  onReorderCredentials,
  onOAuthLogin,
  onOAuthLogout,
}: AiServiceCardProps) {
  const { t } = useTranslation();
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [replaceValue, setReplaceValue] = useState("");
  const [credentialBusyId, setCredentialBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Connecting a preset needs none of the endpoint fields. They start open only
  // where nothing else can supply them: a custom endpoint, or a model ID the
  // preset never filled in.
  const [advancedOpen, setAdvancedOpen] = useState(
    () => profile.provider === "custom" || !profile.model,
  );
  const profileBusy = busy || credentialBusyId != null;
  // Kept as separate groups rather than merged into one list: which levels this
  // endpoint actually reported is the useful half of the information, and a
  // merged list loses it.
  const effortGroups = useMemo(() => {
    const learned = learnedEfforts.options;
    return [
      ...(learned.length > 0
        ? [{ label: t("settings.ai.reasoningEffortGroupReported"), options: learned }]
        : []),
      {
        label: t("settings.ai.reasoningEffortGroupBuiltIn"),
        options: BUILT_IN_EFFORTS.filter((level) => !learned.includes(level)),
      },
    ];
  }, [learnedEfforts.options, t]);

  useEffect(() => {
    if (expanded) return;
    setNewKey("");
    setReplaceId(null);
    setReplaceValue("");
    setConfirmDelete(false);
  }, [expanded]);

  const preset = presetFor(profile.provider);
  const providerName = providerLabel(profile.provider, t);
  const cost = preset?.cost ?? null;
  const keyPage = preset?.keyPage ?? null;
  const latency = healthStale ? null : (testResult?.total_ms ?? profile.last_latency_ms);
  const usesApiKeys = profile.auth_mode === "api_key" && profile.provider !== "ollama";
  // Ollama authenticates with nothing, OAuth with an account, everything else
  // with a key — so "has something to authenticate with" is per auth mode.
  const connected = !usesApiKeys
    ? profile.auth_mode !== "oauth" || oauthStatus.connected
    : credentials.length > 0;
  const remaining = useCountdown(profile.cooldown_until);
  const health = profileHealth(
    profile,
    connected,
    testing,
    testResult,
    healthStale,
    remaining,
    t,
  );

  const setProvider = (provider: string) => {
    const next = presetFor(provider);
    if (!next) return;
    // A custom endpoint leaves the URL blank on purpose, so the fields that
    // would otherwise stay hidden are exactly the ones now required.
    if (provider === "custom") setAdvancedOpen(true);
    onChange({
      provider,
      auth_mode: "api_key",
      base_url: next.baseUrl,
      model: next.model,
      keep_alive: next.keepAlive,
    });
  };

  const runCredential = async (id: string, action: () => Promise<void>) => {
    setCredentialBusyId(id);
    try {
      await action();
    } catch {
      // The parent owns the visible error banner. Keep secret input text in
      // place so a failed request can be corrected and retried.
    } finally {
      setCredentialBusyId(null);
    }
  };

  const addCredential = async () => {
    const value = newKey.trim();
    if (!value) return;
    await runCredential("new", async () => {
      await onAddCredential(newLabel.trim() || t("settings.ai.defaultKeyLabel"), value);
      setNewLabel("");
      setNewKey("");
    });
  };

  const replaceCredential = async () => {
    const value = replaceValue.trim();
    if (!replaceId || !value) return;
    await runCredential(replaceId, async () => {
      await onReplaceCredential(replaceId, value);
      setReplaceId(null);
      setReplaceValue("");
    });
  };

  const moveCredential = async (credentialIndex: number, direction: -1 | 1) => {
    const target = credentialIndex + direction;
    if (target < 0 || target >= credentials.length) return;
    const next = [...credentials];
    [next[credentialIndex], next[target]] = [next[target], next[credentialIndex]];
    await runCredential("order", () => onReorderCredentials(next.map((item) => item.id)));
  };

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-bg-surface transition-[border-color,opacity,box-shadow]">
      <div className="flex min-h-[68px] items-center gap-2 px-2.5 py-2">
        <span
          title={t("settings.ai.reorderHint")}
          aria-label={t("settings.ai.reorderService", { name: profile.label })}
          className={`flex size-8 shrink-0 items-center justify-center text-text-muted ${profileBusy || expanded ? "opacity-35" : ""}`}
        >
          <GripVertical size={15} />
        </span>

        <button
          type="button"
          disabled={profileBusy}
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left"
        >
          {expanded ? (
            <ChevronDown size={15} className="shrink-0 text-text-muted" />
          ) : (
            <ChevronRight size={15} className="shrink-0 text-text-muted" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-text-primary">{profile.label}</span>
              {cost && (
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${COST_TIER_CLASSES[cost]}`}
                >
                  {t(`settings.ai.cost.${cost}`)}
                </span>
              )}
              {dirty && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-accent"
                  title={t("settings.ai.unsaved")}
                  aria-label={t("settings.ai.unsaved")}
                />
              )}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-text-muted">
              {providerName} · {profile.model || t("settings.ai.modelNotSet")}
              <span className="sm:hidden">
                {` · ${health.label}${latency != null ? ` · ${latency} ms` : ""}`}
              </span>
            </span>
          </span>
        </button>

        <span className={`hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium sm:inline-flex ${health.className}`}>
          {health.label}
          {latency != null && ` · ${latency} ms`}
        </span>

        <div onClick={(event) => event.stopPropagation()} className="shrink-0">
          <Toggle
            checked={profile.enabled}
            disabled={profileBusy}
            label={t("settings.ai.toggleService", { name: profile.label })}
            onChange={(enabled) => void onToggleEnabled(enabled)}
          />
        </div>

        <button
          type="button"
          disabled={testing || profileBusy}
          onClick={() => void onTest()}
          title={testing ? t("settings.ai.testingConnection") : t("settings.ai.testConnection")}
          aria-label={testing ? t("settings.ai.testingConnection") : t("settings.ai.testConnection")}
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text disabled:opacity-50"
        >
          {testing ? <Loader2 size={15} className="animate-spin" /> : <Activity size={15} />}
        </button>
      </div>

      {expanded && (
        <div className={`border-t border-border-light px-4 pb-4 ${busy ? "opacity-65" : ""}`}>
          <div className="grid gap-3 py-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.serviceName")}</span>
              <Input
                disabled={profileBusy}
                value={profile.label}
                maxLength={100}
                onChange={(event) => onChange({ label: event.target.value })}
                placeholder={t("settings.ai.serviceNamePlaceholder")}
              />
            </label>
            <div>
              <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.provider")}</span>
              <Select
                value={profile.provider}
                onChange={(provider) => {
                  if (!profileBusy) setProvider(provider);
                }}
                options={AI_PRESETS.map((option) => ({
                  value: option.provider,
                  label: t(option.nameKey),
                }))}
              />
            </div>
          </div>

          {profile.provider === "openai" && (
            <div className="border-t border-border-light py-3">
              <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.authMethod")}</span>
              <div className="flex overflow-hidden rounded-lg border border-border">
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => onChange({ auth_mode: "api_key" })}
                  className={`flex h-9 flex-1 items-center justify-center gap-1.5 text-[12px] ${
                    profile.auth_mode === "api_key"
                      ? "bg-accent text-white"
                      : "bg-bg-page text-text-secondary hover:bg-bg-input"
                  }`}
                >
                  <KeyRound size={14} />
                  {t("settings.ai.apiKey")}
                </button>
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => onChange({
                    auth_mode: "oauth",
                    base_url: null,
                    model: profile.auth_mode === "oauth" ? profile.model : "gpt-5.3-codex",
                  })}
                  className={`flex h-9 flex-1 items-center justify-center gap-1.5 text-[12px] ${
                    profile.auth_mode === "oauth"
                      ? "bg-accent text-white"
                      : "bg-bg-page text-text-secondary hover:bg-bg-input"
                  }`}
                >
                  <Shield size={14} />
                  {t("settings.ai.oauthLogin")}
                </button>
              </div>
            </div>
          )}

          {profile.auth_mode === "oauth" && profile.provider === "openai" && (
            <div className="border-t border-border-light py-3">
              <p className="text-[11px] leading-5 text-text-muted">{t("settings.ai.oauthUsesAccount")}</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[12px] text-text-primary">
                  {oauthStatus.connected
                    ? t("settings.ai.connected", { account: oauthStatus.account_id || "OpenAI" })
                    : t("settings.ai.oauthNotConnected")}
                </span>
                {oauthStatus.connected ? (
                  <Button variant="ghost" size="sm" onClick={() => void onOAuthLogout()} disabled={oauthLoading}>
                    {oauthLoading ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
                    {t("settings.ai.logout")}
                  </Button>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => void onOAuthLogin()} disabled={oauthLoading}>
                    {oauthLoading ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
                    {oauthLoading ? t("settings.ai.waitingAuth") : t("settings.ai.loginWithOpenAI")}
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="border-t border-border-light">
            <button
              type="button"
              onClick={() => setAdvancedOpen((open) => !open)}
              aria-expanded={advancedOpen}
              className="flex w-full items-center gap-1.5 py-3 text-left"
            >
              {advancedOpen ? (
                <ChevronDown size={14} className="shrink-0 text-text-muted" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-text-muted" />
              )}
              <span className="text-[12px] font-medium text-text-primary">{t("settings.ai.advanced")}</span>
              <span className="min-w-0 truncate text-[10px] text-text-muted">{t("settings.ai.advancedHint")}</span>
            </button>
          </div>

          {advancedOpen && (
            <>
              {!(profile.auth_mode === "oauth" && profile.provider === "openai") && (
                <label className="block border-t border-border-light py-3">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.baseUrl")}</span>
                  <Input
                    disabled={profileBusy}
                    value={profile.base_url ?? ""}
                    onChange={(event) => onChange({ base_url: event.target.value })}
                    placeholder="https://api.example.com"
                  />
                  <span className="mt-1 block text-[10px] leading-4 text-text-muted">{t("settings.ai.baseUrlHint")}</span>
                </label>
              )}

              <div className="border-t border-border-light py-3">
                <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.model")}</span>
                <ComboField
                  label={t("settings.ai.model")}
                  value={profile.model}
                  disabled={profileBusy}
                  maxLength={200}
                  placeholder={t("settings.ai.modelPlaceholder")}
                  groups={
                    modelOptions.length > 0
                      ? [{ label: t("settings.ai.modelGroupFetched"), options: modelOptions }]
                      : []
                  }
                  onChange={(model) => onChange({ model })}
                  onRefresh={() => void onFetchModels()}
                  refreshing={loadingModels}
                  refreshDisabled={profile.auth_mode === "oauth"}
                  refreshLabel={
                    profile.auth_mode === "oauth"
                      ? t("settings.ai.modelsUnavailableOAuth")
                      : t("settings.ai.fetchModels")
                  }
                />
                <span className="mt-1 block text-[10px] leading-4 text-text-muted">
                  {modelOptions.length > 0
                    ? t("settings.ai.modelsFound", { count: modelOptions.length })
                    : t("settings.ai.modelHint")}
                </span>
              </div>

              <div className="border-t border-border-light py-3">
                <span className="mb-1.5 block text-[12px] font-medium text-text-primary">
                  {t("settings.ai.reasoningEffort")}
                </span>
                <ComboField
                  label={t("settings.ai.reasoningEffort")}
                  value={profile.reasoning_effort ?? ""}
                  disabled={profileBusy}
                  maxLength={32}
                  placeholder={t("settings.ai.reasoningEffortDefault")}
                  emptyLabel={t("settings.ai.reasoningEffortDefaultOption")}
                  groups={effortGroups}
                  onChange={(value) => onChange({ reasoning_effort: value.trim() || null })}
                />
                <span className="mt-1 block text-[10px] leading-4 text-text-muted">
                  {t("settings.ai.reasoningEffortHint")}
                </span>
                {learnedEfforts.options.length > 0 && (
                  <span className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-[10px] leading-4 text-text-muted">
                    {t("settings.ai.reasoningEffortSource", {
                      count: learnedEfforts.options.length,
                      model: profile.model,
                      date: formatHintDate(learnedEfforts.updated_at),
                    })}
                    <button
                      type="button"
                      className="cursor-pointer text-accent-text hover:underline"
                      onClick={() => void onForgetEffortOptions()}
                    >
                      {t("settings.ai.reasoningEffortForget")}
                    </button>
                  </span>
                )}
                <label className="mt-3 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium text-text-primary">
                      {t("settings.ai.reasoningEffortAllFeatures")}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-text-muted">
                      {t("settings.ai.reasoningEffortAllFeaturesHint")}
                    </span>
                  </span>
                  <Toggle
                    label={t("settings.ai.reasoningEffortAllFeatures")}
                    checked={profile.reasoning_effort_all_features}
                    onChange={(checked) => onChange({ reasoning_effort_all_features: checked })}
                  />
                </label>
              </div>

              <div className="border-t border-border-light py-3">
                <Slider
                  label={t("settings.ai.temperature")}
                  min={0}
                  max={200}
                  value={Math.round(profile.temperature * 100)}
                  onChange={(value) => onChange({ temperature: value / 100 })}
                  displayValue={profile.temperature.toFixed(1)}
                  hint={t("settings.ai.temperatureHint")}
                />
              </div>

              {profile.provider === "ollama" && (
                <label className="block border-t border-border-light py-3">
                  <span className="mb-1.5 block text-[12px] font-medium text-text-primary">{t("settings.ai.keepAlive")}</span>
                  <Input
                    disabled={profileBusy}
                    value={profile.keep_alive ?? ""}
                    onChange={(event) => onChange({ keep_alive: event.target.value })}
                    placeholder="30m"
                  />
                  <span className="mt-1 block text-[10px] leading-4 text-text-muted">{t("settings.ai.keepAliveHint")}</span>
                </label>
              )}
            </>
          )}

          {usesApiKeys && (
            <div className="border-t border-border-light pt-3">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-[12px] font-medium text-text-primary">{t("settings.ai.apiKeys")}</h4>
                  <p className="mt-0.5 text-[10px] leading-4 text-text-muted">{t("settings.ai.apiKeysHint")}</p>
                </div>
                <span className="shrink-0 text-[10px] text-text-muted">
                  {t("settings.ai.enabledKeyCount", { count: credentials.filter((item) => item.enabled).length })}
                </span>
              </div>

              {keyPage && credentials.length === 0 && (
                <div className="mb-3 rounded-md bg-bg-page px-3 py-2.5">
                  <p className="text-[11px] font-medium text-text-primary">
                    {t("settings.ai.connectTitle", { name: providerName })}
                  </p>
                  <ol className="mt-1.5 list-decimal space-y-0.5 pl-4 text-[10px] leading-4 text-text-muted">
                    <li>{t("settings.ai.connectStepRegister", { name: providerName })}</li>
                    <li>{t("settings.ai.connectStepCreate")}</li>
                    <li>{t("settings.ai.connectStepCopy")}</li>
                    <li>{t("settings.ai.connectStepPaste")}</li>
                  </ol>
                  <div className="mt-2 flex justify-start">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        // Fixed official HTTPS pages only — never a URL that
                        // arrived from a provider response or a remote catalog.
                        openUrl(keyPage).catch(() => {});
                      }}
                    >
                      <ExternalLink size={13} />
                      {t(preset?.keyButtonKey ?? "settings.ai.connectGetKey")}
                    </Button>
                  </div>
                </div>
              )}

              {credentials.length > 0 && (
                <SortableList
                  items={credentials}
                  getId={(credential) => credential.id}
                  disabled={credentialBusyId != null}
                  onReorder={(items) => runCredential("order", () => onReorderCredentials(items.map((item) => item.id)))}
                  className="divide-y divide-border-light border-y border-border-light"
                  renderItem={(credential, credentialIndex) => (
                    <div className="py-2">
                      <div className="flex items-center gap-2">
                        <Toggle
                          checked={credential.enabled}
                          disabled={credentialBusyId != null}
                          label={t("settings.ai.toggleKey", { name: credential.label })}
                          onChange={(enabled) => void runCredential(credential.id, () => onToggleCredential(credential.id, enabled))}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] font-medium text-text-primary">
                            {credential.label} <span className="font-mono font-normal text-text-muted">••••{credential.masked_suffix}</span>
                          </p>
                          <p className="mt-0.5 text-[10px] text-text-muted">{credentialStateLabel(credential, t)}</p>
                        </div>
                        <button
                          type="button"
                          disabled={credentialIndex === 0 || credentialBusyId != null}
                          onClick={() => void moveCredential(credentialIndex, -1)}
                          title={t("settings.ai.moveKeyUp")}
                          aria-label={t("settings.ai.moveKeyUpNamed", { name: credential.label })}
                          className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input disabled:opacity-25"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={credentialIndex === credentials.length - 1 || credentialBusyId != null}
                          onClick={() => void moveCredential(credentialIndex, 1)}
                          title={t("settings.ai.moveKeyDown")}
                          aria-label={t("settings.ai.moveKeyDownNamed", { name: credential.label })}
                          className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input disabled:opacity-25"
                        >
                          <ArrowDown size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={credentialBusyId != null}
                          onClick={() => {
                            setReplaceId(credential.id);
                            setReplaceValue("");
                          }}
                          title={t("settings.ai.replaceKey")}
                          aria-label={t("settings.ai.replaceKeyNamed", { name: credential.label })}
                          className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text disabled:opacity-40"
                        >
                          <RefreshCw size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={credentialBusyId != null}
                          onClick={() => void runCredential(credential.id, () => onDeleteCredential(credential.id))}
                          title={t("settings.ai.deleteKey")}
                          aria-label={t("settings.ai.deleteKeyNamed", { name: credential.label })}
                          className="flex size-7 items-center justify-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text disabled:opacity-40"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                      {replaceId === credential.id && (
                        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:pl-[52px]">
                          <Input
                            className="min-w-0 flex-1"
                            type="password"
                            autoComplete="new-password"
                            value={replaceValue}
                            onChange={(event) => setReplaceValue(event.target.value)}
                            placeholder={t("settings.ai.keyValuePlaceholder")}
                          />
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={!replaceValue.trim() || credentialBusyId === credential.id}
                            onClick={() => void replaceCredential()}
                          >
                            {credentialBusyId === credential.id && <Loader2 size={13} className="animate-spin" />}
                            {t("settings.ai.replaceKey")}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setReplaceId(null);
                              setReplaceValue("");
                            }}
                          >
                            {t("common.cancel")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                />
              )}

              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
                  <Input
                    value={newLabel}
                    onChange={(event) => setNewLabel(event.target.value)}
                    placeholder={t("settings.ai.keyLabel")}
                  />
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={newKey}
                    onChange={(event) => setNewKey(event.target.value)}
                    placeholder={t("settings.ai.keyValuePlaceholder")}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!newKey.trim() || credentialBusyId === "new"}
                    onClick={() => void addCredential()}
                  >
                    {credentialBusyId === "new" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                    {t("settings.ai.addKey")}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {testResult && (
            <div className={`mt-3 rounded-md px-3 py-2 text-[11px] ${
              testResult.success ? "bg-success/10 text-success-text" : "bg-danger-bg text-danger-text"
            }`}>
              <p>{testResult.success
                ? testResult.first_response_ms != null
                  ? t("settings.ai.testSuccessDetailed", {
                      firstResponse: testResult.first_response_ms,
                      total: testResult.total_ms,
                      attempts: testResult.attempt_count,
                    })
                  : t("settings.ai.testSuccess", {
                      latency: testResult.total_ms,
                      attempts: testResult.attempt_count,
                    })
                : t("settings.ai.testFailed", {
                    reason: connectionErrorLabel(testResult.error_kind, t),
                    latency: testResult.total_ms,
                  })}</p>
              {testResult.attempts.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-current/15 pt-2">
                  {testResult.attempts.map((attempt, index) => (
                    <p key={attempt.credential_id ?? index} className="break-words leading-4">
                      <span className="font-medium">
                        {attempt.credential_label ?? t("settings.ai.testAttemptService")}
                      </span>
                      {` · ${attempt.error_kind
                        ? connectionErrorLabel(attempt.error_kind, t)
                        : t("settings.ai.testAttemptSuccess")} · ${attempt.latency_ms} ms`}
                      {!attempt.request_sent && (
                        <span className="block font-medium">{t("settings.ai.testRequestNotSent")}</span>
                      )}
                      {attempt.error_detail && (
                        <span className="block opacity-80">{attempt.error_detail}</span>
                      )}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex min-h-9 items-center justify-end gap-2 border-t border-border-light pt-3">
            {confirmDelete ? (
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[11px] text-danger-text">{t("settings.ai.deleteConfirm")}</span>
                <Button variant="ghost" size="sm" disabled={profileBusy} onClick={() => setConfirmDelete(false)}>
                  {t("common.cancel")}
                </Button>
                <Button variant="secondary" size="sm" disabled={profileBusy} onClick={() => void onDelete()}>
                  {t("common.delete")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => void onDuplicate()}
                  title={t("settings.ai.duplicateService")}
                  aria-label={t("settings.ai.duplicateServiceNamed", { name: profile.label })}
                  className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-bg-input hover:text-accent-text"
                >
                  <CopyPlus size={14} />
                </button>
                <button
                  type="button"
                  disabled={profileBusy}
                  onClick={() => setConfirmDelete(true)}
                  title={t("settings.ai.deleteService")}
                  aria-label={t("settings.ai.deleteServiceNamed", { name: profile.label })}
                  className="flex size-8 items-center justify-center rounded-md text-text-muted hover:bg-danger-bg hover:text-danger-text"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
