import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import Button from "../ui/Button";
import Select from "../ui/Select";
import Toggle from "../ui/Toggle";
import SortableList from "../ui/SortableList";
import AiServiceCard, {
  type AiConnectionTestResult,
  type AiCredential,
  type AiEffortHints,
  type AiProfile,
} from "./AiServiceCard";
import AiRequestCountsSection from "./AiRequestCountsSection";
import { COST_TIER_CLASSES, availablePresets, presetFor } from "./aiPresets";
import { abandonedDraftIds, isProfileConfigComplete } from "./ai-draft-profiles";
import MissingKeyNotice from "./MissingKeyNotice";
import { missingKeyState, wantsMissingKeyNotice, type MissingKeyPeer } from "./missing-key";
import type { SettingsProps } from "./types";
import { platform } from "../../services/platform";
import { useSettings } from "../../hooks/useSettings";
import AutoAnalysisIntro from "../onboarding/AutoAnalysisIntro";
import { AUTO_ANALYSIS_INTRO_KEY, shouldIntroduceAutoAnalysis } from "../onboarding/onboarding-state";

interface AiSettingsProps extends SettingsProps {
  onSaveRef?: (save: (() => void) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface OAuthStatus {
  connected: boolean;
  account_id: string | null;
}

/** As much of `sync_status` as the missing-key notice reads. */
interface SyncStatusPeers {
  peers: MissingKeyPeer[];
}

/**
 * The catalog this platform may offer. Read once — `platform` is a
 * compile-time constant, so the list cannot change while the pane is open.
 */
const CATALOG = availablePresets(platform.hasLocalModelRuntime);

/** Shared so an unopened card does not remount its field on every render. */
const NO_EFFORT_HINTS: AiEffortHints = { options: [], updated_at: null };

const PROFILE_CONFIG_KEYS = [
  "label",
  "provider",
  "auth_mode",
  "base_url",
  "model",
  "temperature",
  "reasoning_effort",
  "reasoning_effort_all_features",
  "keep_alive",
] as const;

function sameProfileConfig(left: AiProfile | undefined, right: AiProfile | undefined): boolean {
  if (!left || !right) return false;
  return PROFILE_CONFIG_KEYS.every((key) => left[key] === right[key]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileLabel(value: string): string {
  return Array.from(value).slice(0, 100).join("");
}

function updateOne<T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] {
  return items.map((item) => item.id === id ? { ...item, ...patch } : item);
}

export default function AiSettings({ showSavedToast, onSaveRef, onDirtyChange }: AiSettingsProps) {
  const { t } = useTranslation();
  const { settings, save: saveSetting } = useSettings();
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<AiProfile[]>([]);
  const [credentials, setCredentials] = useState<Record<string, AiCredential[]>>({});
  const [modelOptions, setModelOptions] = useState<Record<string, string[]>>({});
  const [effortHints, setEffortHints] = useState<Record<string, AiEffortHints>>({});
  const [testResults, setTestResults] = useState<Record<string, AiConnectionTestResult>>({});
  const [staleHealthIds, setStaleHealthIds] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [effortRevision, setEffortRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [modelsLoadingId, setModelsLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus>({ connected: false, account_id: null });
  const [oauthLoading, setOauthLoading] = useState(false);
  const [peers, setPeers] = useState<MissingKeyPeer[]>([]);
  const [firstSeenMissing, setFirstSeenMissing] = useState<Record<string, number>>({});
  const [recheckingId, setRecheckingId] = useState<string | null>(null);
  const [graceNow, setGraceNow] = useState(() => Date.now());
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const profilesRef = useRef<AiProfile[]>([]);
  const savedProfilesRef = useRef<AiProfile[]>([]);
  /** Rows added from the catalog here that have not yet become a real
   *  configuration. Emptied as each one is finished — see below. */
  const draftIdsRef = useRef<Set<string>>(new Set());
  const credentialsRef = useRef<Record<string, AiCredential[]>>({});
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const saveRequestedRef = useRef(false);
  const saveNotificationRequestedRef = useRef(false);
  const flushOnUnmountRef = useRef<() => void>(() => {});
  const mountedRef = useRef(false);

  const replaceProfiles = useCallback((next: AiProfile[]) => {
    profilesRef.current = next;
    setProfiles(next);
  }, []);

  const replaceSavedProfiles = useCallback((next: AiProfile[]) => {
    savedProfilesRef.current = next;
    setSavedProfiles(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushOnUnmountRef.current();
    };
  }, []);

  useEffect(() => {
    credentialsRef.current = credentials;
  }, [credentials]);

  // Finishing a draft promotes it to an ordinary model, permanently. Checked on
  // every edit rather than at discard time, so that later emptying the model box
  // of something the reader already set up cannot make it disappear.
  useEffect(() => {
    for (const profile of profiles) {
      if (draftIdsRef.current.has(profile.id) && isProfileConfigComplete(profile)) {
        draftIdsRef.current.delete(profile.id);
      }
    }
  }, [profiles]);

  /**
   * Take back the models that were added and then left blank. Which ones those
   * are is decided in `ai-draft-profiles`; this applies the answer.
   */
  const discardAbandonedDrafts = useCallback((keepId: string | null) => {
    const abandoned = abandonedDraftIds({
      profiles: profilesRef.current,
      drafts: draftIdsRef.current,
      keepId,
      credentialCount: (id) => credentialsRef.current[id]?.length ?? 0,
    });
    if (abandoned.length === 0) return;
    const dropped = new Set(abandoned);
    for (const id of dropped) draftIdsRef.current.delete(id);
    replaceProfiles(profilesRef.current.filter((profile) => !dropped.has(profile.id)));
    replaceSavedProfiles(savedProfilesRef.current.filter((profile) => !dropped.has(profile.id)));
    setCredentials((current) => {
      const next = { ...current };
      for (const id of dropped) delete next[id];
      return next;
    });
    // Silently: the reader is undoing something they never finished starting,
    // and "model deleted" would report it as a loss.
    for (const id of dropped) invoke("ai_delete_profile", { id }).catch(() => {});
  }, [replaceProfiles, replaceSavedProfiles]);

  // Turning to another card, or shutting the one that was open, is the moment
  // an unfinished model stops being worked on.
  useEffect(() => {
    discardAbandonedDrafts(expandedId);
  }, [discardAbandonedDrafts, expandedId]);

  const dirtyIds = useMemo(() => {
    const saved = new Map(savedProfiles.map((profile) => [profile.id, profile]));
    return new Set(profiles.filter((profile) => !sameProfileConfig(profile, saved.get(profile.id))).map((profile) => profile.id));
  }, [profiles, savedProfiles]);

  // The cleared-effort listener is registered once, so it needs the current
  // dirty set rather than the one captured when it subscribed.
  const dirtyIdsRef = useRef(dirtyIds);
  useEffect(() => {
    dirtyIdsRef.current = dirtyIds;
  }, [dirtyIds]);

  const validDirtyIds = useMemo(() => new Set(
    profiles
      .filter((profile) => dirtyIds.has(profile.id) && isProfileConfigComplete(profile))
      .map((profile) => profile.id),
  ), [dirtyIds, profiles]);

  const refreshCredentials = useCallback(async (profileId: string) => {
    const next = await invoke<AiCredential[]>("ai_list_credentials", { profileId });
    setCredentials((current) => ({ ...current, [profileId]: next }));
    return next;
  }, []);

  const refreshOAuthStatus = useCallback(async () => {
    const next = await invoke<OAuthStatus>("openai_oauth_status");
    setOauthStatus(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextProfiles = await invoke<AiProfile[]>("ai_list_profiles");
      const credentialEntries = await Promise.all(
        nextProfiles.map(async (profile) => [
          profile.id,
          await invoke<AiCredential[]>("ai_list_credentials", { profileId: profile.id }),
        ] as const),
      );
      replaceProfiles(nextProfiles);
      replaceSavedProfiles(nextProfiles);
      setCredentials(Object.fromEntries(credentialEntries));
      setExpandedId((current) => current && nextProfiles.some((profile) => profile.id === current) ? current : null);
      try {
        await refreshOAuthStatus();
      } catch {
        // OAuth is optional; profile and API-key configuration remain usable.
      }
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setLoading(false);
    }
  }, [refreshOAuthStatus, replaceProfiles, replaceSavedProfiles]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onDirtyChange?.(dirtyIds.size > 0);
  }, [dirtyIds, onDirtyChange]);

  // A request that hit an unsupported level clears it server-side and may have
  // just learned the real ones, so pull both back in.
  useEffect(() => {
    const unlisten = listen("ai-reasoning-effort-cleared", () => {
      setEffortRevision((value) => value + 1);
      // Refreshing would discard in-progress edits, so leave a dirty form alone;
      // the cleared value lands the next time settings are opened.
      if (dirtyIdsRef.current.size === 0) void load();
    });
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [load]);

  // Effort levels are learned from a rejection, so they only exist for
  // endpoints the user already tried. Load them for the open card, and reload
  // when a request teaches us new ones.
  const openProfile = profiles.find((profile) => profile.id === expandedId);
  const openProfileKey = openProfile
    ? `${openProfile.provider}|${openProfile.base_url ?? ""}|${openProfile.model}`
    : "";
  useEffect(() => {
    if (!openProfile) return;
    let active = true;
    invoke<AiEffortHints>("ai_reasoning_effort_options", {
      provider: openProfile.provider,
      baseUrl: openProfile.base_url?.trim() || null,
      model: openProfile.model,
    })
      .then((hints) => {
        if (active) setEffortHints((current) => ({ ...current, [openProfile.id]: hints }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the endpoint identity, not the profile object
  }, [openProfile?.id, openProfileKey, effortRevision]);

  /** Drops what a rejection taught us about this endpoint, e.g. after the
   *  gateway starts serving a different model behind the same name. */
  const forgetEffortOptions = async (profile: AiProfile) => {
    try {
      await invoke("ai_forget_reasoning_effort_options", {
        provider: profile.provider,
        baseUrl: profile.base_url?.trim() || null,
        model: profile.model,
      });
      setEffortHints((current) => ({ ...current, [profile.id]: NO_EFFORT_HINTS }));
    } catch (error) {
      console.error("Failed to forget reasoning effort options:", error);
    }
  };

  const updateProfile = useCallback((id: string, patch: Partial<AiProfile>) => {
    const nextProfiles = updateOne(profilesRef.current, id, patch);
    replaceProfiles(nextProfiles);
    if (["provider", "auth_mode", "base_url", "model", "temperature", "reasoning_effort", "keep_alive"].some((key) => key in patch)) {
      setStaleHealthIds((current) => new Set(current).add(id));
      setTestResults((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
    if (["provider", "auth_mode", "base_url"].some((key) => key in patch)) {
      setModelOptions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
    setError(null);
  }, [replaceProfiles]);

  const markHealthStale = useCallback((profileId: string) => {
    setStaleHealthIds((current) => new Set(current).add(profileId));
    setTestResults((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
  }, []);

  const persistProfile = useCallback(async (profile: AiProfile): Promise<AiProfile> => {
    const saved = await invoke<AiProfile>("ai_update_profile", {
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      authMode: profile.auth_mode,
      baseUrl: profile.base_url?.trim() || null,
      model: profile.model,
      temperature: profile.temperature,
      reasoningEffort: profile.reasoning_effort?.trim() || null,
      reasoningEffortAllFeatures: profile.reasoning_effort_all_features,
      keepAlive: profile.keep_alive?.trim() || null,
    });
    const nextSavedProfiles = updateOne(savedProfilesRef.current, saved.id, saved);
    savedProfilesRef.current = nextSavedProfiles;
    // A debounced save may resolve after the user has resumed typing. Only
    // replace the draft when it is still the exact revision we persisted.
    if (mountedRef.current) {
      const nextProfiles = profilesRef.current.map((item) => (
        item.id === saved.id && sameProfileConfig(item, profile) ? saved : item
      ));
      replaceProfiles(nextProfiles);
      replaceSavedProfiles(nextSavedProfiles);
    }
    return saved;
  }, [replaceProfiles, replaceSavedProfiles]);

  const saveProfiles = useCallback((notify = true): Promise<void> => {
    saveRequestedRef.current = true;
    saveNotificationRequestedRef.current ||= notify;
    if (saveInFlightRef.current) return saveInFlightRef.current;

    const worker = (async () => {
      let savedAny = false;
      if (mountedRef.current) {
        setSaving(true);
        setError(null);
      }
      try {
        while (saveRequestedRef.current) {
          saveRequestedRef.current = false;
          const savedById = new Map(savedProfilesRef.current.map((profile) => [profile.id, profile]));
          const pending = profilesRef.current.filter((profile) => (
            !sameProfileConfig(profile, savedById.get(profile.id)) && isProfileConfigComplete(profile)
          ));
          for (const profile of pending) {
            await persistProfile(profile);
            savedAny = true;
          }
        }
        if (savedAny && saveNotificationRequestedRef.current && mountedRef.current) {
          showSavedToast(t("settings.ai.savedToast"));
        }
      } catch (nextError) {
        saveRequestedRef.current = false;
        if (mountedRef.current) setError(errorText(nextError));
      } finally {
        saveNotificationRequestedRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    })();

    saveInFlightRef.current = worker;
    void worker.finally(() => {
      saveInFlightRef.current = null;
    });
    return worker;
  }, [persistProfile, showSavedToast, t]);

  useEffect(() => {
    flushOnUnmountRef.current = () => {
      void saveProfiles(false);
      // Nothing open is being worked on any more: closing settings is the last
      // chance to take back a model that was added and never filled in.
      discardAbandonedDrafts(null);
    };
  }, [discardAbandonedDrafts, saveProfiles]);

  const requestSave = useCallback(() => {
    void saveProfiles(true);
  }, [saveProfiles]);

  useEffect(() => {
    onSaveRef?.(requestSave);
    return () => onSaveRef?.(null);
  }, [onSaveRef, requestSave]);

  useEffect(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (loading || saving || validDirtyIds.size === 0) return;
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void saveProfiles(false);
    }, 600);
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [loading, saveProfiles, saving, validDirtyIds]);

  /*
   * ── A configuration that arrived without its credential (D-018) ──
   *
   * Mobile only. On a desktop this pane is unchanged: nothing below runs, and
   * `sync_status` is never called, because the reader who configured the model
   * is sitting at the machine that has the key.
   */
  const missingKeyProfiles = useMemo(() => (
    platform.isMobile
      ? profiles.filter((profile) => (
          wantsMissingKeyNotice(profile, (credentials[profile.id] ?? []).length)
        ))
      : []
  ), [credentials, profiles]);
  // A stable dependency: the array identity changes on every credential
  // refresh, and the effects below care only about which models are affected.
  const missingKeyIds = missingKeyProfiles.map((profile) => profile.id).join("|");

  // The clock starts when this device first noticed, not when the pane mounted,
  // so opening settings twice does not restart the grace window.
  useEffect(() => {
    const ids = missingKeyIds ? missingKeyIds.split("|") : [];
    setFirstSeenMissing((current) => {
      const next: Record<string, number> = {};
      let changed = Object.keys(current).length !== ids.length;
      for (const id of ids) {
        next[id] = current[id] ?? Date.now();
        if (current[id] == null) changed = true;
      }
      return changed ? next : current;
    });
  }, [missingKeyIds]);

  // One read of the peer list, the moment there is something to explain. It is
  // evidence about the *other* channel — a named peer means documents are
  // arriving from that device — so it is only worth fetching when a credential
  // is missing.
  useEffect(() => {
    if (!missingKeyIds) return;
    let active = true;
    invoke<SyncStatusPeers>("sync_status")
      .then((status) => {
        if (active) setPeers(status.peers ?? []);
      })
      .catch(() => {
        // Sync may be off entirely, which simply means no second channel to
        // compare against — the notice falls back to its plainer wording.
      });
    return () => {
      active = false;
    };
  }, [missingKeyIds]);

  // Crosses the grace threshold without a spinner: the copy changes once, on
  // its own, and nothing on screen claims that waiting is progress.
  useEffect(() => {
    if (!missingKeyIds) return;
    const timer = window.setInterval(() => setGraceNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, [missingKeyIds]);

  const recheckCredentials = useCallback(async (profileId: string) => {
    setRecheckingId(profileId);
    try {
      await refreshCredentials(profileId);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setRecheckingId(null);
    }
  }, [refreshCredentials]);

  /**
   * Add one model from the catalog. Nothing is added until the user picks a
   * preset here, so browsing the catalog never counts as authorizing a paid
   * provider — only the model that lands in the route does.
   */
  const createProfile = async (provider: string) => {
    const preset = presetFor(provider);
    if (!preset) return;
    setBusyId("new");
    setError(null);
    setCatalogOpen(false);
    try {
      const created = await invoke<AiProfile>("ai_create_profile", {
        label: t(preset.nameKey),
        provider: preset.provider,
        authMode: "api_key",
        baseUrl: preset.baseUrl,
        model: preset.model,
        temperature: 0.3,
        reasoningEffort: null,
        reasoningEffortAllFeatures: false,
        keepAlive: preset.keepAlive,
        enabled: true,
      });
      if (!isProfileConfigComplete(created)) draftIdsRef.current.add(created.id);
      replaceProfiles([...profilesRef.current, created]);
      replaceSavedProfiles([...savedProfilesRef.current, created]);
      setCredentials((current) => ({ ...current, [created.id]: [] }));
      setExpandedId(created.id);
      showSavedToast(t("settings.ai.serviceCreated"));
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusyId(null);
    }
  };

  const duplicateProfile = async (profile: AiProfile) => {
    setBusyId(profile.id);
    setError(null);
    let duplicateId: string | null = null;
    try {
      const duplicate = await invoke<AiProfile>("ai_duplicate_profile", {
        id: profile.id,
        label: profileLabel(t("settings.ai.copyServiceName", { name: profile.label })),
      });
      duplicateId = duplicate.id;
      const configured = await invoke<AiProfile>("ai_update_profile", {
        id: duplicate.id,
        label: duplicate.label,
        provider: profile.provider,
        authMode: profile.auth_mode,
        baseUrl: profile.base_url?.trim() || null,
        model: profile.model,
        temperature: profile.temperature,
        reasoningEffort: profile.reasoning_effort?.trim() || null,
        reasoningEffortAllFeatures: profile.reasoning_effort_all_features,
        keepAlive: profile.keep_alive?.trim() || null,
      });
      replaceProfiles([...profilesRef.current, configured]);
      replaceSavedProfiles([...savedProfilesRef.current, configured]);
      setCredentials((current) => ({ ...current, [configured.id]: [] }));
      setExpandedId(configured.id);
      showSavedToast(t("settings.ai.serviceDuplicated"));
    } catch (nextError) {
      // `duplicate` and `update` are separate commands. If applying unsaved
      // draft values fails, remove the just-created shell so it cannot reappear
      // as an unexpected extra service after the settings page is reopened.
      if (duplicateId) {
        try {
          await invoke("ai_delete_profile", { id: duplicateId });
        } catch {
          // Preserve the original, actionable update error for the user.
        }
      }
      setError(errorText(nextError));
    } finally {
      setBusyId(null);
    }
  };

  const deleteProfile = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await invoke("ai_delete_profile", { id });
      replaceProfiles(profilesRef.current.filter((profile) => profile.id !== id));
      replaceSavedProfiles(savedProfilesRef.current.filter((profile) => profile.id !== id));
      setCredentials((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setModelOptions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setTestResults((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setStaleHealthIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      setExpandedId((current) => current === id ? null : current);
      showSavedToast(t("settings.ai.serviceDeleted"));
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusyId(null);
    }
  };

  const toggleProfile = async (id: string, enabled: boolean) => {
    const previous = profilesRef.current.find((profile) => profile.id === id)?.enabled ?? !enabled;
    setBusyId(id);
    replaceProfiles(updateOne(profilesRef.current, id, { enabled }));
    replaceSavedProfiles(updateOne(savedProfilesRef.current, id, { enabled }));
    setError(null);
    try {
      await invoke("ai_set_profile_enabled", { id, enabled });
    } catch (nextError) {
      replaceProfiles(updateOne(profilesRef.current, id, { enabled: previous }));
      replaceSavedProfiles(updateOne(savedProfilesRef.current, id, { enabled: previous }));
      setError(errorText(nextError));
    } finally {
      setBusyId(null);
    }
  };

  const applyProfileOrder = useCallback(async (next: AiProfile[]) => {
    const previousProfiles = profilesRef.current;
    const previousSaved = savedProfilesRef.current;
    const withPriority = next.map((profile, priority) => ({ ...profile, priority }));
    const nextSaved = withPriority.map((profile) => {
      const saved = previousSaved.find((item) => item.id === profile.id);
      return saved ? { ...saved, priority: profile.priority } : profile;
    });
    replaceProfiles(withPriority);
    replaceSavedProfiles(nextSaved);
    setBusyId("order");
    setError(null);
    try {
      await invoke("ai_reorder_profiles", { ids: withPriority.map((profile) => profile.id) });
    } catch (nextError) {
      replaceProfiles(previousProfiles);
      replaceSavedProfiles(previousSaved);
      setError(errorText(nextError));
    } finally {
      setBusyId(null);
    }
  }, [replaceProfiles, replaceSavedProfiles]);

  const moveProfile = async (id: string, direction: -1 | 1) => {
    const index = profiles.findIndex((profile) => profile.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= profiles.length) return;
    const next = [...profiles];
    [next[index], next[target]] = [next[target], next[index]];
    await applyProfileOrder(next);
  };

  const [introduceAuto, setIntroduceAuto] = useState(false);

  const dismissAutoIntro = useCallback(() => {
    setIntroduceAuto(false);
    void saveSetting(AUTO_ANALYSIS_INTRO_KEY, "true");
  }, [saveSetting]);

  const testProfile = async (profile: AiProfile) => {
    setTestingId(profile.id);
    setError(null);
    try {
      const latestProfile = profilesRef.current.find((item) => item.id === profile.id) ?? profile;
      const savedProfile = savedProfilesRef.current.find((item) => item.id === profile.id);
      if (!sameProfileConfig(latestProfile, savedProfile) && isProfileConfigComplete(latestProfile)) {
        await saveProfiles(false);
      }
      const testedProfile = profilesRef.current.find((item) => item.id === profile.id) ?? latestProfile;
      const result = await invoke<AiConnectionTestResult>("ai_test_profile", {
        id: testedProfile.id,
        provider: testedProfile.provider,
        authMode: testedProfile.auth_mode,
        baseUrl: testedProfile.base_url?.trim() || null,
        model: testedProfile.model,
        temperature: testedProfile.temperature,
        reasoningEffort: testedProfile.reasoning_effort?.trim() || null,
        keepAlive: testedProfile.keep_alive?.trim() || null,
      });
      setTestResults((current) => ({ ...current, [profile.id]: result }));
      setStaleHealthIds((current) => {
        const next = new Set(current);
        next.delete(profile.id);
        return next;
      });
      try {
        const [nextProfiles] = await Promise.all([
          invoke<AiProfile[]>("ai_list_profiles"),
          refreshCredentials(testedProfile.id),
        ]);
        const persisted = nextProfiles.find((item) => item.id === testedProfile.id);
        if (persisted) {
          const health = {
            state: persisted.state,
            cooldown_until: persisted.cooldown_until,
            last_error_kind: persisted.last_error_kind,
            last_used_at: persisted.last_used_at,
            last_latency_ms: persisted.last_latency_ms,
          };
          // Preserve unsaved form fields while refreshing only authoritative
          // health metadata written by a test of the saved configuration.
          replaceProfiles(updateOne(profilesRef.current, testedProfile.id, health));
          replaceSavedProfiles(updateOne(savedProfilesRef.current, testedProfile.id, health));
        }
      } catch (refreshError) {
        setError(errorText(refreshError));
      }
      showSavedToast(result.success ? t("settings.ai.connectionAvailable") : t("settings.ai.connectionUnavailable"));
      // A working service is the first moment there is anything to disclose,
      // and it is the moment the reader is looking at this pane. Said here,
      // in place, rather than saved up for a dialog later.
      if (result.success && shouldIntroduceAutoAnalysis(settings)) setIntroduceAuto(true);
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setTestingId(null);
    }
  };

  const fetchModels = async (profile: AiProfile) => {
    setModelsLoadingId(profile.id);
    setError(null);
    try {
      const models = await invoke<string[]>("ai_list_models", {
        profileId: profile.id,
        provider: profile.provider,
        authMode: profile.auth_mode,
        baseUrl: profile.base_url?.trim() || null,
      });
      setModelOptions((current) => ({ ...current, [profile.id]: models }));
      showSavedToast(t("settings.ai.modelsLoaded", { count: models.length }));
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setModelsLoadingId(null);
    }
  };

  const addCredential = async (profileId: string, label: string, value: string) => {
    setError(null);
    try {
      await invoke("ai_add_credential", { profileId, label, value });
      await refreshCredentials(profileId);
      markHealthStale(profileId);
      showSavedToast(t("settings.ai.keyAdded"));
    } catch (nextError) {
      setError(errorText(nextError));
      throw nextError;
    }
  };

  const replaceCredential = async (profileId: string, id: string, value: string) => {
    setError(null);
    try {
      await invoke("ai_replace_credential", { id, value });
      await refreshCredentials(profileId);
      markHealthStale(profileId);
      showSavedToast(t("settings.ai.keyReplaced"));
    } catch (nextError) {
      setError(errorText(nextError));
      throw nextError;
    }
  };

  const toggleCredential = async (profileId: string, id: string, enabled: boolean) => {
    setError(null);
    try {
      await invoke("ai_set_credential_enabled", { id, enabled });
      await refreshCredentials(profileId);
      markHealthStale(profileId);
    } catch (nextError) {
      setError(errorText(nextError));
      throw nextError;
    }
  };

  const deleteCredential = async (profileId: string, id: string) => {
    setError(null);
    try {
      await invoke("ai_delete_credential", { id });
      await refreshCredentials(profileId);
      markHealthStale(profileId);
    } catch (nextError) {
      setError(errorText(nextError));
      throw nextError;
    }
  };

  const reorderCredentials = async (profileId: string, ids: string[]) => {
    setError(null);
    try {
      await invoke("ai_reorder_credentials", { ids });
      await refreshCredentials(profileId);
      markHealthStale(profileId);
    } catch (nextError) {
      setError(errorText(nextError));
      throw nextError;
    }
  };

  const loginWithOpenAi = async (profile: AiProfile) => {
    setOauthLoading(true);
    setError(null);
    try {
      const oauthProfile = { ...profile, auth_mode: "oauth" as const, base_url: null };
      const status = await invoke<OAuthStatus>("openai_oauth_login");
      setOauthStatus(status);
      replaceProfiles(updateOne(profilesRef.current, oauthProfile.id, oauthProfile));
      await saveProfiles(false);
      markHealthStale(profile.id);
      showSavedToast(t("settings.ai.oauthSuccess"));
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setOauthLoading(false);
    }
  };

  const logoutFromOpenAi = async () => {
    setOauthLoading(true);
    setError(null);
    try {
      await invoke("openai_oauth_logout");
      setOauthStatus({ connected: false, account_id: null });
      const affectedIds = profilesRef.current
        .filter((profile) => profile.provider === "openai" && profile.auth_mode === "oauth")
        .map((profile) => profile.id);
      setStaleHealthIds((current) => {
        const next = new Set(current);
        for (const id of affectedIds) next.add(id);
        return next;
      });
      setTestResults((current) => {
        const next = { ...current };
        for (const id of affectedIds) delete next[id];
        return next;
      });
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setOauthLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[13px] text-text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t("settings.ai.loadingServices")}
      </div>
    );
  }

  return (
    <div className="pb-6 pt-2">
      {introduceAuto ? (
        <div className="mb-5 rounded-[10px] border border-accent-bg bg-accent-bg px-4 py-4">
          <AutoAnalysisIntro onDone={dismissAutoIntro} />
        </div>
      ) : null}
      <div className="mb-3">
        <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.chatModels")}</h4>
        <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.chatModelsHint")}</p>
      </div>
      <div className="mb-4 flex min-h-[73px] items-center justify-between gap-4 border-y border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.grounding")}</h4>
          <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.groundingHint")}</p>
        </div>
        <Toggle
          checked={settings.ai_grounding_enabled !== "false"}
          onChange={(enabled) => void saveSetting("ai_grounding_enabled", enabled ? "true" : "false")}
          label={t("settings.ai.grounding")}
        />
      </div>
      <div className="mb-4 flex min-h-[73px] items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.spoilerGuard")}</h4>
          <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.spoilerGuardHint")}</p>
        </div>
        <Toggle
          checked={settings.ai_spoiler_guard !== "false"}
          onChange={(enabled) => void saveSetting("ai_spoiler_guard", enabled ? "true" : "false")}
          label={t("settings.ai.spoilerGuard")}
        />
      </div>
      <div className="mb-4 border-b border-border py-3">
        <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.summaryProfile")}</h4>
        <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.summaryProfileHint")}</p>
        <Select
          className="mt-2"
          value={settings.ai_summary_profile_id || ""}
          onChange={(value) => void saveSetting("ai_summary_profile_id", value)}
          options={[
            { value: "", label: t("settings.ai.summaryProfileFollow") },
            ...profiles.filter((profile) => profile.enabled).map((profile) => ({ value: profile.id, label: profile.label })),
          ]}
        />
      </div>
      <div className="mb-4 flex min-h-[73px] items-center justify-between gap-4 border-b border-border py-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.summariesAuto")}</h4>
          <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.summariesAutoHint")}</p>
        </div>
        <Toggle
          checked={settings.ai_summaries_auto !== "false"}
          onChange={(enabled) => void saveSetting("ai_summaries_auto", enabled ? "true" : "false")}
          label={t("settings.ai.summariesAuto")}
        />
      </div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium text-text-primary">{t("settings.ai.services")}</h4>
          <p className="mt-0.5 text-[11px] leading-[1.55] text-text-muted">{t("settings.ai.servicesHint")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setCatalogOpen((open) => !open)}
          disabled={busyId != null || saving}
          aria-expanded={catalogOpen}
        >
          {busyId === "new" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          {t("settings.ai.addModel")}
        </Button>
      </div>

      {catalogOpen && (
        <div className="mb-3 rounded-lg border border-border p-1">
          <p className="px-2 pb-1 pt-1.5 text-[10px] leading-4 text-text-muted">{t("settings.ai.catalogHint")}</p>
          <ul>
            {CATALOG.map((preset) => (
              <li key={preset.provider}>
                <button
                  type="button"
                  disabled={busyId != null || saving}
                  onClick={() => void createProfile(preset.provider)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-bg-input disabled:opacity-50 touch:min-h-[60px] touch:items-center touch:px-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium text-text-primary touch:text-[14px]">{t(preset.nameKey)}</span>
                      {preset.cost && (
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${COST_TIER_CLASSES[preset.cost]}`}>
                          {t(`settings.ai.cost.${preset.cost}`)}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-text-muted touch:text-[11.5px] touch:leading-[1.5]">
                      {t(preset.descriptionKey)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-border-light px-2 pb-1.5 pt-2 text-[10px] leading-4 text-text-muted">
            {t("settings.ai.smallModelWarning")}
          </p>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md bg-danger-bg px-3 py-2 text-[11px] leading-5 text-danger-text">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {profiles.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center rounded-lg border border-dashed border-border px-4 text-center">
          <p className="text-[13px] font-medium text-text-primary">{t("settings.ai.noServices")}</p>
          <p className="mt-1 text-[11px] text-text-muted">{t("settings.ai.noServicesHint")}</p>
        </div>
      ) : (
        <SortableList
          items={profiles}
          getId={(profile) => profile.id}
          onReorder={applyProfileOrder}
          disabled={(profile) => expandedId === profile.id || saving || busyId != null}
          className="space-y-2"
          renderItem={(profile, index) => (
            <AiServiceCard
              profile={profile}
              credentials={credentials[profile.id] ?? []}
              expanded={expandedId === profile.id}
              dirty={dirtyIds.has(profile.id)}
              busy={saving || oauthLoading || busyId != null || testingId === profile.id || modelsLoadingId === profile.id}
              testing={testingId === profile.id}
              loadingModels={modelsLoadingId === profile.id}
              modelOptions={modelOptions[profile.id] ?? []}
              learnedEfforts={effortHints[profile.id] ?? NO_EFFORT_HINTS}
              testResult={testResults[profile.id]}
              healthStale={staleHealthIds.has(profile.id)}
              oauthStatus={oauthStatus}
              oauthLoading={oauthLoading}
              onToggleExpanded={() => setExpandedId((current) => current === profile.id ? null : profile.id)}
              onChange={(patch) => updateProfile(profile.id, patch)}
              onToggleEnabled={(enabled) => toggleProfile(profile.id, enabled)}
              onTest={() => testProfile(profile)}
              onFetchModels={() => fetchModels(profile)}
              onForgetEffortOptions={() => forgetEffortOptions(profile)}
              onDuplicate={() => duplicateProfile(profile)}
              onDelete={() => deleteProfile(profile.id)}
              onMove={(direction) => moveProfile(profile.id, direction)}
              canMoveUp={index > 0}
              canMoveDown={index < profiles.length - 1}
              onAddCredential={(label, value) => addCredential(profile.id, label, value)}
              onReplaceCredential={(id, value) => replaceCredential(profile.id, id, value)}
              onToggleCredential={(id, enabled) => toggleCredential(profile.id, id, enabled)}
              onDeleteCredential={(id) => deleteCredential(profile.id, id)}
              onReorderCredentials={(ids) => reorderCredentials(profile.id, ids)}
              onOAuthLogin={() => loginWithOpenAi(profile)}
              onOAuthLogout={logoutFromOpenAi}
            />
          )}
        />
      )}

      {/* Below the list rather than inside a card: the card says the model is
          not connected, and this says why the key it was configured with is not
          here. An expanded card already shows the key field, so the notice
          stands down while the reader is looking at it. */}
      {missingKeyProfiles
        .filter((profile) => profile.id !== expandedId)
        .map((profile) => (
          <MissingKeyNotice
            key={profile.id}
            name={profile.label}
            state={missingKeyState({
              missing: true,
              // The one platform pair where both channels exist, so the one
              // place where comparing them means anything (D-007, D-018).
              pairedSync: platform.hasFolderSync,
              peers,
              observedSince: firstSeenMissing[profile.id] ?? graceNow,
              now: graceNow,
            })}
            rechecking={recheckingId === profile.id}
            onEnterKey={() => setExpandedId(profile.id)}
            onRecheck={() => void recheckCredentials(profile.id)}
          />
        ))}

      <AiRequestCountsSection />
    </div>
  );
}
